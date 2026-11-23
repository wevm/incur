//! Fetch handlers: HTTP request handlers that back fetch commands, OpenAPI commands, and MCP
//! sources, and the client every outgoing request goes through.

use std::fmt;
use std::sync::Arc;

use bytes::Bytes;
use futures_core::Stream;
use http::header::{CONTENT_TYPE, HeaderName, HeaderValue};
use serde_json::Value;

use crate::body::Body;
use crate::cli::{Entry, Gateway, Group};
use crate::command::BoxFuture;
use crate::command::OutputPolicy;
use crate::errors::Error;
use crate::js;
use crate::openapi::{Generator, Openapi, Spec};
use crate::url::Url;

/// A type-erased fetch handler.
pub(crate) type Handler = Arc<
    dyn Fn(http::Request<Body>) -> BoxFuture<Result<http::Response<Body>, Error>> + Send + Sync,
>;

/// Erases a fetch handler.
pub(crate) fn handler<F, R>(f: F) -> Handler
where
    F: Fn(http::Request<Body>) -> R + Send + Sync + 'static,
    R: Future<Output = Result<http::Response<Body>, Error>> + Send + 'static,
{
    Arc::new(move |request| Box::pin(f(request)))
}

/// Where a fetch command sends its requests: a handler, or a hosted base URL.
///
/// ```
/// use incur::{Body, Fetch};
///
/// // An in-process handler, such as another router.
/// let local = Fetch::new(|request: http::Request<Body>| async move {
///     Ok(http::Response::new(Body::from(format!("{} {}", request.method(), request.uri()))))
/// });
///
/// // A hosted API: requests go through the CLI's HTTP client.
/// let hosted = Fetch::url("https://api.example.com/v1/").header("authorization", "Bearer token");
/// ```
#[derive(Clone)]
pub struct Fetch(pub(crate) Source);

/// The representation of a [`Fetch`].
#[derive(Clone)]
pub(crate) enum Source {
    /// An in-process handler.
    Handler(Handler),
    /// A hosted base URL with default headers.
    Url {
        /// The base URL, or the invalid input.
        url: Result<Url, String>,
        /// Headers merged into every request. Request headers win.
        headers: Vec<(String, String)>,
    },
}

impl Fetch {
    /// Creates a source from a handler: an async function from a request to a response.
    pub fn new<F, R>(f: F) -> Self
    where
        F: Fn(http::Request<Body>) -> R + Send + Sync + 'static,
        R: Future<Output = Result<http::Response<Body>, Error>> + Send + 'static,
    {
        Self(Source::Handler(handler(f)))
    }

    /// Creates a hosted source from a base URL. Request paths are appended to the base path, and
    /// requests go through the CLI's HTTP client (see [`Cli::client`](crate::Cli::client)).
    /// Relative OpenAPI documents resolve against the URL.
    pub fn url(url: &str) -> Self {
        Self(Source::Url {
            url: Url::parse(url).ok_or_else(|| url.to_owned()),
            headers: Vec::new(),
        })
    }

    /// Adds a header to every request of a hosted source. Request headers take precedence.
    /// Handler sources ignore it.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        if let Source::Url { headers, .. } = &mut self.0 {
            headers.push((name.into(), value.into()));
        }
        self
    }

    /// Returns the base URL of a hosted source.
    pub(crate) fn base(&self) -> Option<&Url> {
        match &self.0 {
            Source::Url { url: Ok(url), .. } => Some(url),
            _ => None,
        }
    }

    /// Sends a request.
    pub(crate) async fn send(
        &self,
        request: http::Request<Body>,
        client: &Handler,
    ) -> Result<http::Response<Body>, Error> {
        match &self.0 {
            Source::Handler(handler) => handler(request).await,
            Source::Url { url, headers } => {
                let base = url
                    .as_ref()
                    .map_err(|input| Error::unknown(format!("Invalid URL: {input}")))?;
                let incoming = request_url(&request);
                let mut target = base.clone();
                let prefix = base.path.strip_suffix('/').unwrap_or(&base.path);
                let suffix = &incoming.path;
                target.path = format!("{prefix}{suffix}");
                target.query = incoming.query;
                let (mut parts, body) = request.into_parts();
                let mut merged = http::HeaderMap::new();
                for (name, value) in headers {
                    if let (Ok(name), Ok(value)) = (
                        HeaderName::try_from(name.as_str()),
                        HeaderValue::try_from(value.as_str()),
                    ) {
                        merged.insert(name, value);
                    }
                }
                for (name, value) in &parts.headers {
                    merged.insert(name, value.clone());
                }
                parts.headers = merged;
                parts.uri = uri(&target)?;
                client(http::Request::from_parts(parts, body)).await
            }
        }
    }
}

impl fmt::Debug for Fetch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Source::Handler(_) => f.write_str("Fetch(Handler)"),
            Source::Url { url, .. } => match url {
                Ok(url) => f.debug_tuple("Fetch").field(&url.to_string()).finish(),
                Err(input) => f.debug_tuple("Fetch").field(input).finish(),
            },
        }
    }
}

/// Converts a URL to a URI.
pub(crate) fn uri(url: &Url) -> Result<http::Uri, Error> {
    http::Uri::try_from(url.to_string()).map_err(|_| Error::unknown(format!("Invalid URL: {url}")))
}

/// Returns the URL of a request, resolving a relative URI against `http://localhost`.
pub(crate) fn request_url(request: &http::Request<Body>) -> Url {
    parts_url(request.uri())
}

/// Returns the URL of a URI, resolving a relative one against `http://localhost`.
pub(crate) fn parts_url(uri: &http::Uri) -> Url {
    let text = uri.to_string();
    Url::parse(&text)
        .or_else(|| Url::parse("http://localhost").and_then(|base| base.join(&text)))
        .unwrap_or(Url {
            scheme: "http".into(),
            host: "localhost".into(),
            path: "/".into(),
            query: None,
        })
}

/// The default client without the `client` feature: every request fails.
#[cfg(not(feature = "client"))]
pub(crate) fn default_client() -> Handler {
    handler(|request: http::Request<Body>| async move {
        let _ = request;
        Err(Error::unknown(
            "fetch failed: no HTTP client is configured (enable the `client` feature of incur, or set `Cli::client`)",
        ))
    })
}

/// The default client with the `client` feature: `ureq` on a thread per request, so it runs on
/// any executor. HTTP error statuses are responses, as with `fetch`.
#[cfg(feature = "client")]
pub(crate) fn default_client() -> Handler {
    handler(|request: http::Request<Body>| async move {
        let (parts, body) = request.into_parts();
        let request = http::Request::from_parts(parts, body.bytes().await.to_vec());
        let (sender, receiver) = futures_channel::oneshot::channel();
        std::thread::spawn(move || {
            let _ = sender.send(send(request));
        });
        receiver
            .await
            .unwrap_or_else(|_| Err(Error::unknown("fetch failed")))
    })
}

/// Sends a request with `ureq` and reads the whole response.
#[cfg(feature = "client")]
fn send(request: http::Request<Vec<u8>>) -> Result<http::Response<Body>, Error> {
    // `fetch` reports every transport failure with this message.
    let failed = |_: ureq::Error| Error::unknown("fetch failed");
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build(),
    );
    let (parts, mut body) = agent.run(request).map_err(failed)?.into_parts();
    let bytes = body
        .with_config()
        .limit(u64::MAX)
        .read_to_vec()
        .map_err(failed)?;
    Ok(http::Response::from_parts(parts, Body::from(bytes)))
}

/// A request parsed from curl-style arguments.
#[derive(Debug, Default)]
pub(crate) struct Input {
    /// The request body.
    pub(crate) body: Option<String>,
    /// Request headers, by lowercase name.
    pub(crate) headers: Vec<(String, String)>,
    /// The HTTP method.
    pub(crate) method: String,
    /// The request path.
    pub(crate) path: String,
    /// Query parameters.
    pub(crate) query: Vec<(String, String)>,
}

/// Sets a pair as `URLSearchParams.set` and `Headers.set` do: replaces the first entry with the
/// key and removes the others, or appends.
pub(crate) fn set(pairs: &mut Vec<(String, String)>, key: &str, value: &str) {
    match pairs.iter().position(|(k, _)| k == key) {
        Some(index) => {
            value.clone_into(&mut pairs[index].1);
            let mut seen = 0;
            pairs.retain(|(k, _)| {
                if k != key {
                    return true;
                }
                seen += 1;
                seen == 1
            });
        }
        None => pairs.push((key.to_owned(), value.to_owned())),
    }
}

/// Parses curl-style arguments: path segments, `--key value` query parameters, `-X`/`--method`,
/// `-d`/`--data`/`--body`, and `-H`/`--header`.
pub(crate) fn parse_argv(argv: &[String]) -> Result<Input, Error> {
    let mut input = Input::default();
    let mut segments = Vec::new();
    let mut method = None;
    let mut reserved = |input: &mut Input, key: &str, value: &str| match key {
        "method" => method = Some(js_upper(value)),
        "body" | "data" => input.body = Some(value.to_owned()),
        _ => {
            if let Some((name, value)) = value.split_once(':') {
                let name = name.trim_matches(js::is_whitespace).to_ascii_lowercase();
                if HeaderName::try_from(name.as_str()).is_ok() {
                    set(
                        &mut input.headers,
                        &name,
                        value.trim_matches(js::is_whitespace),
                    );
                }
            }
        }
    };
    let is_reserved = |key: &str| matches!(key, "method" | "body" | "data" | "header");
    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        if let Some(flag) = token.strip_prefix("--") {
            if let Some((key, value)) = flag.split_once('=') {
                if is_reserved(key) {
                    reserved(&mut input, key, value);
                } else {
                    set(&mut input.query, key, value);
                }
                i += 1;
            } else {
                let value = argv
                    .get(i + 1)
                    .ok_or_else(|| Error::unknown(format!("Missing value for --{flag}")))?;
                if is_reserved(flag) {
                    reserved(&mut input, flag, value);
                } else {
                    set(&mut input.query, flag, value);
                }
                i += 2;
            }
        } else if token.starts_with('-') && token.chars().count() == 2 {
            let short = &token[1..];
            let mapped = match short {
                "X" => Some("method"),
                "d" => Some("data"),
                "H" => Some("header"),
                _ => None,
            };
            if let Some(key) = mapped {
                let value = argv
                    .get(i + 1)
                    .ok_or_else(|| Error::unknown(format!("Missing value for -{short}")))?;
                reserved(&mut input, key, value);
                i += 2;
            } else {
                // An unknown short flag is skipped without consuming a value.
                i += 1;
            }
        } else {
            segments.push(token.as_str());
            i += 1;
        }
    }
    let mut path = format!("/{}", segments.join("/"));
    while path.contains("//") {
        path = path.replace("//", "/");
    }
    input.path = path;
    input.method =
        method.unwrap_or_else(|| if input.body.is_some() { "POST" } else { "GET" }.to_owned());
    Ok(input)
}

/// Uppercases ASCII letters, as `toUpperCase` does for method names.
fn js_upper(value: &str) -> String {
    value.to_uppercase()
}

/// Builds a request for `http://localhost` from parsed input. A body without a content type is
/// sent as JSON.
pub(crate) fn build_request(input: Input) -> Result<http::Request<Body>, Error> {
    let base = Url::parse("http://localhost").ok_or_else(|| Error::unknown("Invalid URL"))?;
    let mut url = base
        .join(&input.path)
        .ok_or_else(|| Error::unknown(format!("Invalid URL: {}", input.path)))?;
    let mut query = url.query_pairs();
    for (key, value) in &input.query {
        set(&mut query, key, value);
    }
    url.set_query(&query);
    let mut headers = input.headers;
    if input.body.is_some() && !headers.iter().any(|(name, _)| name == "content-type") {
        headers.push(("content-type".into(), "application/json".into()));
    }
    request(&input.method, &url, &headers, input.body.map(Body::from))
}

/// Builds a request.
pub(crate) fn request(
    method: &str,
    url: &Url,
    headers: &[(String, String)],
    body: Option<Body>,
) -> Result<http::Request<Body>, Error> {
    let mut builder = http::Request::builder().method(method).uri(uri(url)?);
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder
        .body(body.unwrap_or_default())
        .map_err(|error| Error::unknown(error.to_string()))
}

/// Whether a response streams NDJSON.
pub(crate) fn is_streaming(response: &http::Response<Body>) -> bool {
    response
        .headers()
        .get(CONTENT_TYPE)
        .is_some_and(|value| value.as_bytes() == b"application/x-ndjson")
}

/// Parses text as JSON when it is valid JSON, and returns the text otherwise.
pub(crate) fn json_or_text(text: &str) -> Value {
    js::json_parse(text, |_| Value::Null).unwrap_or_else(|_| Value::String(text.to_owned()))
}

/// Parses each non-empty line of an NDJSON body as JSON, or keeps it as text.
pub(crate) fn ndjson(body: Body) -> impl Stream<Item = Result<Value, Error>> + Send {
    struct State {
        body: Body,
        buffer: Vec<u8>,
        done: bool,
    }
    futures_util::stream::unfold(
        State {
            body,
            buffer: Vec::new(),
            done: false,
        },
        |mut state| async move {
            loop {
                if let Some(index) = state.buffer.iter().position(|b| *b == b'\n') {
                    let line = state.buffer.drain(..=index).collect::<Vec<_>>();
                    let text = String::from_utf8_lossy(&line);
                    let text = text.trim_matches(js::is_whitespace);
                    if text.is_empty() {
                        continue;
                    }
                    return Some((Ok(json_or_text(text)), state));
                }
                if state.done {
                    let rest = std::mem::take(&mut state.buffer);
                    let text = String::from_utf8_lossy(&rest);
                    let text = text.trim_matches(js::is_whitespace);
                    if text.is_empty() {
                        return None;
                    }
                    return Some((Ok(json_or_text(text)), state));
                }
                match next_chunk(&mut state.body).await {
                    Some(chunk) => state.buffer.extend_from_slice(&chunk),
                    None => state.done = true,
                }
            }
        },
    )
}

/// Reads the next data chunk of a body.
async fn next_chunk(body: &mut Body) -> Option<Bytes> {
    use http_body::Body as _;
    // A `Body` yields only data frames and never fails.
    let Ok(frame) =
        std::future::poll_fn(|cx| std::pin::Pin::new(&mut *body).poll_frame(cx)).await?;
    frame.into_data().ok()
}

/// Extracts an error code and message from a failed response's data: a top-level `message`, a
/// nested `{ error: { code, message } }` envelope, a text body, or the HTTP status.
pub(crate) fn parse_error(data: &Value, status: u16) -> Error {
    let error = data.get("error").filter(|e| e.is_object());
    let code = error
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .filter(|code| !code.is_empty())
        .map_or_else(|| format!("HTTP_{status}"), str::to_owned);
    let message = if let Some(message) = data.as_object().and_then(|d| d.get("message")) {
        js::to_string(message)
    } else if let Some(message) = error.and_then(|e| e.get("message")) {
        js::to_string(message)
    } else if let Value::String(text) = data {
        text.clone()
    } else {
        format!("HTTP {status}")
    };
    Error::new(code, message)
}

/// Help text for a fetch command.
pub(crate) fn help(name: &str, description: Option<&str>) -> String {
    let title = match description.filter(|d| !d.is_empty()) {
        Some(description) => format!("{name} \u{2014} {description}"),
        None => name.to_owned(),
    };
    [
        title.as_str(),
        "",
        &format!("Usage: {name} <path> [options]"),
        "",
        "Path segments are joined into the request URL path.",
        "",
        "Options:",
        "  -X, --method <METHOD>     HTTP method (default: GET, POST if body present)",
        "  -H, --header \"Key: Val\"   Set a request header (repeatable)",
        "  -d, --data <json>          Request body (implies POST)",
        "      --body <json>          Request body (implies POST)",
        "  --<key> <value>            Query string parameter",
    ]
    .join("\n")
}

/// A fetch command: curl-style arguments become a request to a [`Fetch`] source. With an
/// OpenAPI document, each operation becomes a typed command instead.
///
/// ```
/// use incur::{Cli, Fetch, FetchCommand, OutputPolicy};
///
/// let cli = Cli::new("tool")
///     .fetch_command(
///         "api",
///         FetchCommand::new(Fetch::url("https://api.example.com")).description("The API"),
///     )
///     .fetch_command(
///         "pets",
///         FetchCommand::new(Fetch::url("https://pets.example.com"))
///             .openapi("openapi.json")
///             .output_policy(OutputPolicy::AgentOnly),
///     );
/// ```
#[derive(Clone)]
pub struct FetchCommand {
    /// Prefix for request paths.
    pub(crate) base_path: Option<String>,
    /// Description.
    pub(crate) description: Option<String>,
    /// The source.
    pub(crate) fetch: Fetch,
    /// Whether MCP clients see generated commands.
    pub(crate) mcp: bool,
    /// The OpenAPI document.
    pub(crate) openapi: Option<Spec>,
    /// OpenAPI generation settings.
    pub(crate) config: Openapi,
    /// Output policy.
    pub(crate) output_policy: Option<OutputPolicy>,
}

impl FetchCommand {
    /// Creates a fetch command for a source.
    pub fn new(fetch: Fetch) -> Self {
        Self {
            base_path: None,
            description: None,
            fetch,
            mcp: true,
            openapi: None,
            config: Openapi::default(),
            output_policy: None,
        }
    }

    /// Sets a prefix for every request path.
    #[must_use]
    pub fn base_path(mut self, path: impl Into<String>) -> Self {
        self.base_path = Some(path.into());
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Hides commands generated from an OpenAPI document from MCP clients.
    #[must_use]
    pub fn mcp(mut self, enabled: bool) -> Self {
        self.mcp = enabled;
        self
    }

    /// Generates a command per operation of an OpenAPI document: a parsed document, or a URL
    /// fetched through the CLI's client, relative to a hosted source's URL.
    #[must_use]
    pub fn openapi(mut self, spec: impl Into<Spec>) -> Self {
        self.openapi = Some(spec.into());
        self
    }

    /// Configures how commands are generated from the OpenAPI document.
    #[must_use]
    pub fn openapi_config(mut self, config: Openapi) -> Self {
        self.config = config;
        self
    }

    /// Sets the output policy.
    #[must_use]
    pub fn output_policy(mut self, policy: OutputPolicy) -> Self {
        self.output_policy = Some(policy);
        self
    }

    /// Converts the command into a tree entry.
    pub(crate) fn into_entry(self) -> Entry {
        let Self {
            base_path,
            description,
            fetch,
            mcp,
            openapi,
            config,
            output_policy,
        } = self;
        match openapi {
            Some(spec) => Entry::Group(Group {
                description,
                generated: Some(Arc::new(Generator::new(spec, config, fetch, base_path))),
                mcp,
                output_policy,
                ..Group::default()
            }),
            None => Entry::Fetch(Gateway {
                base_path,
                description,
                fetch,
                output_policy,
            }),
        }
    }
}
