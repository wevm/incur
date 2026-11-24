//! MCP resources, resource templates, prompts, and completion, served next to tools.

use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

use crate::mcp::Icon;
use crate::schema::{Kind, Type};

/// Suggests values for a prompt argument or template variable from its partial value and the
/// values already chosen. Clients receive the first 100.
pub type Completer = Arc<dyn Fn(&str, &IndexMap<String, String>) -> Vec<String> + Send + Sync>;

/// Reads a resource: text, one set of contents, or a list of them. Contents are objects as MCP
/// spells them, with `text` or base64 `blob`; `uri` defaults to the URI read and `mimeType` to
/// the resource's.
type Read = Arc<dyn Fn() -> Value + Send + Sync>;

/// Reads a URI matching a template, given the URI and its variables.
type ReadMatch = Arc<dyn Fn(&str, &IndexMap<String, String>) -> Value + Send + Sync>;

/// Renders a prompt from its validated arguments: text becomes one user message, and an array
/// holds messages as MCP spells them.
type Render = Arc<dyn Fn(&Map<String, Value>) -> Value + Send + Sync>;

/// The display fields every feature shares.
#[derive(Clone, Default)]
struct Display {
    title: Option<String>,
    description: Option<String>,
    icons: Option<Vec<Icon>>,
}

impl Display {
    /// Writes the title and description, when non-empty.
    fn describe(&self, out: &mut Map<String, Value>) {
        for (key, value) in [("title", &self.title), ("description", &self.description)] {
            if let Some(value) = value.as_ref().filter(|value| !value.is_empty()) {
                out.insert(key.into(), value.clone().into());
            }
        }
    }

    /// Writes the icons, when set.
    fn icons(&self, out: &mut Map<String, Value>) {
        if let Some(icons) = &self.icons {
            out.insert("icons".into(), icons.iter().map(Icon::to_json).collect());
        }
    }
}

macro_rules! display_setters {
    () => {
        /// Sets the human-readable title.
        #[must_use]
        pub fn title(mut self, title: impl Into<String>) -> Self {
            self.display.title = Some(title.into());
            self
        }

        /// Sets the description.
        #[must_use]
        pub fn description(mut self, description: impl Into<String>) -> Self {
            self.display.description = Some(description.into());
            self
        }

        /// Sets icons clients may show.
        #[must_use]
        pub fn icons(mut self, icons: impl IntoIterator<Item = Icon>) -> Self {
            self.display.icons = Some(icons.into_iter().collect());
            self
        }
    };
}

/// A resource at a fixed URI.
///
/// ```
/// use incur::mcp::Resource;
/// use serde_json::json;
///
/// let readme = Resource::new("kb://readme", "readme", || json!("# Read me")).mime_type("text/markdown");
/// ```
#[derive(Clone)]
pub struct Resource {
    uri: String,
    name: String,
    mime_type: Option<String>,
    display: Display,
    read: Read,
}

impl Resource {
    /// Creates a resource clients read at `uri`, matched exactly.
    pub fn new(
        uri: impl Into<String>,
        name: impl Into<String>,
        read: impl Fn() -> Value + Send + Sync + 'static,
    ) -> Self {
        Self {
            uri: uri.into(),
            name: name.into(),
            mime_type: None,
            display: Display::default(),
            read: Arc::new(read),
        }
    }

    /// Sets the MIME type of the contents.
    #[must_use]
    pub fn mime_type(mut self, mime_type: impl Into<String>) -> Self {
        self.mime_type = Some(mime_type.into());
        self
    }

    display_setters!();
}

/// External origins an MCP App may reach, as hosts map them to Content Security Policy
/// directives.
#[derive(Clone, Debug, Default)]
pub struct AppCsp {
    /// Origins for fetch, XHR, and WebSocket connections (`connect-src`).
    pub connect_domains: Option<Vec<String>>,
    /// Origins for scripts, styles, images, fonts, and media.
    pub resource_domains: Option<Vec<String>>,
    /// Origins for nested iframes (`frame-src`).
    pub frame_domains: Option<Vec<String>>,
    /// Allowed document base URIs (`base-uri`).
    pub base_uri_domains: Option<Vec<String>>,
}

/// An MCP App: an HTML view hosts render for the tools that link to it with
/// [`Tool::app`](crate::mcp::Tool::app). It is listed and read as a resource after the others.
///
/// ```
/// use incur::mcp::App;
///
/// let dashboard = App::new("ui://weather/dashboard", "dashboard", "<!doctype html>").prefers_border(true);
/// ```
#[derive(Clone, Debug)]
pub struct App {
    uri: String,
    name: String,
    html: String,
    title: Option<String>,
    description: Option<String>,
    csp: Option<AppCsp>,
    prefers_border: Option<bool>,
}

impl App {
    /// Creates an app whose view hosts read at the `ui://` URI `uri`.
    pub fn new(uri: impl Into<String>, name: impl Into<String>, html: impl Into<String>) -> Self {
        Self {
            uri: uri.into(),
            name: name.into(),
            html: html.into(),
            title: None,
            description: None,
            csp: None,
            prefers_border: None,
        }
    }

    /// Sets the human-readable title.
    #[must_use]
    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets the external origins the view may reach. Hosts block every other origin.
    #[must_use]
    pub fn csp(mut self, csp: AppCsp) -> Self {
        self.csp = Some(csp);
        self
    }

    /// Sets whether the host draws a border and background around the view. Hosts decide when
    /// unset.
    #[must_use]
    pub fn prefers_border(mut self, prefers_border: bool) -> Self {
        self.prefers_border = Some(prefers_border);
        self
    }

    /// The app's name, which tools link to.
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// The app's URI.
    pub(crate) fn uri(&self) -> &str {
        &self.uri
    }

    /// Lists and reads the app as a resource whose contents carry its hints in `_meta.ui`.
    ///
    /// # Errors
    ///
    /// Returns a message when the URI is not a `ui://` URI.
    fn resource(&self) -> Result<Resource, String> {
        if !self.uri.starts_with("ui://") {
            return Err(format!(
                "MCP app \"{}\" needs a ui:// URI, got \"{}\".",
                self.name, self.uri
            ));
        }
        let mut ui = Map::new();
        if let Some(csp) = &self.csp {
            let domains = [
                ("connectDomains", &csp.connect_domains),
                ("resourceDomains", &csp.resource_domains),
                ("frameDomains", &csp.frame_domains),
                ("baseUriDomains", &csp.base_uri_domains),
            ];
            let csp: Map<String, Value> = domains
                .into_iter()
                .filter_map(|(key, value)| value.as_ref().map(|value| (key.into(), json!(value))))
                .collect();
            ui.insert("csp".into(), csp.into());
        }
        if let Some(prefers_border) = self.prefers_border {
            ui.insert("prefersBorder".into(), prefers_border.into());
        }
        let mut contents = Map::new();
        contents.insert("text".into(), self.html.clone().into());
        if !ui.is_empty() {
            contents.insert("_meta".into(), json!({ "ui": ui }));
        }
        let contents = Value::Object(contents);
        Ok(Resource {
            uri: self.uri.clone(),
            name: self.name.clone(),
            mime_type: Some("text/html;profile=mcp-app".into()),
            display: Display {
                title: self.title.clone(),
                description: self.description.clone(),
                icons: None,
            },
            read: Arc::new(move || contents.clone()),
        })
    }
}

/// Resources whose URIs match a template such as `docs://{section}/{page}`. Templates support
/// `{name}` expressions, which match one or more characters other than `/` and `,`.
#[derive(Clone)]
pub struct ResourceTemplate {
    uri_template: String,
    name: String,
    mime_type: Option<String>,
    display: Display,
    complete: IndexMap<String, Completer>,
    read: ReadMatch,
}

impl ResourceTemplate {
    /// Creates a template whose matching URIs `read` answers.
    pub fn new(
        uri_template: impl Into<String>,
        name: impl Into<String>,
        read: impl Fn(&str, &IndexMap<String, String>) -> Value + Send + Sync + 'static,
    ) -> Self {
        Self {
            uri_template: uri_template.into(),
            name: name.into(),
            mime_type: None,
            display: Display::default(),
            complete: IndexMap::new(),
            read: Arc::new(read),
        }
    }

    /// Sets the MIME type of the contents.
    #[must_use]
    pub fn mime_type(mut self, mime_type: impl Into<String>) -> Self {
        self.mime_type = Some(mime_type.into());
        self
    }

    /// Completes a template variable.
    #[must_use]
    pub fn complete(
        mut self,
        variable: impl Into<String>,
        completer: impl Fn(&str, &IndexMap<String, String>) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        self.complete.insert(variable.into(), Arc::new(completer));
        self
    }

    display_setters!();
}

/// A prompt template clients can list and render.
#[derive(Clone)]
pub struct Prompt {
    name: String,
    display: Display,
    args: Option<Type>,
    complete: IndexMap<String, Completer>,
    get: Render,
}

impl Prompt {
    /// Creates a prompt. `get` receives the arguments, validated against [`Prompt::args`] when
    /// set.
    pub fn new(
        name: impl Into<String>,
        get: impl Fn(&Map<String, Value>) -> Value + Send + Sync + 'static,
    ) -> Self {
        Self {
            name: name.into(),
            display: Display::default(),
            args: None,
            complete: IndexMap::new(),
            get: Arc::new(get),
        }
    }

    /// Sets the arguments schema, such as `Args::schema()` for a struct deriving `Schema`.
    /// Clients send every argument as a string.
    #[must_use]
    pub fn args(mut self, args: Type) -> Self {
        self.args = Some(args);
        self
    }

    /// Completes an argument.
    #[must_use]
    pub fn complete(
        mut self,
        argument: impl Into<String>,
        completer: impl Fn(&str, &IndexMap<String, String>) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        self.complete.insert(argument.into(), Arc::new(completer));
        self
    }

    display_setters!();
}

/// A JSON-RPC error: code, message, and data.
pub(crate) type RpcError = (i64, String, Option<Value>);

/// The resources, templates, and prompts of one server.
#[derive(Clone, Default)]
pub(crate) struct Features {
    resources: Vec<Resource>,
    templates: Vec<(ResourceTemplate, Vec<String>, regex_lite::Regex)>,
    prompts: Vec<Prompt>,
}

impl Features {
    /// Compiles the features.
    ///
    /// # Errors
    ///
    /// Returns a message for an app without a `ui://` URI, or a template with other expressions
    /// or stray braces.
    pub(crate) fn new(
        resources: &[Resource],
        templates: &[ResourceTemplate],
        prompts: &[Prompt],
        apps: &[App],
    ) -> Result<Self, String> {
        let mut resources = resources.to_vec();
        for app in apps {
            resources.push(app.resource()?);
        }
        let templates = templates
            .iter()
            .map(|template| {
                let (names, regex) = pattern(&template.uri_template)?;
                Ok((template.clone(), names, regex))
            })
            .collect::<Result<_, String>>()?;
        Ok(Self {
            resources,
            templates,
            prompts: prompts.to_vec(),
        })
    }

    /// The capabilities features add after `tools`.
    pub(crate) fn capabilities(&self, out: &mut Map<String, Value>) {
        let resources = !self.resources.is_empty() || !self.templates.is_empty();
        if resources {
            out.insert("resources".into(), json!({ "listChanged": true }));
        }
        if !self.prompts.is_empty() {
            out.insert("prompts".into(), json!({ "listChanged": true }));
        }
        if !self.prompts.is_empty() || !self.templates.is_empty() {
            out.insert("completions".into(), json!({}));
        }
    }

    /// Whether a configured feature answers a method.
    pub(crate) fn handles(&self, method: &str) -> bool {
        let resources = !self.resources.is_empty() || !self.templates.is_empty();
        match method {
            "resources/list" | "resources/templates/list" | "resources/read" => resources,
            "prompts/list" | "prompts/get" => !self.prompts.is_empty(),
            "completion/complete" => !self.prompts.is_empty() || !self.templates.is_empty(),
            _ => false,
        }
    }

    /// Answers a feature request.
    pub(crate) fn answer(
        &self,
        method: &str,
        params: &Map<String, Value>,
    ) -> Result<Value, RpcError> {
        match method {
            "resources/list" => Ok(json!({ "resources": self.resources.iter().map(|resource| {
                let mut out = Map::new();
                out.insert("uri".into(), resource.uri.clone().into());
                out.insert("name".into(), resource.name.clone().into());
                resource.display.describe(&mut out);
                if let Some(mime_type) = resource.mime_type.as_ref().filter(|m| !m.is_empty()) {
                    out.insert("mimeType".into(), mime_type.clone().into());
                }
                resource.display.icons(&mut out);
                Value::Object(out)
            }).collect::<Vec<_>>() })),
            "resources/templates/list" => Ok(
                json!({ "resourceTemplates": self.templates.iter().map(|(template, _, _)| {
                let mut out = Map::new();
                out.insert("uriTemplate".into(), template.uri_template.clone().into());
                out.insert("name".into(), template.name.clone().into());
                template.display.describe(&mut out);
                if let Some(mime_type) = template.mime_type.as_ref().filter(|m| !m.is_empty()) {
                    out.insert("mimeType".into(), mime_type.clone().into());
                }
                template.display.icons(&mut out);
                Value::Object(out)
            }).collect::<Vec<_>>() }),
            ),
            "resources/read" => self.read(
                params
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            ),
            "prompts/list" => {
                Ok(json!({ "prompts": self.prompts.iter().map(prompt_entry).collect::<Vec<_>>() }))
            }
            "prompts/get" => self.get(params),
            _ => self.complete(params),
        }
    }

    /// Answers `resources/read`.
    fn read(&self, uri: &str) -> Result<Value, RpcError> {
        if let Some(resource) = self.resources.iter().find(|r| r.uri == uri) {
            let read = (resource.read)();
            return Ok(json!({ "contents": contents(read, uri, resource.mime_type.as_deref()) }));
        }
        for (template, names, regex) in &self.templates {
            if let Some(captures) = regex.captures(uri) {
                let variables = names
                    .iter()
                    .zip(captures.iter().skip(1))
                    .map(|(name, value)| {
                        (name.clone(), value.map_or("", |m| m.as_str()).to_owned())
                    })
                    .collect();
                let read = (template.read)(uri, &variables);
                return Ok(
                    json!({ "contents": contents(read, uri, template.mime_type.as_deref()) }),
                );
            }
        }
        Err((
            -32602,
            format!("Resource not found: {uri}"),
            Some(json!({ "uri": uri })),
        ))
    }

    /// Answers `prompts/get`.
    fn get(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(prompt) = self.prompts.iter().find(|p| p.name == name) else {
            return Err((-32602, format!("Prompt {name} not found"), None));
        };
        let raw = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let args = match &prompt.args {
            Some(ty) => crate::mcp::validate(ty, &raw).map_err(|issues| {
                (
                    -32602,
                    format!("Invalid arguments for prompt {name}: {issues}"),
                    None,
                )
            })?,
            None => raw.as_object().cloned().unwrap_or_default(),
        };
        let rendered = (prompt.get)(&args);
        let mut out = Map::new();
        if let Some(description) = prompt
            .display
            .description
            .as_ref()
            .filter(|d| !d.is_empty())
        {
            out.insert("description".into(), description.clone().into());
        }
        let messages = match rendered {
            Value::String(text) => {
                json!([{ "role": "user", "content": { "type": "text", "text": text } }])
            }
            other => other,
        };
        out.insert("messages".into(), messages);
        Ok(Value::Object(out))
    }

    /// Answers `completion/complete`.
    fn complete(&self, params: &Map<String, Value>) -> Result<Value, RpcError> {
        let reference = params.get("ref").unwrap_or(&Value::Null);
        let argument = params.get("argument").unwrap_or(&Value::Null);
        let name = argument["name"].as_str().unwrap_or_default();
        let completer = if reference["type"] == "ref/prompt" {
            let target = reference["name"].as_str().unwrap_or_default();
            let Some(prompt) = self.prompts.iter().find(|p| p.name == target) else {
                return Err((-32602, format!("Prompt {target} not found"), None));
            };
            prompt.complete.get(name)
        } else {
            let uri = reference["uri"].as_str().unwrap_or_default();
            let template = self
                .templates
                .iter()
                .find(|(t, _, _)| t.uri_template == uri);
            if template.is_none() && !self.resources.iter().any(|r| r.uri == uri) {
                return Err((-32602, format!("Resource template {uri} not found"), None));
            }
            template.and_then(|(t, _, _)| t.complete.get(name))
        };
        let Some(completer) = completer else {
            return Ok(json!({ "completion": { "values": [], "hasMore": false } }));
        };
        let chosen = params
            .get("context")
            .and_then(|c| c.get("arguments"))
            .and_then(Value::as_object)
            .map(|args| {
                args.iter()
                    .map(|(k, v)| (k.clone(), crate::js::to_string(v)))
                    .collect()
            })
            .unwrap_or_default();
        let values = completer(argument["value"].as_str().unwrap_or_default(), &chosen);
        let shown = values.iter().take(100).cloned().collect::<Vec<_>>();
        Ok(
            json!({ "completion": { "values": shown, "total": values.len(), "hasMore": values.len() > 100 } }),
        )
    }
}

/// Lists a prompt as `prompts/list` shows it.
fn prompt_entry(prompt: &Prompt) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), prompt.name.clone().into());
    prompt.display.describe(&mut out);
    if let Some(Type {
        kind: Kind::Object(fields),
        ..
    }) = &prompt.args
    {
        let arguments = fields
            .iter()
            .map(|field| {
                let mut item = Map::new();
                item.insert("name".into(), field.name.clone().into());
                if let Some(description) = &field.ty.description {
                    item.insert("description".into(), description.clone().into());
                }
                let required = !field.ty.optional && field.ty.default.is_none();
                item.insert("required".into(), required.into());
                Value::Object(item)
            })
            .collect::<Vec<_>>();
        out.insert("arguments".into(), arguments.into());
    }
    prompt.display.icons(&mut out);
    Value::Object(out)
}

/// Normalizes what a read returned into `resources/read` contents.
fn contents(read: Value, uri: &str, mime_type: Option<&str>) -> Vec<Value> {
    let items = match read {
        Value::String(text) => vec![json!({ "text": text })],
        Value::Array(items) => items,
        item => vec![item],
    };
    items
        .into_iter()
        .map(|item| {
            let item = item.as_object().cloned().unwrap_or_default();
            let mut out = Map::new();
            out.insert(
                "uri".into(),
                item.get("uri").cloned().unwrap_or_else(|| uri.into()),
            );
            if let Some(kind) = item.get("mimeType").and_then(Value::as_str).or(mime_type) {
                out.insert("mimeType".into(), kind.into());
            }
            for (key, value) in item {
                if key != "uri" && key != "mimeType" {
                    out.insert(key, value);
                }
            }
            Value::Object(out)
        })
        .collect()
}

/// Compiles a level 1 URI template into its variable names and a regex.
///
/// `regex_lite` matches without backtracking, so templates with several variables in one
/// segment cannot stall a read.
///
/// # Errors
///
/// Returns a message for other expressions or stray braces.
fn pattern(template: &str) -> Result<(Vec<String>, regex_lite::Regex), String> {
    let unsupported = || format!("Unsupported URI template: {template}");
    let mut names = Vec::new();
    let mut source = String::from("^");
    let mut rest = template;
    while let Some(start) = rest.find(['{', '}']) {
        source.push_str(&regex_lite::escape(&rest[..start]));
        let close = rest[start..]
            .find('}')
            .filter(|_| rest[start..].starts_with('{'));
        let name = close.map_or("", |close| &rest[start + 1..start + close]);
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(unsupported());
        }
        names.push(name.to_owned());
        source.push_str("([^/,]+)");
        rest = &rest[start + name.len() + 2..];
    }
    source.push_str(&regex_lite::escape(rest));
    source.push('$');
    let regex = regex_lite::Regex::new(&source).map_err(|_| unsupported())?;
    Ok((names, regex))
}
