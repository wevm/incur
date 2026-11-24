//! The CLI as an HTTP handler: commands, MCP over streamable HTTP, OpenAPI, and Agent Skills
//! discovery.

use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::body::{self, Body};
use crate::cli::{Cli, Entry, Resolved, Scope, resolve, skill_commands, suggest};
use crate::command::{Command, Middleware, MiddlewareContext};
use crate::errors::{Error, FormattedCtaBlock};
use crate::execute::{self, Executed};
use crate::fetch;
use crate::formatter::Format;
use crate::js;
use crate::mcp;
use crate::openapi;
use crate::parser;
use crate::skill;

/// The stateful MCP session of a CLI served over HTTP.
pub(crate) struct Session {
    /// The session id.
    id: String,
}

/// The protocol versions the MCP transport accepts in headers.
const PROTOCOL_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// The process environment.
fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Builds a response.
fn response(status: u16, headers: &[(&str, &str)], body: Body) -> http::Response<Body> {
    let mut builder = http::Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| http::Response::new(Body::empty()))
}

/// Builds a JSON response.
fn json_response(status: u16, value: &Value) -> http::Response<Body> {
    response(
        status,
        &[("content-type", "application/json")],
        Body::from(js::stringify(value)),
    )
}

/// Builds a JSON-RPC error response with a `null` id.
fn rpc_error(status: u16, code: i64, message: &str) -> http::Response<Body> {
    json_response(
        status,
        &json!({ "jsonrpc": "2.0", "error": { "code": code, "message": message }, "id": null }),
    )
}

/// Returns a `{ ok: false }` envelope.
fn failure(code: &str, message: &str, command: &str, start: Instant) -> Value {
    json!({
        "ok": false,
        "error": { "code": code, "message": message },
        "meta": { "command": command, "duration": duration(start) },
    })
}

/// Returns the elapsed time as `Nms`.
fn duration(start: Instant) -> String {
    format!("{}ms", start.elapsed().as_millis())
}

/// Returns a header value as text.
fn header<'a>(parts: &'a http::request::Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).and_then(|v| v.to_str().ok())
}

impl Cli {
    /// Handles an HTTP request, as a server built on the `http` crate (hyper, axum) calls it.
    ///
    /// - `GET /openapi.json`, `/openapi.yaml`, `/openapi.yml`, and `/.well-known/openapi.json`
    ///   describe the commands as an OpenAPI document.
    /// - `/mcp` serves MCP over streamable HTTP, stateless unless
    ///   [`Mcp::stateless`](crate::Mcp::stateless) is `false`.
    /// - `GET /.well-known/agent-skills/` and `/.well-known/skills/` serve Agent Skills
    ///   discovery indexes and skill files.
    /// - Any other path runs the command it names: further segments are arguments, and the
    ///   query string (`GET`) or JSON body (other methods) holds options and globals. Data
    ///   returns as a JSON envelope, and streams as NDJSON.
    ///
    /// ```
    /// use incur::{Body, Cli, Command, Context};
    ///
    /// # tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
    /// let cli = Cli::new("tool").command(
    ///     "ping",
    ///     Command::new().run(|_: Context| "pong"),
    /// );
    /// let request = http::Request::get("http://localhost/ping").body(Body::empty()).unwrap();
    /// let response = cli.fetch(request).await;
    /// assert_eq!(response.status(), 200);
    /// # });
    /// ```
    pub async fn fetch<B>(&self, request: http::Request<B>) -> http::Response<Body>
    where
        B: http_body::Body + Send,
        B::Data: Send,
        B::Error: fmt::Display,
    {
        let start = Instant::now();
        let (parts, body) = request.into_parts();
        let bytes = body::collect(body).await.unwrap_or_default();
        let tree = match self.tree(&Scope::All).await {
            Ok(tree) => tree,
            Err(error) => {
                return json_response(500, &failure(&error.code, &error.message, "/", start));
            }
        };
        let url = fetch::parts_url(&parts.uri);
        let segments = url
            .path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let get = parts.method == http::Method::GET;
        let openapi_route = match segments.as_slice() {
            [only] => matches!(
                only.as_str(),
                "openapi.json" | "openapi.yml" | "openapi.yaml"
            ),
            [first, second] => first == ".well-known" && second == "openapi.json",
            _ => false,
        };
        if get && openapi_route {
            return self.openapi(&tree, &segments[0]);
        }
        if segments.len() == 1 && segments[0] == "mcp" {
            return self.mcp_http(&tree, parts, &bytes).await;
        }
        if get
            && segments.len() >= 3
            && segments[0] == ".well-known"
            && (segments[1] == "agent-skills" || segments[1] == "skills")
        {
            return self.skills(&tree, &segments, &url.origin());
        }

        let options = if get {
            let mut options = Map::new();
            for (key, value) in url
                .query
                .as_deref()
                .map(crate::url::form_decode)
                .unwrap_or_default()
            {
                options.insert(key, Value::String(value));
            }
            Value::Object(options)
        } else if header(&parts, "content-type").is_some_and(|ct| ct.contains("application/json")) {
            js::json_parse(&String::from_utf8_lossy(&bytes), |_| Value::Null)
                .unwrap_or_else(|_| Value::Object(Map::new()))
        } else {
            Value::Object(Map::new())
        };
        let options = match options {
            Value::Object(options) => options,
            _ => Map::new(),
        };

        if segments.is_empty() {
            return match self.root_command() {
                Some(root) => {
                    self.execute_http(&root, Vec::new(), &self.name, &[], options, parts, start)
                        .await
                }
                None => json_response(
                    404,
                    &failure("COMMAND_NOT_FOUND", "No root command defined.", "/", start),
                ),
            };
        }
        match resolve(&tree, &segments) {
            Resolved::Error {
                commands,
                error,
                path,
                ..
            } => {
                let parent = if path.is_empty() {
                    self.name.clone()
                } else {
                    format!("{} {path}", self.name)
                };
                let suggestion = suggest(&error, commands.keys().map(String::as_str))
                    .map_or_else(String::new, |s| format!(" Did you mean '{s}'?"));
                let message = format!("'{error}' is not a command for '{parent}'.{suggestion}");
                json_response(404, &failure("COMMAND_NOT_FOUND", &message, &error, start))
            }
            Resolved::Help { path, .. } => json_response(
                404,
                &failure(
                    "COMMAND_NOT_FOUND",
                    &format!("'{path}' is a command group. Specify a subcommand."),
                    &path,
                    start,
                ),
            ),
            Resolved::Fetch { gateway, .. } => {
                let request = http::Request::from_parts(parts, Body::from(bytes));
                match gateway.fetch.send(request, &self.http_client()).await {
                    Ok(response) => response,
                    Err(error) => {
                        json_response(500, &failure(&error.code, &error.message, "/", start))
                    }
                }
            }
            Resolved::Command {
                command,
                middleware,
                path,
                rest,
                ..
            } => {
                self.execute_http(command, middleware, &path, &rest, options, parts, start)
                    .await
            }
        }
    }

    /// Serves the OpenAPI document of the commands as JSON or YAML.
    fn openapi(&self, tree: &IndexMap<String, Entry>, route: &str) -> http::Response<Body> {
        let root = self.root_command();
        let document = openapi::from_cli(
            &self.name,
            self.description.as_deref(),
            self.version.as_deref(),
            root.as_ref(),
            tree,
            self.globals.as_ref(),
        );
        let yaml = route == "openapi.yml" || route == "openapi.yaml";
        let (text, content_type) = if yaml {
            (
                crate::yaml::stringify(&openapi::anchors(document)),
                "application/yaml",
            )
        } else {
            (js::stringify(&openapi::plain(document)), "application/json")
        };
        response(
            200,
            &[
                ("content-type", content_type),
                ("cache-control", "public, max-age=300"),
            ],
            Body::from(text),
        )
    }

    /// Serves Agent Skills discovery: indexes and skill files.
    fn skills(
        &self,
        tree: &IndexMap<String, Entry>,
        segments: &[String],
        origin: &str,
    ) -> http::Response<Body> {
        let root = self.root_command();
        let mut groups = IndexMap::new();
        let infos = skill_commands(tree, &[], &mut groups, root.as_ref());
        let files = skill::split(
            &self.name,
            &infos,
            1,
            &groups,
            self.sync.command.as_deref().unwrap_or(&self.name),
        );
        let name_of = |file: &skill::File| {
            if file.dir.is_empty() {
                self.name.clone()
            } else {
                file.dir.clone()
            }
        };
        let cached = [
            ("content-type", "application/json"),
            ("cache-control", "public, max-age=300"),
        ];
        if segments.len() == 3 && segments[2] == "index.json" {
            let index = if segments[1] == "agent-skills" {
                let skills = files
                    .iter()
                    .map(|file| {
                        let name = name_of(file);
                        json!({
                            "name": name,
                            "type": "skill-md",
                            "description": file.description,
                            "url": format!("{origin}/.well-known/agent-skills/{name}/SKILL.md"),
                            "digest": format!("sha256:{}", skill::sha256_hex(file.content.as_bytes())),
                        })
                    })
                    .collect::<Vec<_>>();
                json!({
                    "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                    "skills": skills,
                })
            } else {
                let skills = files
                    .iter()
                    .map(|file| {
                        json!({
                            "name": name_of(file),
                            "description": file.description,
                            "files": ["SKILL.md"],
                        })
                    })
                    .collect::<Vec<_>>();
                json!({ "skills": skills })
            };
            return response(200, &cached, Body::from(js::stringify(&index)));
        }
        if segments.len() == 4
            && segments[3] == "SKILL.md"
            && let Some(file) = files.iter().find(|file| name_of(file) == segments[2])
        {
            return response(
                200,
                &[
                    ("content-type", "text/markdown"),
                    ("cache-control", "public, max-age=300"),
                ],
                Body::from(file.content.clone()),
            );
        }
        response(
            404,
            &[("content-type", "text/plain;charset=UTF-8")],
            Body::from("Not Found"),
        )
    }

    /// Runs a command for an HTTP request and returns its JSON or NDJSON response.
    #[expect(clippy::too_many_arguments, reason = "The request's resolved parts.")]
    async fn execute_http(
        &self,
        command: &Command,
        group_middleware: Vec<Middleware>,
        path: &str,
        rest: &[String],
        mut options: Map<String, Value>,
        parts: http::request::Parts,
        start: Instant,
    ) -> http::Response<Body> {
        let mut chain = self.middleware.clone();
        chain.extend(group_middleware);
        chain.extend(command.middleware.iter().cloned());
        let mut globals = Value::Object(Map::new());
        if let Some(schema) = &self.globals {
            let mut raw = Map::new();
            options.retain(|key, value| {
                if schema.field(key).is_some() {
                    raw.insert(key.clone(), value.clone());
                    false
                } else {
                    true
                }
            });
            match parser::validate(schema, &raw) {
                Ok(parsed) => globals = parsed,
                Err(error) => {
                    // Validation always reports field errors.
                    let message = error
                        .field_errors
                        .iter()
                        .flatten()
                        .map(|f| f.message.as_str())
                        .collect::<Vec<_>>()
                        .join("; ");
                    return json_response(400, &failure("VALIDATION_ERROR", &message, path, start));
                }
            }
        }
        let env = execute::parse_env(self.env.as_ref(), &process_env);
        let request = Arc::new(parts);
        let executed = match env {
            Err(error) => Executed::Error(error),
            Ok(env) => {
                let context = MiddlewareContext {
                    agent: true,
                    command: path.to_owned(),
                    display_name: self.name.clone(),
                    env,
                    format: Format::Json,
                    format_explicit: true,
                    globals,
                    name: self.name.clone(),
                    request: Some(request),
                    vars: self.vars.clone(),
                    version: self.version.clone(),
                };
                let input = execute::parse_split(
                    rest,
                    &options,
                    command.args.as_ref(),
                    command.options.as_ref(),
                )
                .and_then(|parsed| {
                    Ok((
                        parsed,
                        execute::parse_env(command.env.as_ref(), &process_env)?,
                    ))
                });
                execute::execute(chain, context, command.handler.clone(), input).await
            }
        };
        let meta = |start: Instant, cta: Option<&FormattedCtaBlock>| {
            let mut meta = Map::new();
            meta.insert("command".into(), path.into());
            meta.insert("duration".into(), duration(start).into());
            if let Some(cta) = cta {
                meta.insert("cta".into(), cta.to_value());
            }
            Value::Object(meta)
        };
        match executed {
            Executed::Data { cta, data } => {
                let cta = FormattedCtaBlock::new(&self.name, cta.as_ref());
                let mut out = Map::new();
                out.insert("ok".into(), true.into());
                if let Some(data) = data {
                    out.insert("data".into(), data);
                }
                out.insert("meta".into(), meta(start, cta.as_ref()));
                json_response(200, &Value::Object(out))
            }
            Executed::Error(error) => {
                let cta = FormattedCtaBlock::new(&self.name, error.cta.as_deref());
                let status = if error.code == "VALIDATION_ERROR" {
                    400
                } else {
                    500
                };
                let mut out = Map::new();
                out.insert("ok".into(), false.into());
                out.insert("error".into(), error.to_value());
                out.insert("meta".into(), meta(start, cta.as_ref()));
                json_response(status, &Value::Object(out))
            }
            Executed::Stream { chunks, cta, rest } => {
                let name = self.name.clone();
                let path = path.to_owned();
                let lines = ndjson(chunks, cta, rest, name, path, start);
                response(
                    200,
                    &[("content-type", "application/x-ndjson")],
                    Body::stream(lines),
                )
            }
        }
    }

    /// Serves MCP over streamable HTTP with JSON responses.
    async fn mcp_http(
        &self,
        tree: &IndexMap<String, Entry>,
        parts: http::request::Parts,
        bytes: &Bytes,
    ) -> http::Response<Body> {
        let stateless = self.mcp.stateless;
        let method = parts.method.clone();
        if stateless && method != http::Method::POST {
            return response(405, &[("allow", "POST")], Body::empty());
        }
        if method == http::Method::GET {
            if !header(&parts, "accept").is_some_and(|a| a.contains("text/event-stream")) {
                return rpc_error(
                    406,
                    -32000,
                    "Not Acceptable: Client must accept text/event-stream",
                );
            }
            if let Some(error) = self.validate_session(&parts).await {
                return error;
            }
            return response(
                200,
                &[
                    ("content-type", "text/event-stream"),
                    ("cache-control", "no-cache"),
                    ("connection", "keep-alive"),
                ],
                Body::empty(),
            );
        }
        if method == http::Method::DELETE {
            if let Some(error) = self.validate_session(&parts).await {
                return error;
            }
            return response(200, &[], Body::empty());
        }
        if method != http::Method::POST {
            return json_response_with(
                405,
                &[("allow", "GET, POST, DELETE")],
                &json!({ "jsonrpc": "2.0", "error": { "code": -32000, "message": "Method not allowed." }, "id": null }),
            );
        }
        let accept = header(&parts, "accept").unwrap_or_default();
        if !accept.contains("application/json") || !accept.contains("text/event-stream") {
            return rpc_error(
                406,
                -32000,
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            );
        }
        if !header(&parts, "content-type").is_some_and(|ct| ct.contains("application/json")) {
            return rpc_error(
                415,
                -32000,
                "Unsupported Media Type: Content-Type must be application/json",
            );
        }
        let Ok(raw) = js::json_parse(&String::from_utf8_lossy(bytes), |_| Value::Null) else {
            return rpc_error(400, -32700, "Parse error: Invalid JSON");
        };
        let raw_messages = match &raw {
            Value::Array(items) => items.clone(),
            other => vec![other.clone()],
        };
        let mut messages = Vec::new();
        for message in &raw_messages {
            match mcp::message(message) {
                Some(parsed) => messages.push(parsed),
                None => return rpc_error(400, -32700, "Parse error: Invalid JSON-RPC message"),
            }
        }
        let initialize = messages.iter().any(mcp::is_initialize);
        let mut session_id = None;
        if !stateless {
            if initialize {
                let mut session = self.state.session.lock().await;
                if session.is_some() {
                    return rpc_error(400, -32600, "Invalid Request: Server already initialized");
                }
                if messages.len() > 1 {
                    return rpc_error(
                        400,
                        -32600,
                        "Invalid Request: Only one initialization request is allowed",
                    );
                }
                let id = session_id_new();
                *session = Some(Session { id: id.clone() });
                session_id = Some(id);
            } else {
                if let Some(error) = self.validate_session(&parts).await {
                    return error;
                }
                session_id = self
                    .state
                    .session
                    .lock()
                    .await
                    .as_ref()
                    .map(|s| s.id.clone());
            }
        } else if !initialize && let Some(error) = protocol_error(&parts) {
            return error;
        }
        let requests = messages
            .into_iter()
            .filter_map(|message| match message {
                mcp::Message::Request { id, method, params } => Some((id, method, params)),
                mcp::Message::Other { .. } => None,
            })
            .collect::<Vec<_>>();
        if requests.is_empty() {
            return response(202, &[], Body::empty());
        }
        let server = match self.mcp_server(tree, &process_env, false, &mcp::Defaults::default()) {
            Ok(server) => server,
            Err(error) => return rpc_error(500, -32603, &error.message),
        };
        let request = Arc::new(parts);
        let mut responses = Vec::new();
        for (id, method, params) in requests {
            responses.push(
                server
                    .handle(&id, &method, &params, Some(request.clone()), &mut |_| {})
                    .await,
            );
        }
        let body = if responses.len() == 1 {
            responses.remove(0)
        } else {
            Value::Array(responses)
        };
        let mut headers = vec![("content-type", "application/json".to_owned())];
        if let Some(id) = session_id {
            headers.push(("mcp-session-id", id));
        }
        let headers = headers
            .iter()
            .map(|(k, v)| (*k, v.as_str()))
            .collect::<Vec<_>>();
        response(200, &headers, Body::from(js::stringify(&body)))
    }

    /// Validates the session header of a stateful MCP request.
    async fn validate_session(&self, parts: &http::request::Parts) -> Option<http::Response<Body>> {
        let session = self.state.session.lock().await;
        let Some(session) = session.as_ref() else {
            return Some(rpc_error(
                400,
                -32000,
                "Bad Request: Server not initialized",
            ));
        };
        let Some(id) = header(parts, "mcp-session-id") else {
            return Some(rpc_error(
                400,
                -32000,
                "Bad Request: Mcp-Session-Id header is required",
            ));
        };
        if id != session.id {
            return Some(rpc_error(404, -32001, "Session not found"));
        }
        protocol_error(parts)
    }

    /// Builds the MCP server over a command tree.
    pub(crate) fn mcp_server<'a>(
        &self,
        tree: &IndexMap<String, Entry>,
        env: &'a (dyn Fn(&str) -> Option<String> + Sync),
        direct: bool,
        defaults: &mcp::Defaults<'_>,
    ) -> Result<mcp::Server<'a>, Error> {
        let settings = &self.mcp;
        // Default values become schema defaults, so a call's own arguments still win.
        let globals = self
            .globals
            .as_ref()
            .map(|globals| mcp::with_defaults(globals, &defaults.globals));
        Ok(mcp::Server {
            context: mcp::Context {
                env,
                env_schema: self.env.clone(),
                globals: globals.clone(),
                middleware: self.middleware.clone(),
                vars: self.vars.clone(),
                version: self.version.clone(),
            },
            direct: direct || settings.discovery == mcp::Discovery::Direct,
            instructions: settings.instructions.clone(),
            name: settings.name.clone().unwrap_or_else(|| self.name.clone()),
            title: settings.title.clone(),
            tools: mcp::collect(tree, globals.as_ref(), settings, defaults.options)?,
            version: self.version.clone().unwrap_or_else(|| "0.0.0".into()),
        })
    }
}

/// Builds a JSON response with extra headers.
fn json_response_with(
    status: u16,
    headers: &[(&str, &str)],
    value: &Value,
) -> http::Response<Body> {
    let mut all = headers.to_vec();
    all.push(("content-type", "application/json"));
    response(status, &all, Body::from(js::stringify(value)))
}

/// Validates the `mcp-protocol-version` header.
fn protocol_error(parts: &http::request::Parts) -> Option<http::Response<Body>> {
    let version = header(parts, "mcp-protocol-version")?;
    if PROTOCOL_VERSIONS.contains(&version) {
        return None;
    }
    Some(rpc_error(
        400,
        -32000,
        &format!(
            "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
            PROTOCOL_VERSIONS.join(", ")
        ),
    ))
}

/// Creates a session id: a random-looking UUID from the clock and a counter.
fn session_id_new() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let count = u128::from(COUNTER.fetch_add(1, Ordering::Relaxed));
    let mixed = (nanos ^ (count << 64)).wrapping_mul(0x9E37_79B9_7F4A_7C15_F39C_C060_5CED_C835);
    let hex = format!("{mixed:032x}");
    format!(
        "{}-{}-4{}-a{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

/// Streams a command's chunks as NDJSON records, then a `done` or `error` record.
fn ndjson(
    chunks: crate::command::Chunks,
    cta: Option<crate::errors::CtaBlock>,
    rest: execute::Rest,
    name: String,
    path: String,
    start: Instant,
) -> impl futures_core::Stream<Item = Bytes> + Send {
    /// The stream state.
    enum State {
        /// Reading chunks.
        Reading {
            /// The chunks.
            chunks: crate::command::Chunks,
            /// Suggestions after the stream.
            cta: Option<crate::errors::CtaBlock>,
            /// The waiting middleware chain.
            rest: execute::Rest,
        },
        /// Finished.
        Done,
    }
    let meta = move |cta: Option<FormattedCtaBlock>| {
        let mut meta = Map::new();
        meta.insert("command".into(), path.clone().into());
        meta.insert("duration".into(), duration(start).into());
        if let Some(cta) = cta {
            meta.insert("cta".into(), cta.to_value());
        }
        Value::Object(meta)
    };
    futures_util::stream::unfold(
        (State::Reading { chunks, cta, rest }, meta, name),
        |(state, meta, name)| async move {
            let State::Reading {
                mut chunks,
                cta,
                rest,
            } = state
            else {
                return None;
            };
            let line = |value: Value| Bytes::from(format!("{}\n", js::stringify(&value)));
            match std::future::poll_fn(|cx| chunks.as_mut().poll_next(cx)).await {
                Some(Ok(value)) => {
                    let record = json!({ "type": "chunk", "data": value });
                    Some((
                        line(record),
                        (State::Reading { chunks, cta, rest }, meta, name),
                    ))
                }
                end => {
                    drop(chunks);
                    let finished = rest.finish().await;
                    let error = match end {
                        Some(Err(error)) => Some(error),
                        _ => finished.err(),
                    };
                    let record = if let Some(error) = error {
                        let cta = FormattedCtaBlock::new(&name, error.cta.as_deref());
                        let mut record = Map::new();
                        record.insert("type".into(), "error".into());
                        record.insert("ok".into(), false.into());
                        record.insert("error".into(), error.to_value());
                        record.insert("meta".into(), meta(cta));
                        Value::Object(record)
                    } else {
                        let cta = FormattedCtaBlock::new(&name, cta.as_ref());
                        json!({ "type": "done", "ok": true, "meta": meta(cta) })
                    };
                    Some((line(record), (State::Done, meta, name)))
                }
            }
        },
    )
}
