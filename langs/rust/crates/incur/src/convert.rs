//! Converts JSON Schema into [`Type`]s, as Zod's `z.fromJSONSchema` does for OpenAPI operations
//! and remote MCP tools, keeping the JSON Schema Zod emits for the result.

use serde_json::{Map, Value};

use crate::schema::{Converted, Field, Kind, Type};

/// The largest integer a JavaScript number represents exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The pattern Zod's `z.iso.datetime()` emits and validates with.
const DATETIME: &str = r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$";

/// Keywords `z.fromJSONSchema` interprets. Every other keyword becomes metadata.
const RECOGNIZED: [&str; 57] = [
    "$schema",
    "$ref",
    "$defs",
    "definitions",
    "$id",
    "id",
    "$comment",
    "$anchor",
    "$vocabulary",
    "$dynamicRef",
    "$dynamicAnchor",
    "type",
    "enum",
    "const",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "properties",
    "required",
    "additionalProperties",
    "patternProperties",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "items",
    "prefixItems",
    "additionalItems",
    "minItems",
    "maxItems",
    "uniqueItems",
    "contains",
    "minContains",
    "maxContains",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "description",
    "default",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
    "unevaluatedItems",
    "unevaluatedProperties",
    "if",
    "then",
    "else",
    "dependentSchemas",
    "dependentRequired",
    "nullable",
    "readOnly",
];

/// Recognized keywords `z.fromJSONSchema` still records as metadata, in its order.
const RECORDED: [&str; 10] = [
    "$id",
    "id",
    "$comment",
    "$anchor",
    "$vocabulary",
    "$dynamicRef",
    "$dynamicAnchor",
    "contentEncoding",
    "contentMediaType",
    "contentSchema",
];

/// The Zod wrapper around a converted schema.
#[derive(Clone, Copy, PartialEq)]
enum Wrapper {
    /// No wrapper.
    None,
    /// `.optional()`.
    Optional,
    /// `.default()`, possibly inside `.optional()`.
    Default,
}

/// A Zod schema instance, reduced to what `z.toJSONSchema` emits for it: the keywords its
/// processor writes, its registered metadata, and the wrapped schema whose keywords follow.
#[derive(Clone)]
struct Node {
    /// The processor's keywords: type keywords for a leaf, `default` for `.default()`.
    own: Map<String, Value>,
    /// The metadata the global registry returns for the instance.
    meta: Map<String, Value>,
    /// The schema a wrapper references.
    inner: Option<Box<Node>>,
}

impl Node {
    /// A schema without metadata.
    fn new(own: Map<String, Value>, inner: Option<Self>) -> Self {
        Self {
            own,
            meta: Map::new(),
            inner: inner.map(Box::new),
        }
    }

    /// The emitted JSON Schema: own keywords overwritten by metadata, then the referenced
    /// schema's remaining keywords, as `z.toJSONSchema` flattens references.
    fn json(&self) -> Map<String, Value> {
        let mut out = self.own.clone();
        out.extend(self.meta.clone());
        if let Some(inner) = &self.inner {
            for (key, value) in inner.json() {
                out.entry(key).or_insert(value);
            }
        }
        out
    }

    /// A clone with a description, as `.describe()` registers one.
    fn describe(&mut self, description: &str) {
        self.meta.insert("description".into(), description.into());
    }

    /// The description the registry reports.
    fn description(&self) -> Option<String> {
        self.meta
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

/// A Zod schema converted from JSON Schema, with the JSON Schema Zod emits for it.
pub(crate) struct Zod {
    /// The schema.
    ty: Type,
    /// The Zod instance.
    node: Node,
    /// The outermost wrapper.
    wrapper: Wrapper,
    /// The kind `z.coerce` replaces the schema with, for numbers, booleans, and unions of them.
    coercible: Option<Kind>,
    /// The pattern strings must match.
    pattern: Option<(String, &'static str)>,
    /// Whether objects keep unknown keys.
    loose: bool,
    /// Whether the schema coerces its input.
    coerced: bool,
}

/// Reads a numeric keyword.
fn number(schema: &Value, key: &str) -> Option<f64> {
    schema.get(key).and_then(Value::as_f64)
}

impl Zod {
    /// Converts a JSON Schema, as `z.fromJSONSchema` does.
    pub(crate) fn from_json(schema: &Value) -> Self {
        let mut zod = Self::convert_base(schema);
        let mut extra = Map::new();
        for key in RECORDED {
            if let Some(value) = schema.get(key) {
                extra.insert(key.into(), value.clone());
            }
        }
        for (key, value) in schema.as_object().into_iter().flatten() {
            if !RECOGNIZED.contains(&key.as_str()) {
                extra.insert(key.clone(), value.clone());
            }
        }
        zod.ty.deprecated = extra.get("deprecated") == Some(&Value::Bool(true));
        if !extra.is_empty() {
            // Registering metadata replaces what `.describe()` registered on the same instance.
            zod.node.meta = extra;
            zod.ty.description = zod.node.description();
        }
        zod
    }

    /// Converts everything but composition keywords. Enums and type lists return before the
    /// description and default apply.
    fn convert_base(schema: &Value) -> Self {
        let is_enum = schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| values.len() > 1 && values.iter().all(Value::is_string));
        if is_enum {
            return Self::leaf(schema);
        }
        if let Some(Value::Array(types)) = schema.get("type") {
            let members = types
                .iter()
                .map(|ty| {
                    let mut member = schema.clone();
                    if let Some(member) = member.as_object_mut() {
                        member.insert("type".into(), ty.clone());
                    }
                    Self::convert_base(&member)
                })
                .collect::<Vec<_>>();
            return Self::union(members);
        }
        let mut zod = Self::leaf(schema);
        if let Some(description) = schema.get("description").and_then(Value::as_str) {
            zod.node.describe(description);
            zod.ty.description = Some(description.to_owned());
        }
        if let Some(default) = schema.get("default") {
            zod.ty = zod.ty.default_value(default.clone());
            let mut own = Map::new();
            own.insert("default".into(), default.clone());
            zod.node = Node::new(own, Some(zod.node));
            zod.wrapper = Wrapper::Default;
        }
        zod
    }

    /// Combines the schemas of a type list. A single type stays itself; the first non-null
    /// member decides validation.
    fn union(mut members: Vec<Self>) -> Self {
        if members.len() < 2 {
            return members.pop().unwrap_or_else(|| Self::leaf(&Value::Null));
        }
        let any_of = members
            .iter()
            .map(|member| Value::Object(member.node.json()))
            .collect::<Vec<_>>();
        let index = members
            .iter()
            .position(|member| member.node.own.get("type") != Some(&Value::from("null")))
            .unwrap_or_default();
        let main = members.swap_remove(index);
        let mut own = Map::new();
        own.insert("anyOf".into(), any_of.into());
        Self {
            ty: Type::new(main.ty.kind.clone()),
            node: Node::new(own, None),
            wrapper: Wrapper::None,
            coercible: main.coercible,
            pattern: main.pattern,
            loose: main.loose,
            coerced: false,
        }
    }

    /// Converts the type keywords of a JSON Schema with a single type.
    fn leaf(schema: &Value) -> Self {
        let mut json = Map::new();
        let mut pattern = None;
        let mut loose = false;
        let main = schema.get("type").and_then(Value::as_str);
        let enum_values = schema
            .get("enum")
            .and_then(Value::as_array)
            .and_then(|values| {
                values
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            });
        let main = main.or_else(|| {
            if enum_values.is_some() {
                Some("string")
            } else if schema.get("properties").is_some() {
                Some("object")
            } else {
                None
            }
        });
        let kind = match main {
            Some("string") if enum_values.is_some() => {
                let values = enum_values.unwrap_or_default();
                json.insert("type".into(), "string".into());
                json.insert("enum".into(), values.clone().into());
                Kind::Enum(values)
            }
            Some("string") => {
                json.insert("type".into(), "string".into());
                let (min, max) = (number(schema, "minLength"), number(schema, "maxLength"));
                if let Some(min) = min {
                    json.insert("minLength".into(), crate::js::number(min));
                }
                if let Some(max) = max {
                    json.insert("maxLength".into(), crate::js::number(max));
                }
                if schema.get("format").and_then(Value::as_str) == Some("date-time") {
                    json.insert("format".into(), "date-time".into());
                    json.insert("pattern".into(), DATETIME.into());
                    pattern = Some((DATETIME.to_owned(), "datetime"));
                }
                if let Some(source) = schema.get("pattern").and_then(Value::as_str) {
                    json.insert("pattern".into(), source.into());
                    pattern = Some((source.to_owned(), "regex"));
                }
                Kind::String { max, min }
            }
            Some("integer") => {
                let (min, max) = (number(schema, "minimum"), number(schema, "maximum"));
                json.insert("type".into(), "integer".into());
                json.insert(
                    "minimum".into(),
                    crate::js::number(min.unwrap_or(-MAX_SAFE_INTEGER)),
                );
                json.insert(
                    "maximum".into(),
                    crate::js::number(max.unwrap_or(MAX_SAFE_INTEGER)),
                );
                Kind::Integer { max, min }
            }
            Some("number") => {
                let (min, max) = (number(schema, "minimum"), number(schema, "maximum"));
                json.insert("type".into(), "number".into());
                if let Some(min) = min {
                    json.insert("minimum".into(), crate::js::number(min));
                }
                if let Some(max) = max {
                    json.insert("maximum".into(), crate::js::number(max));
                }
                Kind::Number { max, min }
            }
            Some("boolean") => {
                json.insert("type".into(), "boolean".into());
                Kind::Boolean
            }
            Some("null") => {
                json.insert("type".into(), "null".into());
                Kind::Unknown
            }
            Some("array") => {
                let items = schema
                    .get("items")
                    .filter(|items| items.is_object())
                    .map_or_else(
                        || Type::new(Kind::Unknown),
                        |items| Self::from_json(items).into_type(),
                    );
                let (min, max) = (number(schema, "minItems"), number(schema, "maxItems"));
                if let Some(min) = min {
                    json.insert("minItems".into(), crate::js::number(min));
                }
                if let Some(max) = max {
                    json.insert("maxItems".into(), crate::js::number(max));
                }
                json.insert("type".into(), "array".into());
                json.insert("items".into(), crate::schema::json_schema(&items));
                Kind::Array {
                    items: Box::new(items),
                    max,
                    min,
                }
            }
            Some("object") => {
                let required = schema
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                    .unwrap_or_default();
                let mut fields = Vec::new();
                let mut properties = Map::new();
                let mut names = Vec::new();
                for (name, property) in schema
                    .get("properties")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                {
                    let mut zod = Self::from_json(property);
                    if required.contains(&name.as_str()) {
                        names.push(Value::from(name.clone()));
                    } else {
                        zod = zod.optional();
                    }
                    let ty = zod.into_type();
                    properties.insert(name.clone(), crate::schema::json_schema(&ty));
                    fields.push(Field::new(name.clone(), ty));
                }
                json.insert("type".into(), "object".into());
                json.insert("properties".into(), properties.into());
                if !names.is_empty() {
                    json.insert("required".into(), names.into());
                }
                loose = schema.get("additionalProperties") != Some(&Value::Bool(false));
                json.insert(
                    "additionalProperties".into(),
                    if loose {
                        Value::Object(Map::new())
                    } else {
                        Value::Bool(false)
                    },
                );
                Kind::Object(fields)
            }
            _ => Kind::Unknown,
        };
        let coercible = match &kind {
            Kind::Integer { .. } | Kind::Number { .. } => Some(Kind::Number {
                max: None,
                min: None,
            }),
            Kind::Boolean => Some(Kind::Boolean),
            _ => None,
        };
        Self {
            ty: Type::new(kind),
            node: Node::new(json, None),
            wrapper: Wrapper::None,
            coercible,
            pattern,
            loose,
            coerced: false,
        }
    }

    /// Makes the schema optional, as `.optional()` does.
    pub(crate) fn optional(mut self) -> Self {
        self.ty.optional = true;
        self.node = Node::new(Map::new(), Some(self.node));
        if self.wrapper == Wrapper::None {
            self.wrapper = Wrapper::Optional;
        }
        self
    }

    /// Sets the description, as `.describe()` does.
    pub(crate) fn describe(mut self, description: &str) -> Self {
        self.ty.description = Some(description.to_owned());
        self.node.describe(description);
        self
    }

    /// Replaces numbers and booleans, optionally inside `.optional()`, with their coercing
    /// counterparts, which read command-line strings. Bounds, integer checks, and metadata
    /// other than the description are dropped, as `coerceIfNeeded` rebuilds the schema.
    pub(crate) fn coerce(self) -> Self {
        let Some(kind) = self
            .coercible
            .clone()
            .filter(|_| self.wrapper != Wrapper::Default)
        else {
            return self;
        };
        let optional = self.wrapper == Wrapper::Optional;
        let description = self.node.description().or_else(|| {
            self.node
                .inner
                .as_ref()
                .filter(|_| optional)
                .and_then(|inner| inner.description())
        });
        let mut own = Map::new();
        let name = if kind == Kind::Boolean {
            "boolean"
        } else {
            "number"
        };
        own.insert("type".into(), name.into());
        let mut node = Node::new(own, None);
        if optional {
            node = Node::new(Map::new(), Some(node));
        }
        if let Some(description) = &description {
            node.describe(description);
        }
        let mut ty = Type::new(kind);
        ty.optional = optional;
        ty.description = description;
        Self {
            ty,
            node,
            wrapper: self.wrapper,
            coercible: None,
            pattern: None,
            loose: false,
            coerced: true,
        }
    }

    /// Returns the converted schema.
    pub(crate) fn into_type(self) -> Type {
        let mut ty = self.ty;
        ty.converted = Some(Box::new(Converted {
            json: Value::Object(self.node.json()),
            pattern: self.pattern,
            loose: self.loose,
            coerce: self.coerced,
        }));
        ty
    }
}
