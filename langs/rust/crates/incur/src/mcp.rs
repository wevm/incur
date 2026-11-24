//! The Model Context Protocol server: commands exposed as tools over stdio (`--mcp`) and over
//! HTTP through [`Cli::fetch`](crate::Cli::fetch).

use std::fmt::Write as _;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::cli::Entry;
use crate::command::{Command, Middleware, MiddlewareContext, Vars};
use crate::errors::{Error, FormattedCtaBlock};
use crate::execute::{self, Executed};
use crate::formatter::Format;
use crate::js;
use crate::parser::{self, Parsed};
use crate::schema::{self, Field, Kind, Type};

/// MCP protocol versions the server speaks, newest first.
const PROTOCOL_VERSIONS: [&str; 5] = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// The `$schema` the MCP SDK stamps on input schemas.
const DRAFT: &str = "https://json-schema.org/draft/2020-12/schema";

/// How MCP clients discover tools.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Discovery {
    /// Every command is a tool with its full schema.
    Direct,
    /// Four catalog tools search, inspect, and call commands, so clients load schemas on demand.
    #[default]
    Progressive,
}

/// MCP server settings, for `--mcp`, MCP over HTTP, and `mcp add`.
///
/// `Mcp::from(false)` hides a mounted group from MCP clients.
///
/// ```
/// use incur::{Cli, mcp::{Discovery, Mcp}};
///
/// let cli = Cli::new("tool").mcp(
///     Mcp::new()
///         .instructions("Use status before deploy.")
///         .discovery(Discovery::Direct)
///         .exclude(["internal*"]),
/// );
/// ```
#[derive(Clone, Debug)]
pub struct Mcp {
    /// Agents `mcp add` registers with by default.
    pub(crate) agents: Vec<String>,
    /// The command agents run, overriding the detected one.
    pub(crate) command: Option<String>,
    /// Tool discovery.
    pub(crate) discovery: Discovery,
    /// Whether the group is exposed.
    pub(crate) enabled: bool,
    /// Tool name patterns to hide.
    pub(crate) exclude: Vec<String>,
    /// Tool name patterns to expose.
    pub(crate) include: Vec<String>,
    /// Server instructions.
    pub(crate) instructions: Option<String>,
    /// The server name, defaulting to the CLI name.
    pub(crate) name: Option<String>,
    /// Whether MCP over HTTP is stateless.
    pub(crate) stateless: bool,
    /// The human-readable server title.
    pub(crate) title: Option<String>,
}

impl Default for Mcp {
    fn default() -> Self {
        Self::new()
    }
}

impl From<bool> for Mcp {
    fn from(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::new()
        }
    }
}

impl Mcp {
    /// Creates default settings: progressive discovery and stateless HTTP.
    pub fn new() -> Self {
        Self {
            agents: Vec::new(),
            command: None,
            discovery: Discovery::Progressive,
            enabled: true,
            exclude: Vec::new(),
            include: Vec::new(),
            instructions: None,
            name: None,
            stateless: true,
            title: None,
        }
    }

    /// Sets the agents `mcp add` registers with, such as `claude-code` or `cursor`.
    #[must_use]
    pub fn agents(mut self, agents: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.agents = agents.into_iter().map(Into::into).collect();
        self
    }

    /// Sets the command agents run, such as `my-cli --mcp`.
    #[must_use]
    pub fn command(mut self, command: impl Into<String>) -> Self {
        self.command = Some(command.into());
        self
    }

    /// Sets how clients discover tools.
    #[must_use]
    pub fn discovery(mut self, discovery: Discovery) -> Self {
        self.discovery = discovery;
        self
    }

    /// Hides tools whose names match a pattern, where `*` matches any characters. Excludes win
    /// over includes.
    #[must_use]
    pub fn exclude(mut self, patterns: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.exclude = patterns.into_iter().map(Into::into).collect();
        self
    }

    /// Exposes only tools whose names match a pattern, where `*` matches any characters.
    #[must_use]
    pub fn include(mut self, patterns: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.include = patterns.into_iter().map(Into::into).collect();
        self
    }

    /// Sets instructions describing how to use the server.
    #[must_use]
    pub fn instructions(mut self, instructions: impl Into<String>) -> Self {
        self.instructions = Some(instructions.into());
        self
    }

    /// Sets the server name. Defaults to the CLI name.
    #[must_use]
    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Sets whether MCP over HTTP keeps a session. Defaults to stateless.
    #[must_use]
    pub fn stateless(mut self, stateless: bool) -> Self {
        self.stateless = stateless;
        self
    }

    /// Sets the human-readable server title.
    #[must_use]
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }
}

/// Hints that describe a tool's behavior to MCP clients.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Annotations {
    /// Whether the tool may perform destructive updates.
    pub destructive_hint: Option<bool>,
    /// Whether repeated calls with the same arguments have no additional effect.
    pub idempotent_hint: Option<bool>,
    /// Whether the tool interacts with an open world of external entities.
    pub open_world_hint: Option<bool>,
    /// Whether the tool does not modify its environment.
    pub read_only_hint: Option<bool>,
    /// A human-readable title.
    pub title: Option<String>,
}

impl Annotations {
    /// Returns the annotations as MCP JSON.
    fn into_map(self) -> Map<String, Value> {
        let mut out = Map::new();
        if let Some(title) = self.title {
            out.insert("title".into(), title.into());
        }
        for (key, value) in [
            ("readOnlyHint", self.read_only_hint),
            ("destructiveHint", self.destructive_hint),
            ("idempotentHint", self.idempotent_hint),
            ("openWorldHint", self.open_world_hint),
        ] {
            if let Some(value) = value {
                out.insert(key.into(), value.into());
            }
        }
        out
    }
}

/// How a command appears as an MCP tool. `Tool::from(false)` hides it.
///
/// ```
/// use incur::{Command, mcp::{Annotations, Tool}};
///
/// let command = Command::new().mcp(
///     Tool::new()
///         .name("status_check")
///         .annotations(Annotations { read_only_hint: Some(true), ..Annotations::default() }),
/// );
/// ```
#[derive(Clone, Debug)]
pub struct Tool {
    /// Behavior hints.
    pub(crate) annotations: Option<Map<String, Value>>,
    /// The tool description, defaulting to the command description.
    pub(crate) description: Option<String>,
    /// Whether the command is exposed.
    pub(crate) enabled: bool,
    /// Instructions sent in the tool's `_meta`.
    pub(crate) instructions: Option<String>,
    /// The tool name, defaulting to the command path joined with `_`.
    pub(crate) name: Option<String>,
}

impl Default for Tool {
    fn default() -> Self {
        Self::new()
    }
}

impl From<bool> for Tool {
    fn from(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::new()
        }
    }
}

impl Tool {
    /// Creates default tool settings.
    pub fn new() -> Self {
        Self {
            annotations: None,
            description: None,
            enabled: true,
            instructions: None,
            name: None,
        }
    }

    /// Sets behavior hints.
    #[must_use]
    pub fn annotations(mut self, annotations: Annotations) -> Self {
        self.annotations = Some(annotations.into_map());
        self
    }

    /// Sets the tool description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets instructions sent in the tool's `_meta`.
    #[must_use]
    pub fn instructions(mut self, instructions: impl Into<String>) -> Self {
        self.instructions = Some(instructions.into());
        self
    }

    /// Sets the tool name.
    #[must_use]
    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
}

/// A command exposed as a tool.
#[derive(Clone)]
pub(crate) struct ToolEntry {
    /// Behavior hints.
    annotations: Option<Map<String, Value>>,
    /// The command.
    command: Command,
    /// The description.
    description: Option<String>,
    /// The JSON Schema of the merged arguments, options, and globals.
    input_schema: Value,
    /// Instructions.
    instructions: Option<String>,
    /// The merged input schema direct discovery validates with, or `None` without input.
    merged: Option<Type>,
    /// Group middleware.
    middleware: Vec<Middleware>,
    /// The tool name.
    name: String,
    /// The JSON Schema of object output.
    output_schema: Option<Value>,
}

/// Returns the config section of a command path, such as `project list`.
pub(crate) type ConfigSection<'a> = &'a dyn Fn(&str) -> Result<Option<Map<String, Value>>, Error>;

/// Values for tool calls that do not pass their own: the globals and config file of `--mcp`.
/// They become the defaults of the tool input schemas.
#[derive(Default)]
pub(crate) struct Defaults<'a> {
    /// Parsed global option values.
    pub(crate) globals: Map<String, Value>,
    /// The config sections of command paths, validated when the tools are collected.
    pub(crate) options: Option<ConfigSection<'a>>,
}

/// Returns a schema with parsed values as the defaults of their fields.
pub(crate) fn with_defaults(ty: &Type, values: &Map<String, Value>) -> Type {
    let fields = ty
        .fields()
        .iter()
        .map(|field| {
            let mut field = field.clone();
            if let Some(value) = values.get(&field.name) {
                field.ty.default = Some(value.clone());
                if let Some(converted) = &mut field.ty.converted {
                    // `.default()` wraps a converted schema: its JSON leads with the new default,
                    // and the field is no longer optional.
                    field.ty.optional = false;
                    converted.json = with_default(&converted.json, value);
                }
            }
            field
        })
        .collect();
    Type {
        kind: Kind::Object(fields),
        ..ty.clone()
    }
}

/// Returns a JSON Schema node led by `default`, replacing any default it has.
fn with_default(json: &Value, value: &Value) -> Value {
    let mut out = Map::new();
    out.insert("default".into(), value.clone());
    for (key, node) in json.as_object().into_iter().flatten() {
        if key != "default" {
            out.insert(key.clone(), node.clone());
        }
    }
    Value::Object(out)
}

/// Collects the tools of a command tree, filtered and sorted by name.
///
/// # Errors
///
/// Returns an error naming the first duplicate tool name or invalid config section.
pub(crate) fn collect(
    commands: &IndexMap<String, Entry>,
    globals: Option<&Type>,
    settings: &Mcp,
    config: Option<ConfigSection<'_>>,
) -> Result<Vec<ToolEntry>, Error> {
    let mut tools = Vec::new();
    entries(commands, &[], &[], globals, config, &mut tools)?;
    let matches = |patterns: &[String], name: &str| patterns.iter().any(|p| glob(p, name));
    tools.retain(|tool| {
        !matches(&settings.exclude, &tool.name)
            && (settings.include.is_empty() || matches(&settings.include, &tool.name))
    });
    let mut seen = indexmap::IndexSet::new();
    for tool in &tools {
        if !seen.insert(tool.name.clone()) {
            return Err(Error::unknown(format!(
                "Duplicate MCP tool name: {}",
                tool.name
            )));
        }
    }
    tools.sort_by(|a, b| js::locale_compare(&a.name, &b.name));
    Ok(tools)
}

/// Whether a name matches a pattern where `*` matches any characters.
pub(crate) fn glob(pattern: &str, name: &str) -> bool {
    let parts = pattern.split('*').collect::<Vec<_>>();
    let [first, middle @ .., last] = parts.as_slice() else {
        return pattern == name;
    };
    let Some(mut rest) = name.strip_prefix(first) else {
        return false;
    };
    for part in middle {
        match rest.find(part) {
            Some(index) => rest = &rest[index + part.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

/// Walks the command tree for tools.
fn entries(
    commands: &IndexMap<String, Entry>,
    prefix: &[String],
    middleware: &[Middleware],
    globals: Option<&Type>,
    config: Option<ConfigSection<'_>>,
    out: &mut Vec<ToolEntry>,
) -> Result<(), Error> {
    for (name, entry) in commands {
        let mut path = prefix.to_vec();
        path.push(name.clone());
        match entry {
            Entry::Alias(_) => {}
            Entry::Command(command) => {
                if command.mcp.as_ref().is_none_or(|tool| tool.enabled) {
                    out.push(tool(command, &path, middleware, globals, config)?);
                }
            }
            Entry::Fetch(fetch) => {
                let command = fetch.as_command();
                out.push(tool(&command, &path, middleware, globals, config)?);
            }
            Entry::Group(group) => {
                if !group.mcp {
                    continue;
                }
                let mut chain = middleware.to_vec();
                chain.extend(group.middleware.iter().cloned());
                if let Some(root) = group
                    .root
                    .as_ref()
                    .filter(|root| root.mcp.as_ref().is_none_or(|tool| tool.enabled))
                {
                    out.push(tool(root, &path, &chain, globals, config)?);
                }
                entries(&group.commands, &path, &chain, globals, config, out)?;
            }
        }
    }
    Ok(())
}

/// Builds the tool of a command.
fn tool(
    command: &Command,
    path: &[String],
    middleware: &[Middleware],
    globals: Option<&Type>,
    config: Option<ConfigSection<'_>>,
) -> Result<ToolEntry, Error> {
    // Config values become option defaults, so a call's own arguments still win.
    let mut command = command.clone();
    if let Some(section) = config
        .map(|config| config(&path.join(" ")))
        .transpose()?
        .flatten()
    {
        let values = parser::parse_defaults(&section, command.options.as_ref())?;
        command.options = command
            .options
            .map(|options| with_defaults(&options, &values));
    }
    let command = &command;
    let settings = command.mcp.as_ref();
    let output_schema = command
        .output
        .as_ref()
        .map(schema::json_schema)
        .filter(|schema| schema["type"] == "object");
    let mut properties = Map::new();
    let mut required = Vec::new();
    let mut fields: Vec<Field> = Vec::new();
    for ty in [command.args.as_ref(), command.options.as_ref(), globals]
        .into_iter()
        .flatten()
    {
        let json = schema::json_schema(ty);
        if let Some(Value::Object(props)) = json.get("properties") {
            properties.extend(props.clone());
        }
        if let Some(Value::Array(names)) = json.get("required") {
            required.extend(names.iter().cloned());
        }
        for field in ty.fields() {
            match fields.iter_mut().find(|f| f.name == field.name) {
                Some(existing) => *existing = field.clone(),
                None => fields.push(field.clone()),
            }
        }
    }
    let mut input = Map::new();
    input.insert("type".into(), "object".into());
    input.insert("properties".into(), properties.into());
    if !required.is_empty() {
        input.insert("required".into(), required.into());
    }
    Ok(ToolEntry {
        annotations: settings.and_then(|t| t.annotations.clone()),
        command: command.clone(),
        description: settings
            .and_then(|t| t.description.clone())
            .or_else(|| command.description.clone()),
        input_schema: Value::Object(input),
        instructions: settings.and_then(|t| t.instructions.clone()),
        merged: (!fields.is_empty()).then(|| Type::object(fields)),
        middleware: middleware.to_vec(),
        name: settings
            .and_then(|t| t.name.clone())
            .unwrap_or_else(|| path.join("_")),
        output_schema,
    })
}

/// Converts a schema to the JSON Schema the MCP SDK emits for tool input: Zod's input mode,
/// where defaulted fields are optional and objects allow unknown keys.
fn input_schema(ty: &Type) -> Value {
    let mut out = schema::json_schema(ty);
    if let Value::Object(map) = &mut out {
        strip_input(map, ty);
    }
    out
}

/// Rewrites an output-mode schema node into input mode.
fn strip_input(out: &mut Map<String, Value>, ty: &Type) {
    match &ty.kind {
        Kind::Object(fields) => {
            out.shift_remove("additionalProperties");
            let required = fields
                .iter()
                .filter(|f| !f.ty.optional && f.ty.default.is_none())
                .map(|f| Value::from(f.name.clone()))
                .collect::<Vec<_>>();
            if required.is_empty() {
                out.shift_remove("required");
            } else {
                out.insert("required".into(), required.into());
            }
            let mut properties = out.get_mut("properties").and_then(Value::as_object_mut);
            for field in fields {
                if let Some(node) = properties
                    .as_deref_mut()
                    .and_then(|p| p.get_mut(&field.name))
                    .and_then(Value::as_object_mut)
                {
                    strip_input(node, &field.ty);
                }
            }
        }
        Kind::Array { items, .. } => {
            if let Some(Value::Object(node)) = out.get_mut("items") {
                strip_input(node, items);
            }
        }
        _ => {}
    }
}

/// What tool calls need from the CLI.
#[derive(Clone)]
pub(crate) struct Context<'a> {
    /// Environment lookup.
    pub(crate) env: &'a (dyn Fn(&str) -> Option<String> + Sync),
    /// The CLI environment schema.
    pub(crate) env_schema: Option<Type>,
    /// The global options schema.
    pub(crate) globals: Option<Type>,
    /// Root middleware.
    pub(crate) middleware: Vec<Middleware>,
    /// Default variables.
    pub(crate) vars: Vars,
    /// The CLI version.
    pub(crate) version: Option<String>,
}

/// An MCP server over a command tree.
pub(crate) struct Server<'a> {
    /// Call context.
    pub(crate) context: Context<'a>,
    /// Whether every command is its own tool.
    pub(crate) direct: bool,
    /// Server instructions.
    pub(crate) instructions: Option<String>,
    /// The server name, also used to prefix suggested commands.
    pub(crate) name: String,
    /// The server title.
    pub(crate) title: Option<String>,
    /// The tools.
    pub(crate) tools: Vec<ToolEntry>,
    /// The server version.
    pub(crate) version: String,
}

/// A JSON-RPC message.
pub(crate) enum Message {
    /// A request expecting a response.
    Request {
        /// The request id.
        id: Value,
        /// The method.
        method: String,
        /// The parameters.
        params: Map<String, Value>,
    },
    /// A notification or response, which needs no answer.
    Other {
        /// Whether the message is an `initialize` request.
        initialize: bool,
    },
}

/// Parses a JSON-RPC message as the MCP SDK validates it.
pub(crate) fn message(value: &Value) -> Option<Message> {
    let object = value.as_object()?;
    if object.get("jsonrpc")? != "2.0" {
        return None;
    }
    let id = object
        .get("id")
        .filter(|id| id.is_string() || id.as_f64().is_some_and(|n| n.fract() == 0.0));
    if let Some(method) = object.get("method") {
        let method = method.as_str()?.to_owned();
        let params = match object.get("params") {
            None => Map::new(),
            Some(Value::Object(params)) => params.clone(),
            Some(_) => return None,
        };
        return match (object.contains_key("id"), id) {
            (false, _) => Some(Message::Other { initialize: false }),
            (true, Some(id)) => Some(Message::Request {
                id: id.clone(),
                method,
                params,
            }),
            (true, None) => None,
        };
    }
    id?;
    let valid = match (object.get("result"), object.get("error")) {
        (Some(result), None) => result.is_object(),
        (None, Some(error)) => {
            error.get("code").and_then(Value::as_f64).is_some()
                && error.get("message").is_some_and(Value::is_string)
        }
        _ => false,
    };
    valid.then_some(Message::Other { initialize: false })
}

/// Whether a parsed message is an `initialize` request.
pub(crate) fn is_initialize(message: &Message) -> bool {
    matches!(message, Message::Request { method, .. } if method == "initialize")
        || matches!(message, Message::Other { initialize: true })
}

/// Builds a JSON-RPC result response.
fn result(id: &Value, result: Value) -> Value {
    let mut out = Map::new();
    out.insert("result".into(), result);
    out.insert("jsonrpc".into(), "2.0".into());
    out.insert("id".into(), id.clone());
    Value::Object(out)
}

/// Builds a JSON-RPC error response.
fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

impl Server<'_> {
    /// Answers a request. Progress notifications go to `notify`.
    pub(crate) async fn handle(
        &self,
        id: &Value,
        method: &str,
        params: &Map<String, Value>,
        request: Option<Arc<http::request::Parts>>,
        notify: &mut (dyn FnMut(Value) + Send),
    ) -> Value {
        match method {
            "initialize" => {
                let requested = params.get("protocolVersion").and_then(Value::as_str);
                let version = requested
                    .filter(|v| PROTOCOL_VERSIONS.contains(v))
                    .unwrap_or(PROTOCOL_VERSIONS[0]);
                let mut info = Map::new();
                info.insert("name".into(), self.name.clone().into());
                if let Some(title) = &self.title {
                    info.insert("title".into(), title.clone().into());
                }
                info.insert("version".into(), self.version.clone().into());
                let mut out = Map::new();
                out.insert("protocolVersion".into(), version.into());
                out.insert(
                    "capabilities".into(),
                    json!({ "tools": { "listChanged": true } }),
                );
                out.insert("serverInfo".into(), info.into());
                if let Some(instructions) = &self.instructions {
                    out.insert("instructions".into(), instructions.clone().into());
                }
                result(id, Value::Object(out))
            }
            "ping" => result(id, json!({})),
            "tools/list" => result(id, json!({ "tools": self.list() })),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new()));
                let token = params
                    .get("_meta")
                    .and_then(|meta| meta.get("progressToken"))
                    .filter(|t| t.is_string() || t.is_number())
                    .cloned();
                let call = Call {
                    notify,
                    request,
                    token,
                };
                match self.call(name, &arguments, call).await {
                    Some(value) => result(id, value),
                    None => error(id, -32602, &format!("Tool {name} not found")),
                }
            }
            _ => error(id, -32601, "Method not found"),
        }
    }

    /// Lists tools as `tools/list` returns them.
    pub(crate) fn list(&self) -> Vec<Value> {
        if self.tools.is_empty() {
            return Vec::new();
        }
        if !self.direct {
            return catalog();
        }
        self.tools
            .iter()
            .map(|tool| {
                let mut out = Map::new();
                out.insert("name".into(), tool.name.clone().into());
                if let Some(description) = &tool.description {
                    out.insert("description".into(), description.clone().into());
                }
                let mut input = Map::new();
                input.insert("type".into(), "object".into());
                input.insert("$schema".into(), DRAFT.into());
                if let Some(Value::Object(schema)) = tool.merged.as_ref().map(input_schema) {
                    for (key, value) in schema {
                        if key != "type" {
                            input.insert(key, value);
                        }
                    }
                } else {
                    input.shift_remove("$schema");
                    input.insert("properties".into(), json!({}));
                }
                out.insert("inputSchema".into(), input.into());
                if let Some(annotations) = &tool.annotations {
                    out.insert("annotations".into(), annotations.clone().into());
                }
                if let Some(instructions) = &tool.instructions {
                    out.insert("_meta".into(), json!({ "instructions": instructions }));
                }
                if let Some(output) = &tool.output_schema {
                    out.insert("outputSchema".into(), output.clone());
                }
                Value::Object(out)
            })
            .collect()
    }

    /// Runs a `tools/call`. Returns `None` for an unknown tool.
    async fn call(&self, name: &str, arguments: &Value, call: Call<'_>) -> Option<Value> {
        if self.tools.is_empty() {
            return None;
        }
        if self.direct {
            let tool = self.tools.iter().find(|t| t.name == name)?;
            let params = match &tool.merged {
                None => Map::new(),
                Some(merged) => match validate(merged, arguments) {
                    Ok(params) => params,
                    Err(message) => return Some(input_error(name, &message)),
                },
            };
            return Some(self.run(tool, &params, true, call).await);
        }
        let catalog_tool = Catalog::from_name(name)?;
        let params = match catalog_tool.validate(arguments) {
            Ok(params) => params,
            Err(message) => return Some(input_error(name, &message)),
        };
        Some(match catalog_tool {
            Catalog::Search => self.search(&params),
            Catalog::Details => self.details(&params),
            Catalog::Read | Catalog::Write => {
                let target = params["name"].as_str().unwrap_or_default();
                let Some(tool) = self.tools.iter().find(|t| t.name == target) else {
                    return Some(tool_error(&format!("Unknown tool: {target}")));
                };
                let read_only = tool
                    .annotations
                    .as_ref()
                    .and_then(|a| a.get("readOnlyHint"))
                    == Some(&Value::Bool(true));
                if catalog_tool == Catalog::Read && !read_only {
                    return Some(tool_error(&format!("Tool is not read-only: {target}")));
                }
                if catalog_tool == Catalog::Write && read_only {
                    return Some(tool_error(&format!("Tool is read-only: {target}")));
                }
                let arguments = params["arguments"].as_object().cloned().unwrap_or_default();
                self.run(tool, &arguments, false, call).await
            }
        })
    }

    /// Answers `search_tools`.
    fn search(&self, params: &Map<String, Value>) -> Value {
        let query = normalize_search(params["query"].as_str().unwrap_or_default());
        let terms = query
            .split(' ')
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>();
        let mut matches = self
            .tools
            .iter()
            .map(|tool| (tool, score(tool, &query, &terms)))
            .filter(|(_, score)| *score > 0)
            .collect::<Vec<_>>();
        matches.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| js::locale_compare(&a.0.name, &b.0.name))
        });
        let limit = number(&params["limit"]);
        let offset = number(&params["offset"]);
        let page = matches
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(tool, _)| {
                let mut out = Map::new();
                out.insert("name".into(), tool.name.clone().into());
                if let Some(description) = &tool.description {
                    out.insert("description".into(), description.clone().into());
                }
                if let Some(annotations) = &tool.annotations {
                    out.insert("annotations".into(), annotations.clone().into());
                }
                Value::Object(out)
            })
            .collect::<Vec<_>>();
        let mut out = Map::new();
        let shown = page.len();
        out.insert("tools".into(), page.into());
        if offset + shown < matches.len() {
            out.insert("nextOffset".into(), (offset + shown).into());
        }
        tool_result(&Value::Object(out))
    }

    /// Answers `get_tool_details`.
    fn details(&self, params: &Map<String, Value>) -> Value {
        let name = params["name"].as_str().unwrap_or_default();
        let Some(tool) = self.tools.iter().find(|t| t.name == name) else {
            return tool_error(&format!("Unknown tool: {name}"));
        };
        let mut out = Map::new();
        out.insert("name".into(), tool.name.clone().into());
        if let Some(description) = &tool.description {
            out.insert("description".into(), description.clone().into());
        }
        out.insert("inputSchema".into(), tool.input_schema.clone());
        if let Some(output) = &tool.output_schema {
            out.insert("outputSchema".into(), output.clone());
        }
        if let Some(annotations) = &tool.annotations {
            out.insert("annotations".into(), annotations.clone().into());
        }
        if let Some(instructions) = &tool.instructions {
            out.insert("instructions".into(), instructions.clone().into());
        }
        tool_result(&Value::Object(out))
    }

    /// Executes a tool's command and renders the result.
    async fn run(
        &self,
        tool: &ToolEntry,
        params: &Map<String, Value>,
        parsed: bool,
        call: Call<'_>,
    ) -> Value {
        let context = &self.context;
        let command = &tool.command;
        let mut globals = Value::Object(Map::new());
        let mut input = params.clone();
        if let Some(schema) = &context.globals {
            let mut raw = Map::new();
            input = Map::new();
            for (key, value) in params {
                let global = schema.field(key).is_some();
                if global {
                    raw.insert(key.clone(), value.clone());
                }
                if !global || command.args.as_ref().and_then(|a| a.field(key)).is_some() {
                    input.insert(key.clone(), value.clone());
                }
            }
            globals = if parsed {
                Value::Object(raw)
            } else {
                match parser::validate(schema, &raw) {
                    Ok(globals) => globals,
                    Err(error) => {
                        let mut value = Map::new();
                        value.insert("code".into(), error.code.clone().into());
                        value.insert("message".into(), error.message.clone().into());
                        if let Some(Value::Array(fields)) = error_fields(&error) {
                            value.insert("fieldErrors".into(), fields.into());
                        }
                        return json!({
                            "content": [{ "type": "text", "text": js::stringify(&Value::Object(value)) }],
                            "isError": true,
                        });
                    }
                }
            };
        }
        let mut chain = context.middleware.clone();
        chain.extend(tool.middleware.iter().cloned());
        chain.extend(command.middleware.iter().cloned());
        let env = context.env;
        let cli_env = execute::parse_env(context.env_schema.as_ref(), env);
        let executed = match cli_env {
            Err(error) => Executed::Error(error),
            Ok(cli_env) => {
                let middleware = MiddlewareContext {
                    agent: true,
                    command: tool.name.clone(),
                    display_name: self.name.clone(),
                    env: cli_env,
                    format: Format::Json,
                    format_explicit: true,
                    globals,
                    name: self.name.clone(),
                    request: call.request,
                    vars: context.vars.clone(),
                    version: context.version.clone(),
                };
                let parsed =
                    execute::parse_flat(&input, command.args.as_ref(), command.options.as_ref())
                        .and_then(|parsed: Parsed| {
                            Ok((parsed, execute::parse_env(command.env.as_ref(), env)?))
                        });
                execute::execute(chain, middleware, command.handler.clone(), parsed).await
            }
        };
        match executed {
            Executed::Error(error) => self.failure(&error),
            Executed::Data { cta, data } => {
                let data = data.unwrap_or(Value::Null);
                let cta = FormattedCtaBlock::new(&self.name, cta.as_ref());
                let text = js::stringify(&data);
                let mut out = Map::new();
                if let Some(cta) = &cta {
                    out.insert("_meta".into(), json!({ "cta": cta.to_value() }));
                }
                let text = match &cta {
                    Some(cta) => format!("{text}\n\n{}", cta.text()),
                    None => text,
                };
                out.insert("content".into(), json!([{ "type": "text", "text": text }]));
                if !data.is_null() && tool.output_schema.is_some() {
                    out.insert("structuredContent".into(), data);
                }
                Value::Object(out)
            }
            Executed::Stream {
                mut chunks,
                cta,
                rest,
            } => {
                let mut items = Vec::new();
                let mut progress = 0u64;
                let mut failed = None;
                while let Some(chunk) =
                    std::future::poll_fn(|cx| chunks.as_mut().poll_next(cx)).await
                {
                    match chunk {
                        Ok(value) => {
                            progress += 1;
                            if let Some(token) = &call.token {
                                (call.notify)(json!({
                                    "jsonrpc": "2.0",
                                    "method": "notifications/progress",
                                    "params": {
                                        "progressToken": token,
                                        "progress": progress,
                                        "message": js::stringify(&value),
                                    },
                                }));
                            }
                            items.push(value);
                        }
                        Err(error) => {
                            failed = Some(error);
                            break;
                        }
                    }
                }
                drop(chunks);
                let _ = rest.finish().await;
                if let Some(error) = failed {
                    return self.failure(&error);
                }
                let cta = FormattedCtaBlock::new(&self.name, cta.as_ref());
                let text = js::stringify(&Value::Array(items));
                let mut out = Map::new();
                let text = match &cta {
                    Some(cta) => {
                        out.insert("_meta".into(), json!({ "cta": cta.to_value() }));
                        format!("{text}\n\n{}", cta.text())
                    }
                    None => text,
                };
                out.insert("content".into(), json!([{ "type": "text", "text": text }]));
                Value::Object(out)
            }
        }
    }

    /// Renders a failed command as a tool error.
    fn failure(&self, error: &Error) -> Value {
        let cta = FormattedCtaBlock::new(&self.name, error.cta.as_deref());
        let mut text = if error.field_errors.is_some() {
            js::stringify(&error.to_value())
        } else {
            error.message.clone()
        };
        if let Some(hint) = error.hint.as_ref().filter(|h| !h.is_empty()) {
            let _ = write!(text, "\nHint: {hint}");
        }
        if let Some(cta) = &cta {
            let _ = write!(text, "\n\n{}", cta.text());
        }
        let mut meta = Map::new();
        if let Some(cta) = &cta {
            meta.insert("cta".into(), cta.to_value());
        }
        let mut details = Map::new();
        details.insert("code".into(), error.code.clone().into());
        if let Some(code) = error.exit_code {
            details.insert("exitCode".into(), code.into());
        }
        if let Some(retryable) = error.retryable {
            details.insert("retryable".into(), retryable.into());
        }
        meta.insert("error".into(), details.into());
        json!({
            "_meta": meta,
            "content": [{ "type": "text", "text": text }],
            "isError": true,
        })
    }
}

/// Returns the field errors of an error as JSON.
fn error_fields(error: &Error) -> Option<Value> {
    error.to_value().get("fieldErrors").cloned()
}

/// What a tool call reports through.
struct Call<'a> {
    /// Sends notifications.
    notify: &'a mut (dyn FnMut(Value) + Send),
    /// The HTTP request.
    request: Option<Arc<http::request::Parts>>,
    /// The progress token.
    token: Option<Value>,
}

/// Reads a validated non-negative integer.
fn number(value: &Value) -> usize {
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .unwrap_or_default()
}

/// Validates tool arguments as the MCP SDK does, joining issues with `, `.
fn validate(ty: &Type, arguments: &Value) -> Result<Map<String, Value>, String> {
    let mut issues = Vec::new();
    let parsed = schema::parse(ty, Some(arguments), &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        return Ok(parsed
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default());
    }
    Err(issues
        .iter()
        .map(|issue| {
            if issue.path.is_empty() {
                issue.message.clone()
            } else {
                let path = issue.path.iter().map(js::to_string).collect::<Vec<_>>();
                format!("{}: {}", path.join("."), issue.message)
            }
        })
        .collect::<Vec<_>>()
        .join(", "))
}

/// Builds the result for invalid tool arguments.
fn input_error(name: &str, message: &str) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": format!("Input validation error: Invalid arguments for tool {name}: {message}"),
        }],
        "isError": true,
    })
}

/// Builds a JSON text result.
fn tool_result(value: &Value) -> Value {
    json!({ "content": [{ "type": "text", "text": js::stringify(value) }] })
}

/// Builds a JSON text error result.
fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": js::stringify(&json!({ "error": message })) }],
        "isError": true,
    })
}

/// Lowercases and replaces runs of other characters with a space.
fn normalize_search(value: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(ch);
        } else {
            gap = true;
        }
    }
    out
}

/// Scores a tool against a search query.
fn score(tool: &ToolEntry, query: &str, terms: &[&str]) -> u32 {
    let name = normalize_search(&tool.name);
    let description = normalize_search(tool.description.as_deref().unwrap_or_default());
    if name == query {
        return 1000;
    }
    let mut score = if name.starts_with(query) {
        100
    } else if name.contains(query) {
        50
    } else {
        0
    };
    for term in terms {
        if name.split(' ').any(|word| word == *term) {
            score += 20;
        } else if name.contains(term) {
            score += 10;
        }
        if description.contains(term) {
            score += 2;
        }
    }
    score
}

/// The catalog tools of progressive discovery.
#[derive(Clone, Copy, PartialEq)]
enum Catalog {
    /// `search_tools`.
    Search,
    /// `get_tool_details`.
    Details,
    /// `call_read_tool`.
    Read,
    /// `call_write_tool`.
    Write,
}

impl Catalog {
    /// Finds a catalog tool by name.
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "search_tools" => Some(Self::Search),
            "get_tool_details" => Some(Self::Details),
            "call_read_tool" => Some(Self::Read),
            "call_write_tool" => Some(Self::Write),
            _ => None,
        }
    }

    /// Validates arguments against the tool's schema.
    fn validate(self, arguments: &Value) -> Result<Map<String, Value>, String> {
        let int = |min: f64, max: Option<f64>, default: i64, description: &str| {
            Type::new(Kind::Integer {
                max,
                min: Some(min),
            })
            .default_value(default.into())
            .describe(description)
        };
        let name = Field::new(
            "name",
            <String as schema::Schema>::schema()
                .min(1.0)
                .describe("Exact tool name."),
        );
        match self {
            Self::Search => validate(
                &Type::object(vec![
                    Field::new("limit", int(1.0, Some(20.0), 5, "Maximum matches.")),
                    Field::new("offset", int(0.0, None, 0, "Matches to skip.")),
                    Field::new(
                        "query",
                        <String as schema::Schema>::schema()
                            .default_value("".into())
                            .describe("Capability to find. Empty lists all tools."),
                    ),
                ]),
                arguments,
            ),
            Self::Details => validate(&Type::object(vec![name]), arguments),
            Self::Read | Self::Write => {
                let record = arguments.get("arguments");
                let received = match record {
                    None | Some(Value::Object(_)) => None,
                    Some(Value::Array(_)) => Some("array"),
                    Some(Value::Bool(_)) => Some("boolean"),
                    Some(Value::Null) => Some("null"),
                    Some(Value::Number(_)) => Some("number"),
                    Some(Value::String(_)) => Some("string"),
                };
                let mut params = match validate(&Type::object(vec![name]), arguments) {
                    Ok(params) => params,
                    Err(message) => {
                        return Err(match received {
                            Some(received) => format!(
                                "{message}, arguments: Invalid input: expected record, received {received}"
                            ),
                            None => message,
                        });
                    }
                };
                if let Some(received) = received {
                    return Err(format!(
                        "arguments: Invalid input: expected record, received {received}"
                    ));
                }
                params.insert(
                    "arguments".into(),
                    record.cloned().unwrap_or_else(|| Value::Object(Map::new())),
                );
                Ok(params)
            }
        }
    }
}

/// The catalog tools as `tools/list` returns them.
fn catalog() -> Vec<Value> {
    let catalog = json!({ "destructiveHint": false, "idempotentHint": true, "openWorldHint": false, "readOnlyHint": true });
    let name = json!({ "type": "string", "minLength": 1, "description": "Exact tool name." });
    let call = json!({
        "type": "object",
        "$schema": DRAFT,
        "properties": {
            "name": name,
            "arguments": {
                "default": {},
                "description": "Arguments from its schema.",
                "type": "object",
                "propertyNames": { "type": "string" },
                "additionalProperties": {},
            },
        },
        "required": ["name"],
    });
    vec![
        json!({
            "name": "search_tools",
            "description": "Search or page through available tools by capability. Returns names and descriptions without loading their schemas. Inspect a result before calling it.",
            "inputSchema": {
                "type": "object",
                "$schema": DRAFT,
                "properties": {
                    "limit": { "default": 5, "description": "Maximum matches.", "type": "integer", "minimum": 1, "maximum": 20 },
                    "offset": { "default": 0, "description": "Matches to skip.", "type": "integer", "minimum": 0, "maximum": 9_007_199_254_740_991_u64 },
                    "query": { "default": "", "description": "Capability to find. Empty lists all tools.", "type": "string" },
                },
            },
            "annotations": catalog,
        }),
        json!({
            "name": "get_tool_details",
            "description": "Inspect one tool returned by search_tools. Returns its complete input schema and metadata.",
            "inputSchema": { "type": "object", "$schema": DRAFT, "properties": { "name": name }, "required": ["name"] },
            "annotations": catalog,
        }),
        json!({
            "name": "call_read_tool",
            "description": "Execute a tool marked read-only after inspecting its schema with get_tool_details.",
            "inputSchema": call,
            "annotations": { "destructiveHint": false, "idempotentHint": true, "openWorldHint": true, "readOnlyHint": true },
        }),
        json!({
            "name": "call_write_tool",
            "description": "Execute a writable or unclassified tool after inspecting its schema with get_tool_details.",
            "inputSchema": call,
            "annotations": { "destructiveHint": true, "idempotentHint": false, "openWorldHint": true, "readOnlyHint": false },
        }),
    ]
}
