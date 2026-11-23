//! MCP sources: a remote MCP server mounted as a command group, one command per tool.

use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::body::Body;
use crate::cli::{Entry, Generate, Group};
use crate::command::{self, Command, Outcome, OutputPolicy};
use crate::convert::Zod;
use crate::errors::Error;
use crate::fetch::{self, Handler};
use crate::mcp::{Annotations, Tool};
use crate::schema::{Field, Type};
use crate::url::Url;

/// The protocol version requests declare.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// A remote MCP server whose tools become commands, reached over streamable HTTP.
///
/// The server is contacted when an invocation first reaches the group. Requests go through
/// the source's own handler, or the CLI's HTTP client.
///
/// ```
/// use incur::{Body, Cli, McpSource};
///
/// let cli = Cli::new("tool").mcp_source(
///     "docs",
///     McpSource::new("https://mcp.example.com/mcp")
///         .header("authorization", "Bearer token")
///         .description("Documentation search"),
/// );
/// ```
#[derive(Clone)]
pub struct McpSource {
    /// The server URL.
    url: String,
    /// The handler requests go through instead of the CLI's client.
    fetch: Option<Handler>,
    /// Headers sent with every request.
    headers: Vec<(String, String)>,
    /// Description.
    description: Option<String>,
    /// Output policy.
    output_policy: Option<OutputPolicy>,
}

impl McpSource {
    /// Creates a source for a server URL.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            fetch: None,
            headers: Vec::new(),
            description: None,
            output_policy: None,
        }
    }

    /// Sends requests through a handler instead of the CLI's HTTP client, such as another
    /// CLI's [`Cli::fetch`](crate::Cli::fetch).
    #[must_use]
    pub fn fetch<F, R>(mut self, f: F) -> Self
    where
        F: Fn(http::Request<Body>) -> R + Send + Sync + 'static,
        R: Future<Output = Result<http::Response<Body>, Error>> + Send + 'static,
    {
        self.fetch = Some(fetch::handler(f));
        self
    }

    /// Adds a header to every request.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers
            .push((name.into().to_lowercase(), value.into()));
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets the output policy.
    #[must_use]
    pub fn output_policy(mut self, policy: OutputPolicy) -> Self {
        self.output_policy = Some(policy);
        self
    }

    /// Converts the source into a lazily generated group.
    pub(crate) fn into_entry(self) -> Entry {
        Entry::Group(Group {
            description: self.description.clone(),
            output_policy: self.output_policy,
            generated: Some(Arc::new(Generator {
                source: self,
                cache: futures_util::lock::Mutex::new(None),
            })),
            ..Group::default()
        })
    }
}

/// Resolves a source's tools once.
struct Generator {
    /// The source.
    source: McpSource,
    /// The generated commands.
    cache: futures_util::lock::Mutex<Option<IndexMap<String, Entry>>>,
}

impl Generate for Generator {
    fn lazy(&self) -> bool {
        true
    }

    fn generate<'a>(
        &'a self,
        client: &'a Handler,
    ) -> futures_util::future::BoxFuture<'a, Result<IndexMap<String, Entry>, Error>> {
        Box::pin(async move {
            let mut cache = self.cache.lock().await;
            if let Some(commands) = &*cache {
                return Ok(commands.clone());
            }
            let session = Arc::new(Session {
                fetch: self.source.fetch.clone().unwrap_or_else(|| client.clone()),
                headers: self.source.headers.clone(),
                state: futures_util::lock::Mutex::new(State::default()),
                url: self.source.url.clone(),
            });
            let commands = resolve(session).await?;
            *cache = Some(commands.clone());
            Ok(commands)
        })
    }
}

/// The connection state of a session.
#[derive(Default)]
struct State {
    /// The session id the server assigned.
    id: Option<String>,
    /// Whether initialization finished.
    initialized: bool,
    /// The next request id.
    next: u64,
}

/// A connection to a remote server.
struct Session {
    /// Where requests go.
    fetch: Handler,
    /// Headers sent with every request.
    headers: Vec<(String, String)>,
    /// Connection state.
    state: futures_util::lock::Mutex<State>,
    /// The server URL.
    url: String,
}

impl Session {
    /// Sends a JSON-RPC request or notification and returns its result.
    async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, Error> {
        let notification = method.starts_with("notifications/");
        let (id, session, initialized) = {
            let mut state = self.state.lock().await;
            state.next += 1;
            let id = (!notification).then(|| format!("incur-{}", state.next));
            (id, state.id.clone(), state.initialized)
        };
        let mut headers = self.headers.clone();
        fetch::set(&mut headers, "content-type", "application/json");
        fetch::set(
            &mut headers,
            "accept",
            "application/json, text/event-stream",
        );
        if let Some(session) = &session {
            fetch::set(&mut headers, "mcp-session-id", session);
        }
        if initialized {
            fetch::set(&mut headers, "mcp-protocol-version", PROTOCOL_VERSION);
        }
        let mut message = Map::new();
        message.insert("jsonrpc".into(), "2.0".into());
        if let Some(id) = &id {
            message.insert("id".into(), id.clone().into());
        }
        message.insert("method".into(), method.into());
        if let Some(params) = params {
            message.insert("params".into(), params);
        }
        let url = Url::parse(&self.url)
            .ok_or_else(|| Error::unknown(format!("Invalid URL: {}", self.url)))?;
        let request = fetch::request(
            "POST",
            &url,
            &headers,
            Some(Body::from(crate::js::stringify(&Value::Object(message)))),
        )?;
        let response = (self.fetch)(request).await?;
        if let Some(id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.state.lock().await.id = Some(id.to_owned());
        }
        let status = response.status();
        if !status.is_success() {
            return Err(Error::unknown(format!("MCP HTTP {}", status.as_u16())));
        }
        if notification && status.as_u16() == 202 {
            return Ok(Value::Object(Map::new()));
        }
        let sse = response
            .headers()
            .get(http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/event-stream"));
        let text = response.into_body().text().await;
        if text.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        let message = if sse {
            parse_sse(&text, id.as_deref())?
        } else {
            crate::js::json_parse(&text, |_| Value::Null).map_err(Error::unknown)?
        };
        if let Some(error) = message.get("error").filter(|e| !e.is_null()) {
            let text = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("MCP request failed");
            return Err(Error::unknown(text));
        }
        Ok(message
            .get("result")
            .filter(|r| !r.is_null())
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())))
    }

    /// Calls a tool and returns its value, failing when the tool reports an error.
    async fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, Error> {
        let result = self
            .request(
                "tools/call",
                Some(json!({ "name": name, "arguments": arguments })),
            )
            .await?;
        if result.get("isError").is_some_and(truthy) {
            let text = result_text(&result);
            let message = if text.is_empty() {
                format!("MCP tool failed: {name}")
            } else {
                text
            };
            return Err(Error::unknown(message));
        }
        Ok(result_value(&result))
    }
}

/// Whether a JSON value is truthy, as JavaScript tests it.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Finds the JSON-RPC message with `id` in an SSE body.
fn parse_sse(text: &str, id: Option<&str>) -> Result<Value, Error> {
    let normalized = text.replace("\r\n", "\n");
    for event in normalized.split("\n\n") {
        let data = event
            .split('\n')
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|line| line.trim_start_matches(crate::js::is_whitespace))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        let message = crate::js::json_parse(&data, |_| Value::Null).map_err(Error::unknown)?;
        if id.is_none() || message.get("id").and_then(Value::as_str) == id {
            return Ok(message);
        }
    }
    Err(Error::unknown(
        "MCP SSE response did not include the matching JSON-RPC message",
    ))
}

/// Joins the text content of a tool result.
fn result_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            (item.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| item.get("text").and_then(Value::as_str))
                .flatten()
                .filter(|t| !t.is_empty())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Returns a tool result's value: structured content, one text item parsed as JSON when it
/// is JSON, or every text item.
fn result_value(result: &Value) -> Value {
    if let Some(structured) = result.get("structuredContent") {
        return structured.clone();
    }
    let texts = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
        .map(|item| item.get("text").cloned().unwrap_or(Value::Null))
        .collect::<Vec<_>>();
    match texts.as_slice() {
        [Value::String(text)] => fetch::json_or_text(text),
        _ => Value::Array(texts),
    }
}

/// Initializes the session, lists tools, and generates commands.
async fn resolve(session: Arc<Session>) -> Result<IndexMap<String, Entry>, Error> {
    session
        .request(
            "initialize",
            Some(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "incur", "version": "1.0.0" },
            })),
        )
        .await?;
    session.state.lock().await.initialized = true;
    session.request("notifications/initialized", None).await?;
    let listed = session.request("tools/list", None).await?;
    let tools = listed
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let progressive = tools.len() == 4
        && [
            "search_tools",
            "get_tool_details",
            "call_read_tool",
            "call_write_tool",
        ]
        .iter()
        .all(|name| {
            tools
                .iter()
                .any(|t| t.get("name").and_then(Value::as_str) == Some(name))
        });
    let tools = if progressive {
        discover(&session).await?
    } else {
        tools
    };
    let mut commands = IndexMap::new();
    for tool in tools {
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        commands.insert(
            name.to_owned(),
            Entry::Command(command(&session, &tool, name, progressive)),
        );
    }
    Ok(commands)
}

/// Lists every tool of a progressive catalog, page by page.
async fn discover(session: &Session) -> Result<Vec<Value>, Error> {
    let mut tools = Vec::new();
    let mut offset = Some(0.0);
    while let Some(current) = offset {
        let search = session
            .call_tool(
                "search_tools",
                json!({ "query": "", "limit": 20, "offset": crate::js::number(current) }),
            )
            .await?;
        for found in search
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = found
                .get("name")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
            else {
                continue;
            };
            let tool = session
                .call_tool("get_tool_details", json!({ "name": name }))
                .await?;
            if tool
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| !n.is_empty())
            {
                tools.push(tool);
            }
        }
        let next = search.get("nextOffset").and_then(Value::as_f64);
        if next.is_some_and(|next| next <= current) {
            return Err(Error::unknown(
                "MCP tool catalog returned a non-advancing offset",
            ));
        }
        offset = next;
    }
    Ok(tools)
}

/// Builds the command of a remote tool.
fn command(session: &Arc<Session>, tool: &Value, name: &str, progressive: bool) -> Command {
    let mut command = Command::new();
    command.description = tool
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if let Some(annotations) = tool.get("annotations").and_then(Value::as_object) {
        let flag = |key: &str| annotations.get(key).and_then(Value::as_bool);
        command.mcp = Some(
            Tool::new().annotations(Annotations {
                destructive_hint: flag("destructiveHint"),
                idempotent_hint: flag("idempotentHint"),
                open_world_hint: flag("openWorldHint"),
                read_only_hint: flag("readOnlyHint"),
                title: annotations
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }),
        );
    }
    if let Some(schema) = tool.get("inputSchema").filter(|s| s.is_object()) {
        command.options = input_options(schema);
    }
    command.output = tool
        .get("outputSchema")
        .filter(|s| s.get("type").and_then(Value::as_str) == Some("object"))
        .map(|schema| Zod::from_json(schema).into_type());
    let read_only = tool
        .pointer("/annotations/readOnlyHint")
        .and_then(Value::as_bool)
        == Some(true);
    let session = session.clone();
    let name = name.to_owned();
    command.handler = Some(Arc::new(move |invocation: command::Invocation| {
        let session = session.clone();
        let name = name.clone();
        Box::pin(async move {
            let mut arguments = invocation.args.as_object().cloned().unwrap_or_default();
            arguments.extend(invocation.options.as_object().cloned().unwrap_or_default());
            let parameters = json!({ "name": name, "arguments": arguments });
            let params = if progressive {
                let tool = if read_only {
                    "call_read_tool"
                } else {
                    "call_write_tool"
                };
                json!({ "name": tool, "arguments": parameters })
            } else {
                parameters
            };
            match session.request("tools/call", Some(params)).await {
                Err(error) => Outcome::from(error),
                Ok(result) if result.get("isError").is_some_and(truthy) => {
                    Outcome::from(Error::new("MCP_TOOL_ERROR", result_text(&result)))
                }
                Ok(result) => command::ok(result_value(&result)),
            }
        })
    }));
    command
}

/// Converts a tool's input schema into options.
fn input_options(schema: &Value) -> Option<Type> {
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let fields = schema
        .get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, property)| {
            let mut zod = Zod::from_json(property);
            if !required.contains(&key.as_str()) {
                zod = zod.optional();
            }
            if let Some(description) = property.get("description").and_then(Value::as_str) {
                zod = zod.describe(description);
            }
            Field::new(key.clone(), zod.coerce().into_type())
        })
        .collect::<Vec<_>>();
    (!fields.is_empty()).then(|| Type::object(fields))
}
