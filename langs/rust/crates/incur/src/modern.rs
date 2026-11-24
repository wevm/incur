//! MCP protocol revision 2026-07-28: per-request `_meta` envelopes, `server/discover`, and the
//! HTTP validation ladder, as `@modelcontextprotocol/server` serves them.

use serde_json::{Map, Value, json};

use crate::js;
use crate::mcp;
use crate::mcp::{CacheHint, CacheScope};

/// The modern protocol revision the server speaks.
pub(crate) const VERSION: &str = "2026-07-28";
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const INFO_KEY: &str = "io.modelcontextprotocol/clientInfo";
pub(crate) const CAPABILITIES_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const LOG_KEY: &str = "io.modelcontextprotocol/logLevel";
const SERVER_INFO_KEY: &str = "io.modelcontextprotocol/serverInfo";
const RESERVED: [&str; 4] = [VERSION_KEY, INFO_KEY, CAPABILITIES_KEY, LOG_KEY];
const REQUIRED: [&str; 2] = [VERSION_KEY, CAPABILITIES_KEY];
const LEVELS: [&str; 8] = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
];

/// A ladder rejection: a JSON-RPC error answered with HTTP 400.
pub(crate) struct Reject {
    /// The JSON-RPC error code.
    pub(crate) code: i64,
    /// The error message.
    pub(crate) message: String,
    /// The error data.
    pub(crate) data: Option<Value>,
}

impl Reject {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub(crate) fn mismatch(header: &str, body: &str) -> Self {
        Self {
            code: -32020,
            message: format!("Bad Request: the request headers and body disagree: {body}"),
            data: Some(json!({ "mismatch": { "header": header, "body": body } })),
        }
    }

    /// An invalid-envelope error for an issue.
    pub(crate) fn envelope((key, problem): (String, String)) -> Self {
        Self {
            code: -32602,
            message: format!(
                "Invalid _meta envelope for protocol revision 2026-07-28: {key}: {problem}"
            ),
            data: Some(json!({ "envelope": { "key": key, "problem": problem } })),
        }
    }

    /// The `UnsupportedProtocolVersion` error for a requested revision.
    pub(crate) fn unsupported(requested: &str) -> Self {
        Self {
            code: -32022,
            message: format!("Unsupported protocol version: {requested}"),
            data: Some(json!({ "supported": [VERSION], "requested": requested })),
        }
    }

    /// The `UnsupportedProtocolVersion` error for an `initialize` request.
    pub(crate) fn initialize(params: &Map<String, Value>) -> Self {
        match params.get("protocolVersion").and_then(Value::as_str) {
            Some(requested) => Self::unsupported(requested),
            None => Self {
                code: -32022,
                message: "Unsupported protocol version: the request did not name a protocol \
                          version"
                    .into(),
                data: Some(json!({ "supported": [VERSION] })),
            },
        }
    }

    /// Renders the rejection as a JSON-RPC error response, `id` first as stdio writes it.
    pub(crate) fn response(&self, id: &Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "error": self.error() })
    }

    /// The `error` object.
    pub(crate) fn error(&self) -> Value {
        let mut error = Map::new();
        error.insert("code".into(), self.code.into());
        error.insert("message".into(), self.message.clone().into());
        if let Some(data) = &self.data {
            error.insert("data".into(), data.clone());
        }
        Value::Object(error)
    }
}

/// Whether a protocol revision belongs to the 2026-07-28 era.
pub(crate) fn is_modern(version: &str) -> bool {
    version >= VERSION
}

fn meta(params: &Map<String, Value>) -> Option<&Map<String, Value>> {
    params.get("_meta").and_then(Value::as_object)
}

/// Whether params name a protocol version in `_meta`.
pub(crate) fn has_claim(params: &Map<String, Value>) -> bool {
    meta(params).is_some_and(|meta| meta.contains_key(VERSION_KEY))
}

/// The protocol version params name in `_meta`, when it is a string.
pub(crate) fn claimed(params: &Map<String, Value>) -> Option<&str> {
    meta(params)?.get(VERSION_KEY)?.as_str()
}

fn received(object: &Map<String, Value>, key: &str) -> &'static str {
    match object.get(key) {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// The envelope schema's issues as `(path, message)`, in schema order.
fn schema_issues(meta: &Map<String, Value>) -> Vec<(String, String)> {
    let mut issues = Vec::new();
    let expected = |what: &str, object: &Map<String, Value>, key: &str| {
        format!(
            "Invalid input: expected {what}, received {}",
            received(object, key)
        )
    };
    if !meta.get(VERSION_KEY).is_some_and(Value::is_string) {
        issues.push((VERSION_KEY.into(), expected("string", meta, VERSION_KEY)));
    }
    match meta.get(INFO_KEY) {
        None => {}
        Some(Value::Object(info)) => {
            for name in ["name", "version"] {
                if !info.get(name).is_some_and(Value::is_string) {
                    issues.push((format!("{INFO_KEY}.{name}"), expected("string", info, name)));
                }
            }
        }
        Some(_) => issues.push((INFO_KEY.into(), expected("object", meta, INFO_KEY))),
    }
    if !meta.get(CAPABILITIES_KEY).is_some_and(Value::is_object) {
        issues.push((
            CAPABILITIES_KEY.into(),
            expected("object", meta, CAPABILITIES_KEY),
        ));
    }
    if meta
        .get(LOG_KEY)
        .is_some_and(|level| !level.as_str().is_some_and(|level| LEVELS.contains(&level)))
    {
        let levels = LEVELS.map(|level| format!("\"{level}\"")).join("|");
        issues.push((
            LOG_KEY.into(),
            format!("Invalid option: expected one of {levels}"),
        ));
    }
    issues
}

/// Validates `_meta` as a per-request envelope: missing keys first, then schema issues.
pub(crate) fn envelope_issues(meta: &Map<String, Value>) -> Vec<(String, String)> {
    let missing = REQUIRED
        .into_iter()
        .filter(|key| !meta.contains_key(*key))
        .collect::<Vec<_>>();
    let mut issues = missing
        .iter()
        .map(|key| ((*key).to_owned(), "missing".to_owned()))
        .collect::<Vec<_>>();
    issues.extend(
        schema_issues(meta)
            .into_iter()
            .filter(|(key, _)| !missing.contains(&key.as_str())),
    );
    issues
}

/// The issues of params' `_meta`, empty when it has none.
pub(crate) fn params_issues(params: &Map<String, Value>) -> Vec<(String, String)> {
    envelope_issues(meta(params).unwrap_or(&Map::new()))
}

/// Whether params carry a valid envelope naming a modern revision.
pub(crate) fn valid_claim(params: &Map<String, Value>) -> bool {
    claimed(params).is_some_and(is_modern) && params_issues(params).is_empty()
}

/// The error a modern-era server answers a request with when its envelope is invalid.
pub(crate) fn envelope_error(params: &Map<String, Value>) -> Option<String> {
    let empty = Map::new();
    let meta = meta(params).unwrap_or(&empty);
    let envelope = RESERVED
        .into_iter()
        .filter_map(|key| Some((key.to_owned(), meta.get(key)?.clone())))
        .collect::<Map<_, _>>();
    if envelope.is_empty() {
        return Some(format!(
            "Request is missing the required _meta envelope for protocol revision 2026-07-28 \
             ({})",
            REQUIRED.join(", ")
        ));
    }
    let issues = schema_issues(&envelope);
    (!issues.is_empty()).then(|| {
        let listed = issues
            .into_iter()
            .map(|(_, message)| message)
            .collect::<Vec<_>>()
            .join("; ");
        format!("Invalid _meta envelope for protocol revision 2026-07-28: {listed}")
    })
}

/// Stamps `resultType`, cache hints, and the server identity on a modern result.
pub(crate) fn encode(
    method: &str,
    mut out: Map<String, Value>,
    info: Value,
    cache: Option<&CacheHint>,
) -> Map<String, Value> {
    if out.get("resultType").and_then(Value::as_str) != Some("input_required") {
        out.insert("resultType".into(), "complete".into());
    }
    let cacheable = [
        "tools/list",
        "prompts/list",
        "resources/list",
        "resources/templates/list",
        "resources/read",
        "server/discover",
    ];
    if cacheable.contains(&method) {
        // The server's hints cover lists and discovery; reads keep the defaults.
        let cache = cache.filter(|_| method != "resources/read");
        let ttl = cache.and_then(|c| c.ttl_ms).unwrap_or(0);
        let public = cache.and_then(|c| c.cache_scope) == Some(CacheScope::Public);
        out.insert("ttlMs".into(), ttl.into());
        out.insert(
            "cacheScope".into(),
            if public { "public" } else { "private" }.into(),
        );
    }
    let mut meta = out
        .get("_meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    meta.insert(SERVER_INFO_KEY.into(), info);
    out.insert("_meta".into(), meta.into());
    out
}

/// The standard MCP request headers, trimmed of spaces and tabs.
pub(crate) struct Headers<'a> {
    /// `MCP-Protocol-Version`.
    pub(crate) version: Option<&'a str>,
    /// `Mcp-Method`.
    pub(crate) method: Option<&'a str>,
    /// `Mcp-Name`.
    pub(crate) name: Option<&'a str>,
}

/// Whether an MCP POST body claims the 2026-07-28 revision, by header or by `_meta`.
pub(crate) fn is_modern_request(headers: &Headers<'_>, body: &str) -> bool {
    let Ok(body) = js::json_parse(body, |_| Value::Null) else {
        return false;
    };
    if headers.version.is_some_and(is_modern) {
        return true;
    }
    let messages = match &body {
        Value::Array(items) => items.as_slice(),
        other => std::slice::from_ref(other),
    };
    messages.iter().any(|message| {
        message
            .get("params")
            .and_then(Value::as_object)
            .is_some_and(has_claim)
    })
}

/// Routes a modern-claiming body. Returns the message and its revision.
pub(crate) fn classify(
    headers: &Headers<'_>,
    body: &Value,
) -> Result<(Map<String, Value>, String), Reject> {
    if let Value::Array(items) = body {
        if items.is_empty() {
            return Err(Reject::new(-32600, "Bad Request: empty JSON-RPC batch"));
        }
        for item in items {
            if item
                .get("params")
                .and_then(Value::as_object)
                .is_some_and(has_claim)
            {
                return Err(Reject::new(
                    -32600,
                    "Bad Request: JSON-RPC batches may not contain requests for protocol \
                     revision 2026-07-28 or later",
                ));
            }
            if mcp::message(item).is_none() {
                return Err(Reject::new(
                    -32600,
                    "Bad Request: JSON-RPC batch contains an invalid message",
                ));
            }
        }
        return Err(Reject::new(
            -32600,
            "Bad Request: JSON-RPC batches are not supported by this endpoint",
        ));
    }
    let (Some(_), Some(object)) = (mcp::message(body), body.as_object()) else {
        return Err(Reject::new(
            -32600,
            "Bad Request: the request body is not a valid JSON-RPC message",
        ));
    };
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Err(Reject::new(
            -32600,
            "Bad Request: JSON-RPC responses cannot be posted to this endpoint",
        ));
    };
    let empty = Map::new();
    let params = object
        .get("params")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let claim = claimed(params);
    let header = headers.version;
    if !object.contains_key("id") {
        let revision = if has_claim(params) {
            let Some(claim) = claim else {
                let issue = params_issues(params)
                    .into_iter()
                    .find(|(key, _)| key == VERSION_KEY)
                    .unwrap_or_default();
                return Err(Reject::envelope(issue));
            };
            if let Some(header) = header.filter(|header| *header != claim) {
                return Err(Reject::mismatch(
                    header,
                    &format!(
                        "the notification envelope names protocol version {claim} but the \
                         MCP-Protocol-Version header names {header}"
                    ),
                ));
            }
            claim
        } else {
            header.unwrap_or_default()
        };
        if let Some(named) = headers
            .method
            .filter(|named| is_modern(revision) && *named != method)
        {
            return Err(Reject::mismatch(
                named,
                &format!(
                    "the notification body names method {method} but the Mcp-Method header \
                     names {named}"
                ),
            ));
        }
        return Ok((object.clone(), revision.to_owned()));
    }
    if method == "initialize" && !valid_claim(params) {
        if let Some(header) = header.filter(|header| is_modern(header)) {
            return Err(Reject::mismatch(
                header,
                "an initialize request (legacy handshake) was sent with a modern \
                 MCP-Protocol-Version header",
            ));
        }
        return Err(Reject::initialize(params));
    }
    if has_claim(params) {
        if let Some(issue) = params_issues(params).into_iter().next() {
            return Err(Reject::envelope(issue));
        }
        let claim = claim.unwrap_or_default();
        if let Some(header) = header.filter(|header| *header != claim) {
            return Err(Reject::mismatch(
                header,
                &format!(
                    "the body envelope names protocol version {claim} but the \
                     MCP-Protocol-Version header names {header}"
                ),
            ));
        }
        if let Some(named) = headers.method.filter(|named| *named != method) {
            return Err(Reject::mismatch(
                named,
                &format!("the body names method {method} but the Mcp-Method header names {named}"),
            ));
        }
        return Ok((object.clone(), claim.to_owned()));
    }
    let missing = match meta(params) {
        None => vec!["_meta".to_owned()],
        Some(meta) => envelope_issues(meta)
            .into_iter()
            .filter(|(_, problem)| problem == "missing")
            .map(|(key, _)| key)
            .collect::<Vec<_>>(),
    };
    Err(Reject {
        code: -32602,
        message: format!(
            "Invalid params: the MCP-Protocol-Version header names protocol revision {}, but \
             the request is missing the required per-request envelope key(s): {}",
            header.unwrap_or_default(),
            missing.join(", ")
        ),
        data: Some(json!({ "envelope": { "missing": missing } })),
    })
}

pub(crate) fn decode_name(value: &str) -> Option<String> {
    if !(value.starts_with("=?base64?") && value.ends_with("?=")) {
        return Some(value.to_owned());
    }
    // As `slice(9, -2)`: `=?base64?=` overlaps its markers and carries an empty payload.
    let payload = value.get(9..value.len() - 2).unwrap_or_default();
    let canonical =
        regex_lite::Regex::new(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
            .ok()?;
    if !canonical.is_match(payload) {
        return None;
    }
    let digits = payload
        .bytes()
        .filter(|c| *c != b'=')
        .map(|c| {
            u32::from(match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                _ => 63,
            })
        })
        .collect::<Vec<_>>();
    let mut bytes = Vec::new();
    // Every four digits carry three bytes; a shorter final group carries one fewer byte per
    // missing digit.
    for group in digits.chunks(4) {
        let bits = group.iter().fold(0, |bits, digit| bits << 6 | digit) << (6 * (4 - group.len()));
        bytes.extend_from_slice(&u32::to_be_bytes(bits)[1..group.len()]);
    }
    String::from_utf8(bytes).ok()
}

/// Checks the standard request headers of a modern request against its body.
pub(crate) fn check_headers(
    headers: &Headers<'_>,
    message: &Map<String, Value>,
    revision: &str,
) -> Result<(), Reject> {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if headers.version.is_none() {
        return Err(Reject::mismatch(
            "(missing)",
            &format!(
                "the body envelope names protocol version {revision} but the required \
                 MCP-Protocol-Version header is absent"
            ),
        ));
    }
    if headers.method.is_none() {
        return Err(Reject::mismatch(
            "(missing)",
            &format!("the body names method {method} but the required Mcp-Method header is absent"),
        ));
    }
    let field = match method {
        "tools/call" | "prompts/get" => "name",
        "resources/read" => "uri",
        _ => return Ok(()),
    };
    let value = message
        .get("params")
        .and_then(|params| params.get(field))
        .and_then(Value::as_str);
    let Some(header) = headers.name else {
        return match value {
            None => Ok(()),
            Some(value) => Err(Reject::mismatch(
                "(missing)",
                &format!(
                    "the body carries params.{field}=\"{value}\" but the required Mcp-Name \
                     header is absent"
                ),
            )),
        };
    };
    let Some(decoded) = decode_name(header) else {
        return Err(Reject::mismatch(
            header,
            "the Mcp-Name header carries an invalid Base64 sentinel value",
        ));
    };
    match value {
        Some(value) if value != decoded => Err(Reject::mismatch(
            header,
            &format!(
                "the body carries params.{field}=\"{value}\" but the Mcp-Name header names \
                 \"{decoded}\""
            ),
        )),
        _ => Ok(()),
    }
}

/// Whether a `content-type` header names JSON.
pub(crate) fn is_json(content_type: Option<&str>) -> bool {
    content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/json")
}
