//! OpenAPI: commands generated from an OpenAPI document's operations, and the OpenAPI document
//! of a CLI's own commands, served by [`Cli::fetch`](crate::Cli::fetch).

use std::fmt;
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::cli::{Entry, Generate, Group};
use crate::command::{self, Command, Outcome};
use crate::convert::Zod;
use crate::errors::Error;
use crate::fetch::{self, Fetch, Handler};
use crate::js;
use crate::mcp::Tool;
use crate::schema::{self, Field, Type};
use crate::url::{self, Url};

/// An OpenAPI document: parsed JSON, or a URL fetched through the CLI's HTTP client.
///
/// A relative URL resolves against the URL of a hosted [`Fetch`] source.
#[derive(Clone, Debug)]
pub enum Spec {
    /// A parsed document.
    Document(Value),
    /// The URL of a JSON document.
    Url(String),
}

impl From<Value> for Spec {
    fn from(document: Value) -> Self {
        Self::Document(document)
    }
}

impl From<&str> for Spec {
    fn from(url: &str) -> Self {
        Self::Url(url.to_owned())
    }
}

impl From<String> for Spec {
    fn from(url: String) -> Self {
        Self::Url(url)
    }
}

/// How generated commands are named.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Mode {
    /// One command per operation, named by its `operationId`.
    #[default]
    Operation,
    /// Commands nested by path segment, with the method as a leaf where needed.
    Namespace,
}

/// Which versions of path-versioned operations (`/v1/users`, `/v2/users`) generate commands.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Versions {
    /// Every version.
    #[default]
    All,
    /// Each operation's highest version, without the version segment in namespace names.
    Latest,
}

/// An operation offered to [`Openapi::include`].
#[derive(Clone, Debug)]
pub struct Operation<'a> {
    /// The lowercase HTTP method, such as `get`.
    pub method: &'a str,
    /// The path template, such as `/users/{id}`.
    pub path: &'a str,
    /// The operation object.
    pub operation: &'a Value,
}

/// A filter over operations.
type Include = Arc<dyn Fn(&Operation<'_>) -> bool + Send + Sync>;

/// Settings for commands generated from an OpenAPI document.
///
/// ```
/// use incur::openapi::{Mode, Openapi, Versions};
///
/// let config = Openapi::new()
///     .mode(Mode::Namespace)
///     .versions(Versions::Latest)
///     .group("pets", "Pet operations")
///     .include(|operation| operation.method != "delete");
/// ```
#[derive(Clone, Default)]
pub struct Openapi {
    /// Whether schemas drop examples, oversized patterns, and date formats.
    compact: bool,
    /// Inbound request headers copied onto upstream requests.
    forward_headers: Vec<String>,
    /// Group descriptions by command path.
    groups: Vec<(String, String)>,
    /// The operation filter.
    include: Option<Include>,
    /// The naming mode.
    mode: Mode,
    /// Whether security requirements generate credential options.
    no_security: bool,
    /// Which versions generate commands.
    versions: Versions,
}

impl fmt::Debug for Openapi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Openapi")
            .field("mode", &self.mode)
            .field("versions", &self.versions)
            .finish_non_exhaustive()
    }
}

impl Openapi {
    /// Creates default settings.
    pub fn new() -> Self {
        Self::default()
    }

    /// Strips `example(s)`, patterns over 100 characters, and date and time formats from
    /// generated schemas, shrinking MCP tool listings.
    #[must_use]
    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }

    /// Copies these headers from the inbound HTTP request onto upstream requests, unless set.
    #[must_use]
    pub fn forward_headers(mut self, names: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.forward_headers = names.into_iter().map(Into::into).collect();
        self
    }

    /// Describes a generated command group by its space-separated path.
    #[must_use]
    pub fn group(mut self, path: impl Into<String>, description: impl Into<String>) -> Self {
        self.groups.push((path.into(), description.into()));
        self
    }

    /// Generates commands only for operations the filter accepts.
    #[must_use]
    pub fn include<F>(mut self, f: F) -> Self
    where
        F: Fn(&Operation<'_>) -> bool + Send + Sync + 'static,
    {
        self.include = Some(Arc::new(f));
        self
    }

    /// Sets how commands are named.
    #[must_use]
    pub fn mode(mut self, mode: Mode) -> Self {
        self.mode = mode;
        self
    }

    /// Sets whether security requirements generate credential options. Defaults to `true`.
    #[must_use]
    pub fn security(mut self, enabled: bool) -> Self {
        self.no_security = !enabled;
        self
    }

    /// Sets which versions of path-versioned operations generate commands.
    #[must_use]
    pub fn versions(mut self, versions: Versions) -> Self {
        self.versions = versions;
        self
    }
}

/// Generates the commands of an OpenAPI document once, when first needed.
pub(crate) struct Generator {
    /// The document.
    spec: Spec,
    /// Settings.
    config: Openapi,
    /// Where requests go.
    fetch: Fetch,
    /// Prefix for request paths.
    base_path: Option<String>,
    /// The generated commands.
    cache: futures_util::lock::Mutex<Option<IndexMap<String, Entry>>>,
}

impl Generator {
    /// Creates a generator.
    pub(crate) fn new(
        spec: Spec,
        config: Openapi,
        fetch: Fetch,
        base_path: Option<String>,
    ) -> Self {
        Self {
            spec,
            config,
            fetch,
            base_path,
            cache: futures_util::lock::Mutex::new(None),
        }
    }

    /// Resolves the document.
    async fn document(&self, client: &Handler) -> Result<Value, Error> {
        let source = match &self.spec {
            Spec::Document(document) => return Ok(document.clone()),
            Spec::Url(source) => source,
        };
        let target = if let Some(url) = Url::parse(source) {
            url
        } else {
            let mut base = self.fetch.base().cloned().ok_or_else(|| {
                Error::unknown(format!(
                    "Relative OpenAPI spec URL requires a fetch URL base: {source}"
                ))
            })?;
            if !base.path.ends_with('/') {
                base.path.push('/');
            }
            base.join(source)
                .ok_or_else(|| Error::unknown(format!("Invalid URL: {source}")))?
        };
        let request = fetch::request("GET", &target, &[], None)?;
        let response = client(request).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::unknown(format!(
                "Failed to fetch OpenAPI spec from {source}: {}",
                status.as_u16()
            )));
        }
        let text = response.into_body().text().await;
        crate::js::json_parse(&text, |_| Value::Null).map_err(Error::unknown)
    }
}

impl Generate for Generator {
    fn lazy(&self) -> bool {
        false
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
            let document = self.document(client).await?;
            let commands = generate(
                &document,
                &self.config,
                &self.fetch,
                self.base_path.as_deref(),
                client,
            )?;
            *cache = Some(commands.clone());
            Ok(commands)
        })
    }
}

/// Resolves the local `$ref` pointers of a document. A reference cycle resolves to an empty
/// object.
///
/// # Errors
///
/// Fails like the reference when a pointer does not resolve.
fn dereference(root: &Value) -> Result<Value, Error> {
    fn walk(node: &Value, root: &Value, stack: &mut Vec<String>) -> Result<Value, Error> {
        Ok(match node {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|i| walk(i, root, stack))
                    .collect::<Result<_, _>>()?,
            ),
            Value::Object(map) => {
                if let Some(pointer) = map
                    .get("$ref")
                    .and_then(Value::as_str)
                    .filter(|r| r.starts_with('#'))
                {
                    if stack.iter().any(|p| p == pointer) {
                        return Ok(Value::Object(Map::new()));
                    }
                    let target = resolve_pointer(root, pointer)?;
                    stack.push(pointer.to_owned());
                    let out = walk(target, root, stack);
                    stack.pop();
                    return out;
                }
                Value::Object(
                    map.iter()
                        .map(|(key, value)| Ok((key.clone(), walk(value, root, stack)?)))
                        .collect::<Result<_, Error>>()?,
                )
            }
            other => other.clone(),
        })
    }
    walk(root, root, &mut Vec::new())
}

/// Resolves a JSON pointer such as `#/components/schemas/Pet`. `#` and `#/` name the root.
fn resolve_pointer<'a>(root: &'a Value, pointer: &str) -> Result<&'a Value, Error> {
    let fragment = &pointer[1..];
    let parts = fragment.get(1..).filter(|rest| !rest.is_empty());
    let mut current = root;
    for part in parts.into_iter().flat_map(|rest| rest.split('/')) {
        let part = part.replace("~1", "/").replace("~0", "~");
        let next = match current {
            Value::Object(map) => map.get(&part),
            Value::Array(items) => part
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index)),
            _ => {
                return Err(Error::unknown(format!(
                    "Cannot resolve $ref \"{pointer}\": path segment \"{part}\" not found"
                )));
            }
        };
        current = next.ok_or_else(|| {
            Error::unknown(format!(
                "Cannot resolve $ref \"{pointer}\": \"{part}\" not found"
            ))
        })?;
    }
    Ok(current)
}

/// An operation of the document.
#[derive(Clone)]
struct Op {
    /// The lowercase method.
    method: String,
    /// The operation object.
    operation: Value,
    /// The path template.
    path: String,
    /// The path that names the command.
    route: String,
}

/// HTTP methods OpenAPI path items hold.
const METHODS: [&str; 8] = [
    "delete", "get", "head", "options", "patch", "post", "put", "trace",
];

/// A header parameter with the option name it takes.
#[derive(Clone)]
struct Header {
    /// The header name.
    name: String,
    /// The option name.
    option: String,
    /// Whether it is required.
    required: bool,
    /// The description.
    description: Option<String>,
    /// The schema.
    schema: Option<Value>,
}

/// Generates commands from a document.
fn generate(
    document: &Value,
    config: &Openapi,
    fetch: &Fetch,
    base_path: Option<&str>,
    client: &Handler,
) -> Result<IndexMap<String, Entry>, Error> {
    let resolved = dereference(document)?;
    let mut operations = Vec::new();
    for (path, item) in resolved
        .get("paths")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        for (method, operation) in item.as_object().into_iter().flatten() {
            if !METHODS.contains(&method.as_str()) {
                continue;
            }
            let included = config.include.as_ref().is_none_or(|include| {
                include(&Operation {
                    method,
                    path,
                    operation,
                })
            });
            if included {
                operations.push(Op {
                    method: method.clone(),
                    operation: operation.clone(),
                    path: path.clone(),
                    route: path.clone(),
                });
            }
        }
    }
    if config.versions == Versions::Latest {
        operations = latest(operations);
    }
    let (parents, counts) = namespace_info(&operations);
    if config.compact {
        for op in &mut operations {
            compact_operation(&mut op.operation);
        }
    }
    let mut commands: IndexMap<String, Entry> = IndexMap::new();
    for op in &operations {
        let segments = command_segments(op, config.mode, &parents, &counts);
        let parameters = op
            .operation
            .get("parameters")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let located = |location: &str| {
            parameters
                .iter()
                .filter(|p| p.get("in").and_then(Value::as_str) == Some(location))
                .cloned()
                .collect::<Vec<_>>()
        };
        let path_params = located("path");
        let query_params = located("query");
        let mut header_params = located("header");
        if !config.no_security {
            header_params.extend(security_headers(&resolved, &op.operation));
        }
        let mut headers = Vec::new();
        for parameter in header_params {
            let name = text(&parameter, "name").unwrap_or_default();
            let normalized = name.to_lowercase();
            if headers.iter().any(|h: &Header| h.option == normalized) {
                continue;
            }
            headers.push(Header {
                name,
                option: normalized,
                required: parameter.get("required") == Some(&Value::Bool(true)),
                description: text(&parameter, "description"),
                schema: parameter.get("schema").cloned(),
            });
        }
        let (body_props, body_required) = op
            .operation
            .pointer("/requestBody/content/application~1json/schema")
            .map(body_fields)
            .unwrap_or_default();
        let mut used = query_params
            .iter()
            .filter_map(|p| text(p, "name"))
            .chain(body_props.keys().cloned())
            .collect::<Vec<_>>();
        for header in &mut headers {
            header.option = header_option(&header.option, &used);
            used.push(header.option.clone());
        }

        let args = (!path_params.is_empty()).then(|| {
            Type::object(
                path_params
                    .iter()
                    .map(|p| {
                        let mut zod = p.get("schema").map_or_else(
                            || Zod::from_json(&json!({ "type": "string" })),
                            Zod::from_json,
                        );
                        if let Some(description) = text(p, "description") {
                            zod = zod.describe(&description);
                        }
                        Field::new(
                            text(p, "name").unwrap_or_default(),
                            zod.coerce().into_type(),
                        )
                    })
                    .collect(),
            )
        });
        let mut options = Vec::new();
        for p in &query_params {
            let mut zod = p.get("schema").map_or_else(
                || Zod::from_json(&json!({ "type": "string" })),
                Zod::from_json,
            );
            if p.get("required") != Some(&Value::Bool(true)) {
                zod = zod.optional();
            }
            if let Some(description) = text(p, "description") {
                zod = zod.describe(&description);
            }
            options.push(Field::new(
                text(p, "name").unwrap_or_default(),
                zod.coerce().into_type(),
            ));
        }
        for (key, property) in &body_props {
            let mut zod = Zod::from_json(property);
            if !body_required.contains(key) {
                zod = zod.optional();
            }
            options.push(Field::new(key.clone(), zod.into_type()));
        }
        for header in &headers {
            let mut zod = header.schema.as_ref().map_or_else(
                || Zod::from_json(&json!({ "type": "string" })),
                Zod::from_json,
            );
            if !header.required {
                zod = zod.optional();
            }
            let description = header
                .description
                .clone()
                .unwrap_or_else(|| format!("{} header", header.name));
            zod = zod.describe(&description);
            options.push(Field::new(header.option.clone(), zod.coerce().into_type()));
        }

        let summary = text(&op.operation, "summary");
        let description = text(&op.operation, "description");
        let mut tool = Tool::new();
        tool.annotations = Some(annotations(&op.method));
        if let (Some(summary), Some(description)) = (&summary, &description)
            && summary != description
        {
            tool = tool.description(format!("{summary}\n\n{description}"));
        }
        let handler = Request {
            base_path: base_path.map(str::to_owned),
            body: body_props.keys().cloned().collect(),
            client: client.clone(),
            fetch: fetch.clone(),
            forward: config.forward_headers.clone(),
            headers: headers.clone(),
            method: op.method.to_uppercase(),
            path: op.path.clone(),
            path_params: path_params.iter().filter_map(|p| text(p, "name")).collect(),
            query: query_params
                .iter()
                .filter_map(|p| text(p, "name"))
                .collect(),
        };
        let mut command = Command::new();
        command.description = summary.or(description);
        command.args = args;
        command.options = (!options.is_empty()).then(|| Type::object(options));
        command.mcp = Some(tool);
        command.handler = Some(handler.into_handler());
        if let Some((head, tail)) = segments.split_first() {
            set_command(&mut commands, head, tail, command);
        }
    }
    for (path, description) in &config.groups {
        describe_group(&mut commands, path, description);
    }
    Ok(commands)
}

/// Reads a string field.
/// Flattens a request-body schema into option fields and the names every valid body must
/// include, merging `allOf` members and `anyOf`/`oneOf` object variants.
fn body_fields(schema: &Value) -> (Map<String, Value>, Vec<String>) {
    let Some(map) = schema.as_object() else {
        return Default::default();
    };
    let own = map
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let required = map
        .get("required")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut members = vec![(own, required)];
    if let Some(all) = map.get("allOf").and_then(Value::as_array) {
        members.extend(all.iter().map(body_fields));
    }
    for key in ["anyOf", "oneOf"] {
        let Some(list) = map.get(key).and_then(Value::as_array) else {
            continue;
        };
        let variants = list
            .iter()
            .filter(|v| object_variant(v))
            .map(|v| without_defaults(body_fields(v)))
            .collect::<Vec<_>>();
        let Some((_, first)) = variants.first() else {
            continue;
        };
        // Any one variant may be sent, so a field stays required only when every variant requires it.
        let required = first
            .iter()
            .filter(|name| variants.iter().all(|(_, r)| r.contains(name)))
            .cloned()
            .collect();
        members.push((merge_properties(&variants), required));
    }
    // Every member applies at once, so fields accumulate and any member's requirement holds.
    let mut required = Vec::new();
    for name in members.iter().flat_map(|(_, r)| r) {
        if !required.contains(name) {
            required.push(name.clone());
        }
    }
    (merge_properties(&members), required)
}

/// Drops field defaults from a union variant, which apply only when that variant is sent.
fn without_defaults(
    (mut properties, required): (Map<String, Value>, Vec<String>),
) -> (Map<String, Value>, Vec<String>) {
    for field in properties.values_mut().filter_map(Value::as_object_mut) {
        field.retain(|key, _| key != "default");
    }
    (properties, required)
}

/// Whether a union variant can be an object; others (e.g. a JSON-RPC batch array) carry no fields.
fn object_variant(schema: &Value) -> bool {
    schema.as_object().is_some_and(|map| match map.get("type") {
        None => true,
        Some(Value::Array(types)) => types.iter().any(|t| t == "object"),
        Some(t) => t == "object",
    })
}

/// Merges same-named fields in first-seen order. A field whose schemas differ keeps only the `type`
/// they share, so argv still coerces, and otherwise accepts any value. The server validates it
/// against the composed schema.
fn merge_properties(fields: &[(Map<String, Value>, Vec<String>)]) -> Map<String, Value> {
    let mut properties = Map::new();
    for (name, first) in fields.iter().flat_map(|(p, _)| p) {
        if properties.contains_key(name) {
            continue;
        }
        let schemas = fields
            .iter()
            .filter_map(|(p, _)| p.get(name))
            .collect::<Vec<_>>();
        let same = |key: &dyn Fn(&Value) -> Option<String>| {
            let first = key(first);
            first.is_some() && schemas.iter().all(|schema| key(schema) == first)
        };
        let merged = if same(&|schema| Some(js::stringify(schema))) {
            first.clone()
        } else if same(&|schema| schema_type(schema).map(|t| js::stringify(&t))) {
            json!({ "type": schema_type(first) })
        } else {
            json!({})
        };
        properties.insert(name.clone(), merged);
    }
    properties
}

/// A schema's `type`, or the JSON type of its `const` value when it declares none.
fn schema_type(schema: &Value) -> Option<Value> {
    if let Some(ty) = schema.get("type") {
        return Some(ty.clone());
    }
    match schema.get("const")? {
        Value::Bool(_) => Some("boolean".into()),
        Value::String(_) => Some("string".into()),
        Value::Number(_) => Some("number".into()),
        _ => None,
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// Returns MCP annotations for a method, in the reference's key order.
fn annotations(method: &str) -> Map<String, Value> {
    let read_only = matches!(method, "get" | "head" | "options" | "trace");
    let mut out = Map::new();
    out.insert("destructiveHint".into(), (!read_only).into());
    out.insert(
        "idempotentHint".into(),
        (read_only || method == "delete" || method == "put").into(),
    );
    out.insert("openWorldHint".into(), true.into());
    out.insert("readOnlyHint".into(), read_only.into());
    out
}

/// Keeps each operation's highest path version.
fn latest(operations: Vec<Op>) -> Vec<Op> {
    let mut latest: IndexMap<String, (Op, u64)> = IndexMap::new();
    for mut op in operations {
        let (version, route) = match version_prefix(&op.path) {
            Some((version, length)) => {
                let rest = &op.path[length..];
                (
                    version,
                    if rest.is_empty() {
                        "/".to_owned()
                    } else {
                        rest.to_owned()
                    },
                )
            }
            None => (0, op.path.clone()),
        };
        let shape = replace_params(&route);
        let key = format!("{} {shape}", op.method);
        op.route = route;
        match latest.get(&key) {
            Some((_, existing)) if version <= *existing => {}
            _ => {
                latest.insert(key, (op, version));
            }
        }
    }
    latest.into_values().map(|(op, _)| op).collect()
}

/// Reads a leading `/v<digits>` segment: its version and length.
fn version_prefix(path: &str) -> Option<(u64, usize)> {
    let rest = path.strip_prefix("/v")?;
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let after = &rest[digits..];
    if !(after.is_empty() || after.starts_with('/')) {
        return None;
    }
    Some((rest[..digits].parse().ok()?, 2 + digits))
}

/// Replaces `{name}` segments with `{}`.
fn replace_params(path: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for ch in path.chars() {
        match ch {
            '{' if !inside => {
                inside = true;
                out.push('{');
            }
            '}' if inside => {
                inside = false;
                out.push('}');
            }
            _ if inside => {}
            ch => out.push(ch),
        }
    }
    out
}

/// Returns the namespace segments of a route.
fn namespace_names(route: &str) -> Vec<String> {
    route
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|segment| segment_name(segment).0)
        .collect()
}

/// Returns the command name of a path segment and the parameter name it holds.
fn segment_name(segment: &str) -> (String, Option<&str>) {
    let (name, param) = match segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        Some(inner) => (inner, Some(inner)),
        None => (segment, None),
    };
    let mut out = String::new();
    let mut gap = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(ch);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('-');
    }
    (out, param)
}

/// Collects namespace parent paths and operation counts per route.
fn namespace_info(operations: &[Op]) -> (Vec<String>, IndexMap<String, usize>) {
    let mut parents = Vec::new();
    let mut counts = IndexMap::new();
    for op in operations {
        *counts.entry(op.route.clone()).or_insert(0) += 1;
        let names = namespace_names(&op.route);
        for i in 1..names.len() {
            let parent = format!("/{}", names[..i].join("/"));
            if !parents.contains(&parent) {
                parents.push(parent);
            }
        }
    }
    (parents, counts)
}

/// A command path segment with its group description.
struct Segment {
    /// The name.
    name: String,
    /// The description of the group it names.
    description: Option<String>,
}

/// Names the command of an operation.
fn command_segments(
    op: &Op,
    mode: Mode,
    parents: &[String],
    counts: &IndexMap<String, usize>,
) -> Vec<Segment> {
    if mode == Mode::Operation {
        let name = text(&op.operation, "operationId")
            .unwrap_or_else(|| format!("{}_{}", op.method, op.path.replace(['/', '{', '}'], "_")));
        return vec![Segment {
            name,
            description: None,
        }];
    }
    let parameters = op
        .operation
        .get("parameters")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut segments = op
        .route
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|segment| {
            let (name, param) = segment_name(segment);
            let description = param.and_then(|param| {
                parameters
                    .iter()
                    .find(|p| {
                        p.get("in").and_then(Value::as_str) == Some("path")
                            && p.get("name").and_then(Value::as_str) == Some(param)
                    })
                    .and_then(|p| text(p, "description"))
                    .filter(|d| !d.is_empty())
            });
            Segment { name, description }
        })
        .collect::<Vec<_>>();
    let path = format!("/{}", namespace_names(&op.route).join("/"));
    let needs_method = segments.is_empty()
        || parents.contains(&path)
        || counts.get(&op.route).copied().unwrap_or(0) > 1;
    let leaf = text(&op.operation, "summary")
        .or_else(|| text(&op.operation, "description"))
        .filter(|d| !d.is_empty());
    if let (Some(leaf), Some(last)) = (leaf, segments.last_mut())
        && last.description.is_none()
    {
        last.description = Some(leaf);
    }
    if segments.is_empty() {
        segments.push(Segment {
            name: "root".into(),
            description: None,
        });
    }
    if needs_method {
        segments.push(Segment {
            name: op.method.clone(),
            description: None,
        });
    }
    segments
}

/// Places a command at a path, creating groups.
fn set_command(
    commands: &mut IndexMap<String, Entry>,
    head: &Segment,
    tail: &[Segment],
    command: Command,
) {
    let Some((next, rest)) = tail.split_first() else {
        commands.insert(head.name.clone(), Entry::Command(command));
        return;
    };
    // Replacing an existing entry keeps its position.
    let mut group = match commands.get_mut(&head.name) {
        Some(Entry::Group(group)) => std::mem::take(group),
        _ => Group::default(),
    };
    if group.description.is_none() {
        group.description.clone_from(&head.description);
    }
    set_command(&mut group.commands, next, rest, command);
    commands.insert(head.name.clone(), Entry::Group(group));
}

/// Sets a group's description by path.
fn describe_group(commands: &mut IndexMap<String, Entry>, path: &str, description: &str) {
    let mut entries = commands;
    let names = path.split_whitespace().collect::<Vec<_>>();
    for (index, name) in names.iter().enumerate() {
        let Some(Entry::Group(group)) = entries.get_mut(*name) else {
            return;
        };
        if index == names.len() - 1 {
            group.description = Some(description.to_owned());
            return;
        }
        entries = &mut group.commands;
    }
}

/// Returns the credential headers an operation's security requirements name.
fn security_headers(document: &Value, operation: &Value) -> Vec<Value> {
    let schemes = document
        .pointer("/components/securitySchemes")
        .and_then(Value::as_object);
    let requirements = operation
        .get("security")
        .or_else(|| document.get("security"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for requirement in &requirements {
        for name in requirement
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, _)| k)
        {
            let Some(scheme) = schemes.and_then(|s| s.get(name)) else {
                continue;
            };
            let kind = scheme.get("type").and_then(Value::as_str);
            if kind == Some("apiKey")
                && scheme.get("in").and_then(Value::as_str) == Some("header")
                && let Some(header) = text(scheme, "name")
            {
                let description =
                    text(scheme, "description").unwrap_or_else(|| format!("{header} header"));
                out.push(json!({
                    "description": description,
                    "in": "header",
                    "name": header,
                    "required": false,
                    "schema": { "type": "string" },
                }));
            } else if kind == Some("http")
                && matches!(
                    scheme
                        .get("scheme")
                        .and_then(Value::as_str)
                        .map(str::to_lowercase)
                        .as_deref(),
                    Some("basic" | "bearer")
                )
            {
                let description = text(scheme, "description")
                    .unwrap_or_else(|| format!("{name} authorization header"));
                out.push(json!({
                    "description": description,
                    "in": "header",
                    "name": "authorization",
                    "required": false,
                    "schema": { "type": "string" },
                }));
            }
        }
    }
    out
}

/// Picks a free option name for a header.
fn header_option(option: &str, used: &[String]) -> String {
    if !used.iter().any(|u| u == option) {
        return option.to_owned();
    }
    let prefix = format!("header-{option}");
    if !used.contains(&prefix) {
        return prefix;
    }
    (2..=used.len() + 2)
        .map(|index| format!("{prefix}-{index}"))
        .find(|candidate| !used.contains(candidate))
        .unwrap_or(prefix)
}

/// Strips examples, oversized patterns, and date formats from an operation's schemas.
fn compact_operation(operation: &mut Value) {
    if let Some(Value::Array(parameters)) = operation.get_mut("parameters") {
        for parameter in parameters {
            if let Some(schema) = parameter.get_mut("schema") {
                *schema = compact_schema(schema);
            }
        }
    }
    if let Some(schema) = operation.pointer_mut("/requestBody/content/application~1json/schema") {
        *schema = compact_schema(schema);
    }
}

/// Returns a schema without examples, oversized patterns, and date formats.
fn compact_schema(schema: &Value) -> Value {
    let Value::Object(map) = schema else {
        return schema.clone();
    };
    let mut out = map.clone();
    out.shift_remove("example");
    out.shift_remove("examples");
    if out
        .get("pattern")
        .and_then(Value::as_str)
        .is_some_and(|p| p.encode_utf16().count() > 100)
    {
        out.shift_remove("pattern");
    }
    if out
        .get("format")
        .and_then(Value::as_str)
        .is_some_and(|f| matches!(f, "date" | "date-time" | "duration" | "time"))
    {
        out.shift_remove("format");
    }
    for key in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(Value::Array(entries)) = out.get(key) {
            let kept = entries
                .iter()
                .map(compact_schema)
                .filter(|e| e.as_object().is_none_or(|m| !m.is_empty()))
                .collect::<Vec<_>>();
            if kept.is_empty() {
                out.shift_remove(key);
            } else {
                out.insert(key.into(), kept.into());
            }
        }
    }
    for key in [
        "additionalProperties",
        "contains",
        "items",
        "not",
        "propertyNames",
    ] {
        if let Some(value) = out.get(key).filter(|v| v.is_object()) {
            let compacted = compact_schema(value);
            out.insert(key.into(), compacted);
        }
    }
    for key in ["$defs", "patternProperties", "properties"] {
        if let Some(Value::Object(entries)) = out.get(key) {
            let compacted = entries
                .iter()
                .map(|(name, entry)| (name.clone(), compact_schema(entry)))
                .collect::<Map<_, _>>();
            out.insert(key.into(), Value::Object(compacted));
        }
    }
    Value::Object(out)
}

/// The request an operation command sends.
#[derive(Clone)]
struct Request {
    /// Prefix for request paths.
    base_path: Option<String>,
    /// Body property names.
    body: Vec<String>,
    /// The HTTP client.
    client: Handler,
    /// Where requests go.
    fetch: Fetch,
    /// Inbound headers to forward.
    forward: Vec<String>,
    /// Header parameters.
    headers: Vec<Header>,
    /// The uppercase method.
    method: String,
    /// The path template.
    path: String,
    /// Path parameter names.
    path_params: Vec<String>,
    /// Query parameter names.
    query: Vec<String>,
}

impl Request {
    /// Returns the command handler.
    fn into_handler(self) -> command::Handler {
        let request = Arc::new(self);
        Arc::new(move |invocation| {
            let request = request.clone();
            Box::pin(async move {
                match request.send(&invocation).await {
                    Ok(outcome) => outcome,
                    Err(error) => Outcome::from(error),
                }
            })
        })
    }

    /// Sends the request and returns the response data or error.
    async fn send(&self, invocation: &command::Invocation) -> Result<Outcome, Error> {
        let empty = Map::new();
        let args = invocation.args.as_object().unwrap_or(&empty);
        let options = invocation.options.as_object().unwrap_or(&empty);
        let mut path = format!("{}{}", self.base_path.as_deref().unwrap_or(""), self.path);
        for name in &self.path_params {
            if let Some(value) = args.get(name) {
                path = path.replacen(&format!("{{{name}}}"), &crate::js::to_string(value), 1);
            }
        }
        let mut query = Vec::new();
        for name in &self.query {
            if let Some(value) = options.get(name) {
                fetch::set(&mut query, name, &crate::js::to_string(value));
            }
        }
        let body = self
            .body
            .iter()
            .filter_map(|key| options.get(key).map(|value| (key.clone(), value.clone())))
            .collect::<Map<_, _>>();
        let body = (!body.is_empty()).then(|| crate::js::stringify(&Value::Object(body)));
        let mut headers = Vec::new();
        for header in &self.headers {
            if let Some(value) = options.get(&header.option) {
                fetch::set(
                    &mut headers,
                    &header.name.to_lowercase(),
                    &crate::js::to_string(value),
                );
            }
        }
        if let Some(request) = &invocation.request {
            for name in &self.forward {
                let lower = name.to_lowercase();
                if headers.iter().any(|(k, _)| *k == lower) {
                    continue;
                }
                if let Some(value) = request.headers.get(&lower).and_then(|v| v.to_str().ok()) {
                    headers.push((lower, value.to_owned()));
                }
            }
        }
        if body.is_some() && !headers.iter().any(|(k, _)| k == "content-type") {
            headers.push(("content-type".into(), "application/json".into()));
        }
        let input = fetch::Input {
            body,
            headers,
            method: self.method.clone(),
            path,
            query,
        };
        let response = self
            .fetch
            .send(fetch::build_request(input)?, &self.client)
            .await?;
        let status = response.status();
        let data = fetch::json_or_text(&response.into_body().text().await);
        if status.is_success() {
            Ok(command::ok(data))
        } else {
            Ok(Outcome::from(fetch::parse_error(&data, status.as_u16())))
        }
    }
}

/// Builds the OpenAPI 3.2 document of a command tree, as `Openapi.fromCli` does.
///
/// Nodes the document shares between operations, as the TypeScript document shares objects,
/// are wrapped in markers: [`plain`] removes them, and [`anchors`] turns repeats into YAML
/// aliases.
pub(crate) fn from_cli(
    name: &str,
    description: Option<&str>,
    version: Option<&str>,
    root: Option<&Command>,
    commands: &IndexMap<String, Entry>,
    globals: Option<&Type>,
) -> Value {
    let mut paths = Map::new();
    let mut ids = 0;
    if let Some(root) = root {
        add_command(&mut paths, &[], root, globals, &mut ids);
    }
    add_entries(&mut paths, &[], commands, globals, &mut ids);
    let mut info = Map::new();
    info.insert("title".into(), name.into());
    info.insert("version".into(), version.unwrap_or("0.0.0").into());
    if let Some(description) = description.filter(|d| !d.is_empty()) {
        info.insert("description".into(), description.into());
    }
    json!({ "openapi": "3.2.0", "info": info, "paths": paths })
}

/// Adds the commands of a group.
fn add_entries(
    paths: &mut Map<String, Value>,
    prefix: &[String],
    commands: &IndexMap<String, Entry>,
    globals: Option<&Type>,
    ids: &mut u64,
) {
    for (name, entry) in commands {
        let mut segments = prefix.to_vec();
        segments.extend(name.split_whitespace().map(str::to_owned));
        match entry {
            Entry::Alias(_) | Entry::Fetch(_) => {}
            Entry::Command(command) => add_command(paths, &segments, command, globals, ids),
            Entry::Group(group) => {
                if let Some(root) = &group.root {
                    add_command(paths, &segments, root, globals, ids);
                }
                add_entries(paths, &segments, &group.commands, globals, ids);
            }
        }
    }
}

/// Infers the HTTP method of a command from its path words.
fn infer_method(segments: &[String]) -> &'static str {
    let mut words = Vec::new();
    for segment in segments {
        let mut word = String::new();
        let mut previous: Option<char> = None;
        for ch in segment.chars() {
            if ch.is_ascii_uppercase()
                && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
            {
                words.push(std::mem::take(&mut word).to_lowercase());
            }
            word.push(ch);
            previous = Some(ch);
        }
        words.push(word.to_lowercase());
    }
    let text = words.join(" ");
    let tokens = text
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>();
    let any = |list: &[&str]| tokens.iter().any(|t| list.contains(t));
    if any(&["delete", "remove", "rm", "destroy", "clear"]) {
        "delete"
    } else if any(&[
        "update", "edit", "modify", "set", "enable", "disable", "rename", "patch",
    ]) {
        "patch"
    } else if any(&[
        "get", "list", "show", "read", "search", "find", "status", "describe", "info", "health",
        "check",
    ]) {
        "get"
    } else {
        "post"
    }
}

/// Adds the operations of a command: one per path variant of its optional arguments.
fn add_command(
    paths: &mut Map<String, Value>,
    segments: &[String],
    command: &Command,
    globals: Option<&Type>,
    ids: &mut u64,
) {
    let mut share = |value: Value| {
        *ids += 1;
        json!({ SHARED: *ids, "value": value })
    };
    let options = match (&command.options, globals) {
        (Some(options), Some(globals)) => {
            let mut fields = options.fields().to_vec();
            for field in globals.fields() {
                match fields.iter_mut().find(|f| f.name == field.name) {
                    Some(existing) => *existing = field.clone(),
                    None => fields.push(field.clone()),
                }
            }
            Some(Type::object(fields))
        }
        (None, Some(globals)) => Some(globals.clone()),
        (options, None) => options.clone(),
    };
    let args_schema = command.args.as_ref().map(schema::json_schema);
    let options_schema = options.as_ref().map(schema::json_schema);
    let output_schema = command
        .output
        .as_ref()
        .map(schema::json_schema)
        .map(&mut share);
    let props = |schema: Option<&Value>| {
        schema
            .and_then(|s| s.get("properties"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let required = |schema: Option<&Value>| {
        schema
            .and_then(|s| s.get("required"))
            .and_then(Value::as_array)
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let args = props(args_schema.as_ref())
        .into_iter()
        .map(|(k, v)| (k, share(v)))
        .collect::<Map<_, _>>();
    let required_args = required(args_schema.as_ref());
    let method = infer_method(segments);
    let names = args.keys().cloned().collect::<Vec<_>>();
    let base = names
        .iter()
        .position(|n| !required_args.contains(n))
        .unwrap_or(names.len());
    let mut variants = Vec::new();
    for count in base..=names.len() {
        let included = names[..count].to_vec();
        let parts = segments
            .iter()
            .map(|s| url::encode_component(s))
            .chain(included.iter().map(|n| format!("{{{n}}}")))
            .collect::<Vec<_>>();
        variants.push((included, format!("/{}", parts.join("/"))));
    }
    let option_props = props(options_schema.as_ref())
        .into_iter()
        .map(|(k, v)| (k, share(v)))
        .collect::<Map<_, _>>();
    let shared_options = options_schema.clone().map(&mut share);
    let option_required = required(options_schema.as_ref());
    for (included, path) in variants {
        let mut parameters = Vec::new();
        for name in &included {
            let schema = args
                .get(name)
                .cloned()
                .unwrap_or_else(|| json!({ "type": "string" }));
            parameters
                .push(json!({ "name": name, "in": "path", "required": true, "schema": schema }));
        }
        if method == "get" || method == "delete" {
            for (name, schema) in &option_props {
                let mut parameter = Map::new();
                parameter.insert("name".into(), name.clone().into());
                parameter.insert("in".into(), "query".into());
                if option_required.contains(name) {
                    parameter.insert("required".into(), true.into());
                }
                parameter.insert("schema".into(), schema.clone());
                parameters.push(Value::Object(parameter));
            }
        }
        let mut operation = Map::new();
        let raw = segments
            .iter()
            .cloned()
            .chain((!included.is_empty()).then(|| included.join(" ")))
            .collect::<Vec<_>>()
            .join(" ");
        operation.insert(
            "operationId".into(),
            format!("{method}{}", pascal(&raw)).into(),
        );
        if let Some(description) = command.description.as_ref().filter(|d| !d.is_empty()) {
            operation.insert("summary".into(), description.clone().into());
        }
        if !parameters.is_empty() {
            operation.insert("parameters".into(), parameters.into());
        }
        if let Some(schema) = shared_options
            .as_ref()
            .filter(|_| method != "get" && method != "delete")
        {
            operation.insert(
                "requestBody".into(),
                json!({
                    "required": !option_required.is_empty(),
                    "content": { "application/json": { "schema": schema } },
                }),
            );
        }
        operation.insert("responses".into(), responses(output_schema.as_ref()));
        let item = paths
            .entry(path)
            .or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(item) = item {
            item.insert(method.into(), Value::Object(operation));
        }
    }
}

/// The marker key of a shared node.
const SHARED: &str = "\u{0}shared";

/// Removes shared-node markers.
pub(crate) fn plain(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(plain).collect()),
        Value::Object(mut map) => {
            if map.contains_key(SHARED) {
                return plain(map.shift_remove("value").unwrap_or(Value::Null));
            }
            Value::Object(map.into_iter().map(|(k, v)| (k, plain(v))).collect())
        }
        other => other,
    }
}

/// Replaces shared nodes with YAML anchors at their first occurrence and aliases at repeats,
/// named `a1`, `a2`, … in the order repeats appear, as the `yaml` package does.
pub(crate) fn anchors(value: Value) -> Value {
    fn count(value: &Value, seen: &mut Vec<u64>, names: &mut IndexMap<u64, String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|i| count(i, seen, names)),
            Value::Object(map) => {
                if let Some(id) = map.get(SHARED).and_then(Value::as_u64) {
                    if seen.contains(&id) {
                        if !names.contains_key(&id) {
                            let name = format!("a{}", names.len() + 1);
                            names.insert(id, name);
                        }
                        return;
                    }
                    seen.push(id);
                    if let Some(inner) = map.get("value") {
                        count(inner, seen, names);
                    }
                    return;
                }
                map.values().for_each(|v| count(v, seen, names));
            }
            _ => {}
        }
    }
    fn replace(value: Value, names: &IndexMap<u64, String>, done: &mut Vec<u64>) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|i| replace(i, names, done)).collect())
            }
            Value::Object(mut map) => {
                if let Some(id) = map.get(SHARED).and_then(Value::as_u64) {
                    let inner = replace(
                        map.shift_remove("value").unwrap_or(Value::Null),
                        names,
                        done,
                    );
                    let Some(name) = names.get(&id) else {
                        return inner;
                    };
                    if done.contains(&id) {
                        return json!({ crate::yaml::ALIAS: name });
                    }
                    done.push(id);
                    let mut out = Map::new();
                    out.insert(crate::yaml::ANCHOR.into(), name.clone().into());
                    out.insert("value".into(), inner);
                    return Value::Object(out);
                }
                Value::Object(
                    map.into_iter()
                        .map(|(k, v)| (k, replace(v, names, done)))
                        .collect(),
                )
            }
            other => other,
        }
    }
    let mut names = IndexMap::new();
    count(&value, &mut Vec::new(), &mut names);
    replace(value, &names, &mut Vec::new())
}

/// Converts words to `PascalCase`, as `operationId` does: the first word character after the
/// start or a run of spaces, underscores, or hyphens is uppercased.
fn pascal(raw: &str) -> String {
    let mut out = String::new();
    let mut run = String::new();
    let mut start = true;
    for ch in raw.chars() {
        if ch.is_whitespace() || ch == '_' || ch == '-' {
            run.push(ch);
            continue;
        }
        let word = ch.is_ascii_alphanumeric() || ch == '_';
        if word && (start || !run.is_empty()) {
            out.extend(ch.to_uppercase());
        } else {
            out.push_str(&run);
            out.push(ch);
        }
        run.clear();
        start = false;
    }
    out.push_str(&run);
    out
}

/// Returns the responses of an operation.
fn responses(output: Option<&Value>) -> Value {
    let meta = json!({
        "type": "object",
        "required": ["command", "duration"],
        "properties": { "command": { "type": "string" }, "duration": { "type": "string" } },
    });
    let error = |description: &str| {
        json!({
            "description": description,
            "content": { "application/json": { "schema": {
                "type": "object",
                "required": ["ok", "error", "meta"],
                "properties": {
                    "ok": { "const": false },
                    "error": {
                        "type": "object",
                        "required": ["code", "message"],
                        "properties": {
                            "code": { "type": "string" },
                            "message": { "type": "string" },
                            "hint": { "type": "string" },
                            "retryable": { "type": "boolean" },
                        },
                    },
                    "meta": meta,
                },
            } } },
        })
    };
    json!({
        "200": {
            "description": "Command completed successfully.",
            "content": { "application/json": { "schema": {
                "type": "object",
                "required": ["ok", "data", "meta"],
                "properties": {
                    "ok": { "const": true },
                    "data": output.cloned().unwrap_or_else(|| json!({})),
                    "meta": meta,
                },
            } } },
        },
        "400": error("Validation error."),
        "500": error("Command failed."),
    })
}
