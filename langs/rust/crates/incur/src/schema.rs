//! Schemas for arguments, options, environment variables, variables, and outputs.
//!
//! A [`Type`] is the Rust counterpart of the Zod schemas the TypeScript package accepts. Derive
//! [`Schema`](trait@Schema) on a struct or unit enum to describe it, then pass the type to a
//! command. The derive reads `serde` attributes (`rename`, `rename_all`, `default`, `skip`) so
//! the schema always names fields the same way deserialization does, and `incur` attributes for
//! command-line metadata:
//!
//! ```
//! use incur::Schema;
//! use serde::Deserialize;
//!
//! #[derive(Deserialize, Schema)]
//! #[serde(rename_all = "camelCase")]
//! struct Options {
//!     /// Save as a dev dependency.
//!     #[incur(alias = 'D')]
//!     save_dev: Option<bool>,
//!     /// Verbosity level.
//!     #[incur(count, alias = 'v')]
//!     #[serde(default)]
//!     verbose: u32,
//! }
//!
//! let schema = incur::schema::json_schema(&Options::schema());
//! assert_eq!(schema["properties"]["saveDev"]["type"], "boolean");
//! ```

use serde_json::{Map, Value};

use crate::js;

/// A type that describes its shape as a [`Type`].
///
/// Implemented for strings, booleans, numbers, [`Vec`], [`Option`], and [`serde_json::Value`].
/// Derive it for structs with named fields and for enums with unit variants.
pub trait Schema {
    /// Returns the schema of this type.
    fn schema() -> Type;
}

/// A schema node: a [`Kind`] with the metadata Zod attaches through `.describe()`, `.default()`,
/// `.optional()`, and `.meta()`.
#[derive(Clone, Debug, PartialEq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Independent Zod modifiers, each set by its own builder method."
)]
pub struct Type {
    /// Whether the option counts repeated flags (`-vvv`).
    pub count: bool,
    /// The value used when the input omits the field.
    pub default: Option<Value>,
    /// Whether the option is deprecated.
    pub deprecated: bool,
    /// Human-readable description.
    pub description: Option<String>,
    /// The shape of accepted values.
    pub kind: Kind,
    /// Whether the input may omit the field.
    pub optional: bool,
    /// What a schema converted from JSON Schema keeps beyond its kind.
    pub(crate) converted: Option<Box<Converted>>,
    /// Whether input converts to the kind first, as `z.coerce` does.
    pub(crate) coerce: bool,
    /// The `x-mcp-header` name MCP clients mirror the field into, as `.meta()` adds it.
    pub(crate) header: Option<String>,
}

/// What a schema converted from JSON Schema, such as an OpenAPI parameter or a remote MCP
/// tool's input, keeps beyond its [`Kind`].
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Converted {
    /// The JSON Schema Zod emits for the converted schema.
    pub(crate) json: Value,
    /// A pattern strings must match, with Zod's format name: `regex` or `datetime`.
    pub(crate) pattern: Option<(String, &'static str)>,
    /// Whether objects keep unknown keys.
    pub(crate) loose: bool,
    /// Whether input converts to the kind first, as `z.coerce` does with `Number()` and
    /// `Boolean()`.
    pub(crate) coerce: bool,
    /// The members of a type list such as `["string", "array"]`, which validate as `z.union`
    /// does.
    pub(crate) union: Vec<Type>,
}

impl Converted {
    /// Whether the schema is `type: "null"`, which accepts only `null`.
    fn is_null(&self) -> bool {
        self.json.get("type") == Some(&Value::from("null"))
    }
}

/// The shape of a schema node.
#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    /// A list of values.
    Array {
        /// The schema of each item.
        items: Box<Type>,
        /// Maximum number of items.
        max: Option<f64>,
        /// Minimum number of items.
        min: Option<f64>,
    },
    /// `true` or `false`.
    Boolean,
    /// One of a fixed set of strings.
    Enum(Vec<String>),
    /// A safe integer.
    Integer {
        /// Maximum value.
        max: Option<f64>,
        /// Minimum value.
        min: Option<f64>,
    },
    /// A finite number.
    Number {
        /// Maximum value.
        max: Option<f64>,
        /// Minimum value.
        min: Option<f64>,
    },
    /// An object with named fields, in declaration order.
    Object(Vec<Field>),
    /// A string.
    String {
        /// Maximum length in UTF-16 code units.
        max: Option<f64>,
        /// Minimum length in UTF-16 code units.
        min: Option<f64>,
    },
    /// Any value.
    Unknown,
}

/// A named field of an object schema.
#[derive(Clone, Debug, PartialEq)]
pub struct Field {
    /// Single-character alias for the option (`-D`).
    pub alias: Option<char>,
    /// The field name as it appears in input and output.
    pub name: String,
    /// The field schema.
    pub ty: Type,
}

/// The largest integer a JavaScript number represents exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl Type {
    /// Creates a required schema node of the given kind.
    pub fn new(kind: Kind) -> Self {
        Self {
            count: false,
            default: None,
            deprecated: false,
            description: None,
            kind,
            optional: false,
            converted: None,
            coerce: false,
            header: None,
        }
    }

    /// Creates an object schema from its fields.
    pub fn object(fields: Vec<Field>) -> Self {
        Self::new(Kind::Object(fields))
    }

    /// Converts input to the kind before validation, as `z.coerce.number()` and
    /// `z.coerce.boolean()` do with JavaScript's `Number()` and `Boolean()`, so a positional
    /// argument `"42"` becomes `42`. The JSON Schema is unchanged.
    #[must_use]
    pub fn coerce(mut self) -> Self {
        self.coerce = true;
        self
    }

    /// Marks the option as a counter of repeated flags: a number that defaults to 0.
    #[must_use]
    pub fn count(mut self) -> Self {
        self.count = true;
        if let Kind::Integer { max, min } = self.kind {
            self.kind = Kind::Number { max, min };
        }
        if self.default.is_none() {
            self.default = Some(Value::from(0));
        }
        self
    }

    /// Sets the value used when the input omits the field.
    #[must_use]
    pub fn default_value(mut self, value: Value) -> Self {
        self.default = Some(js::normalize(value));
        self
    }

    /// Marks the option as deprecated.
    #[must_use]
    pub fn deprecated(mut self) -> Self {
        self.deprecated = true;
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn describe(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Sets the maximum value, length, or item count.
    #[must_use]
    pub fn max(mut self, value: f64) -> Self {
        // Booleans, enums, objects, and unknown values have no bounds.
        if let Kind::Array { max, .. }
        | Kind::Integer { max, .. }
        | Kind::Number { max, .. }
        | Kind::String { max, .. } = &mut self.kind
        {
            *max = Some(value);
        }
        self
    }

    /// Sets the minimum value, length, or item count.
    #[must_use]
    pub fn min(mut self, value: f64) -> Self {
        // Booleans, enums, objects, and unknown values have no bounds.
        if let Kind::Array { min, .. }
        | Kind::Integer { min, .. }
        | Kind::Number { min, .. }
        | Kind::String { min, .. } = &mut self.kind
        {
            *min = Some(value);
        }
        self
    }

    /// Marks the field as optional.
    #[must_use]
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    /// Returns the fields of an object schema, or an empty slice.
    pub fn fields(&self) -> &[Field] {
        match &self.kind {
            Kind::Object(fields) => fields,
            _ => &[],
        }
    }

    /// Returns the field with the given name.
    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields().iter().find(|field| field.name == name)
    }

    /// Whether the input may omit the field without a default, as Zod's `optout` reports.
    /// Converted schemas wrap defaults in `.optional()`, so they stay optional.
    pub(crate) fn is_optional(&self) -> bool {
        self.optional && (self.default.is_none() || self.converted.is_some())
    }

    /// Whether the option reads no value from the next token.
    pub(crate) fn is_flag(&self) -> bool {
        self.count || matches!(self.kind, Kind::Boolean)
    }

    /// Returns the type label help output shows.
    pub(crate) fn type_name(&self) -> String {
        if self.count {
            return "count".into();
        }
        match &self.kind {
            Kind::Array { .. } => "array".into(),
            Kind::Boolean => "boolean".into(),
            Kind::Enum(values) => values.join("|"),
            Kind::Integer { .. } | Kind::Number { .. } => "number".into(),
            Kind::String { .. } => "string".into(),
            Kind::Object(_) | Kind::Unknown => "value".into(),
        }
    }
}

impl Field {
    /// Creates a field.
    pub fn new(name: impl Into<String>, ty: Type) -> Self {
        Self {
            alias: None,
            name: name.into(),
            ty,
        }
    }

    /// Sets the single-character alias.
    #[must_use]
    pub fn alias(mut self, alias: char) -> Self {
        self.alias = Some(alias);
        self
    }

    /// Applies a change to the field schema.
    #[must_use]
    pub fn map(mut self, f: impl FnOnce(Type) -> Type) -> Self {
        self.ty = f(self.ty);
        self
    }
}

impl Schema for String {
    fn schema() -> Type {
        Type::new(Kind::String {
            max: None,
            min: None,
        })
    }
}

impl Schema for bool {
    fn schema() -> Type {
        Type::new(Kind::Boolean)
    }
}

impl Schema for Value {
    fn schema() -> Type {
        Type::new(Kind::Unknown)
    }
}

impl<T: Schema> Schema for Option<T> {
    fn schema() -> Type {
        T::schema().optional()
    }
}

impl<T: Schema> Schema for Vec<T> {
    fn schema() -> Type {
        Type::new(Kind::Array {
            items: Box::new(T::schema()),
            max: None,
            min: None,
        })
    }
}

macro_rules! numbers {
    ($kind:ident: $($ty:ty),*) => {$(
        impl Schema for $ty {
            fn schema() -> Type {
                Type::new(Kind::$kind { max: None, min: None })
            }
        }
    )*};
}

numbers!(Integer: i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);
numbers!(Number: f32, f64);

/// Converts a schema to the JSON Schema Zod's `z.toJSONSchema()` emits, with the same key order.
pub fn json_schema(ty: &Type) -> Value {
    if let Some(converted) = &ty.converted {
        return converted.json.clone();
    }
    let mut out = Map::new();
    let wrapped = ty.optional || ty.default.is_some();

    // Zod lists wrapper metadata before the inner type and plain metadata after it.
    if wrapped {
        metadata(ty, &mut out);
    }
    match &ty.kind {
        Kind::Array { items, max, min } => {
            // Zod lists array bounds before the type.
            bound(&mut out, "minItems", *min);
            bound(&mut out, "maxItems", *max);
            out.insert("type".into(), "array".into());
            out.insert("items".into(), json_schema(items));
        }
        Kind::Boolean => {
            out.insert("type".into(), "boolean".into());
        }
        Kind::Enum(values) => {
            out.insert("type".into(), "string".into());
            out.insert("enum".into(), values.clone().into());
        }
        Kind::Integer { max, min } => {
            out.insert("type".into(), "integer".into());
            bound(&mut out, "minimum", Some(min.unwrap_or(-MAX_SAFE_INTEGER)));
            bound(&mut out, "maximum", Some(max.unwrap_or(MAX_SAFE_INTEGER)));
        }
        Kind::Number { max, min } => {
            out.insert("type".into(), "number".into());
            bound(&mut out, "minimum", *min);
            bound(&mut out, "maximum", *max);
        }
        Kind::Object(fields) => {
            out.insert("type".into(), "object".into());
            let mut properties = Map::new();
            let mut required = Vec::new();
            for field in fields {
                properties.insert(field.name.clone(), json_schema(&field.ty));
                if !field.ty.is_optional() {
                    required.push(Value::from(field.name.clone()));
                }
            }
            out.insert("properties".into(), properties.into());
            if !required.is_empty() {
                out.insert("required".into(), required.into());
            }
            out.insert("additionalProperties".into(), false.into());
        }
        Kind::String { max, min } => {
            out.insert("type".into(), "string".into());
            bound(&mut out, "minLength", *min);
            bound(&mut out, "maxLength", *max);
        }
        Kind::Unknown => {}
    }
    if !wrapped {
        metadata(ty, &mut out);
    }
    Value::Object(out)
}

/// Writes the default, description, and `.meta()` keys of a node.
fn metadata(ty: &Type, out: &mut Map<String, Value>) {
    if let Some(default) = &ty.default {
        out.insert("default".into(), default.clone());
    }
    if let Some(description) = &ty.description {
        out.insert("description".into(), description.clone().into());
    }
    if ty.count {
        out.insert("count".into(), true.into());
    }
    if ty.deprecated {
        out.insert("deprecated".into(), true.into());
    }
    if let Some(header) = &ty.header {
        out.insert("x-mcp-header".into(), header.clone().into());
    }
}

/// Writes a numeric bound when present.
fn bound(out: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        out.insert(key.into(), js::number(value));
    }
}

/// A validation issue, matching the issues Zod reports.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Issue {
    /// What failed.
    pub(crate) kind: IssueKind,
    /// Human-readable message.
    pub(crate) message: String,
    /// Path to the failing value.
    pub(crate) path: Vec<Value>,
}

/// The kind of a validation issue.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum IssueKind {
    /// The value has the wrong type.
    InvalidType {
        /// The expected type name.
        expected: &'static str,
        /// Zod's numeric format, for integers.
        format: Option<&'static str>,
        /// The received value, reported for non-finite numbers.
        received: Option<&'static str>,
    },
    /// The value is not one of the enum values.
    InvalidValue(Vec<String>),
    /// A string does not match a pattern.
    InvalidFormat {
        /// Zod's format name: `regex` or `datetime`.
        format: &'static str,
        /// The pattern as Zod reports it.
        pattern: String,
    },
    /// The value exceeds a maximum.
    TooBig {
        /// The bound.
        maximum: f64,
        /// The checked type.
        origin: &'static str,
    },
    /// The value is under a minimum.
    TooSmall {
        /// The bound.
        minimum: f64,
        /// The checked type.
        origin: &'static str,
    },
    /// No member of a union accepts the value: the issues of each member, with paths relative
    /// to the union.
    InvalidUnion(Vec<Vec<Issue>>),
}

impl Issue {
    /// Returns the Zod issue code.
    pub(crate) fn code(&self) -> &'static str {
        match self.kind {
            IssueKind::InvalidType { .. } => "invalid_type",
            IssueKind::InvalidValue(_) => "invalid_value",
            IssueKind::InvalidFormat { .. } => "invalid_format",
            IssueKind::TooBig { .. } => "too_big",
            IssueKind::TooSmall { .. } => "too_small",
            IssueKind::InvalidUnion(_) => "invalid_union",
        }
    }

    /// Returns the issue as Zod serializes it in `ZodError.message`, with the same key order.
    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        match &self.kind {
            IssueKind::InvalidType {
                expected,
                format,
                received,
            } => {
                out.insert("expected".into(), (*expected).into());
                if let Some(format) = format {
                    out.insert("format".into(), (*format).into());
                }
                out.insert("code".into(), self.code().into());
                if let Some(received) = received {
                    out.insert("received".into(), (*received).into());
                }
            }
            IssueKind::InvalidValue(values) => {
                out.insert("code".into(), self.code().into());
                out.insert("values".into(), values.clone().into());
            }
            IssueKind::InvalidFormat { format, pattern } => {
                out.insert("origin".into(), "string".into());
                out.insert("code".into(), self.code().into());
                out.insert("format".into(), (*format).into());
                out.insert("pattern".into(), pattern.clone().into());
            }
            IssueKind::InvalidUnion(errors) => {
                out.insert("code".into(), self.code().into());
                let errors = errors
                    .iter()
                    .map(|issues| issues.iter().map(Self::to_json).collect())
                    .collect::<Vec<Value>>();
                out.insert("errors".into(), errors.into());
            }
            IssueKind::TooBig {
                maximum: bound,
                origin,
            }
            | IssueKind::TooSmall {
                minimum: bound,
                origin,
            } => {
                let key = if matches!(self.kind, IssueKind::TooBig { .. }) {
                    "maximum"
                } else {
                    "minimum"
                };
                // Zod's safe-integer check reports its issue with a note and a different key order.
                if *origin == "int" {
                    out.insert("code".into(), self.code().into());
                    out.insert(key.into(), js::number(*bound));
                    out.insert(
                        "note".into(),
                        "Integers must be within the safe integer range.".into(),
                    );
                    out.insert("origin".into(), (*origin).into());
                } else {
                    out.insert("origin".into(), (*origin).into());
                    out.insert("code".into(), self.code().into());
                    out.insert(key.into(), js::number(*bound));
                }
                out.insert("inclusive".into(), true.into());
            }
        }
        out.insert("path".into(), self.path.clone().into());
        out.insert("message".into(), self.message.clone().into());
        Value::Object(out)
    }
}

/// The marker a non-finite number carries through validation, as JSON values hold no NaN or
/// infinities. Coerced flags and environment variables, and config files with numbers beyond the
/// double range, produce it.
pub(crate) const NON_FINITE: &str = "\u{0}incur:non-finite:";

/// Whether a value is the marker of a non-finite number.
fn is_non_finite(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|string| string.starts_with(NON_FINITE))
}

/// Replaces non-finite markers with `null`, as `JSON.stringify` writes infinities.
fn finite(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(finite).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), finite(item)))
                .collect(),
        ),
        value if is_non_finite(value) => Value::Null,
        value => value.clone(),
    }
}

/// Converts input as JavaScript's `Boolean()` or `Number()` does for `z.coerce` schemas.
fn coerce(kind: &Kind, value: Option<&Value>) -> Value {
    let Some(value) = value else {
        return if *kind == Kind::Boolean {
            Value::Bool(false)
        } else {
            crate::parser::number_value(f64::NAN)
        };
    };
    if *kind == Kind::Boolean {
        return Value::Bool(match value {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        });
    }
    let number = match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(_) => return value.clone(),
        Value::String(s) => js::to_number(s),
        Value::Array(_) | Value::Object(_) => f64::NAN,
    };
    crate::parser::number_value(number)
}

/// Validates `value` against `ty`, applying defaults and stripping unknown object keys.
///
/// Returns `None` when an optional value is absent.
pub(crate) fn parse(
    ty: &Type,
    value: Option<&Value>,
    path: &mut Vec<Value>,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let converted = ty.converted.as_deref();
    if value.is_none() {
        if let Some(default) = &ty.default {
            return Some(default.clone());
        }
        // Unknown values accept `undefined`; nulls and unions validate it.
        let checked = converted.is_some_and(|c| c.is_null() || !c.union.is_empty());
        if ty.optional || ty.kind == Kind::Unknown && !checked {
            // `.optional()` still runs a union with a defaulted member, whose `optin` is
            // optional, and drops its issues.
            let members = converted.map(|c| &c.union).filter(|members| {
                ty.optional && members.iter().any(|member| member.default.is_some())
            });
            return members.and_then(|members| parse_union(members, None, path, &mut Vec::new()));
        }
    }
    if let Some(members) = converted
        .map(|c| &c.union)
        .filter(|members| !members.is_empty())
    {
        return parse_union(members, value, path, issues);
    }
    // `z.coerce` also converts a missing value: `Number(undefined)` is `NaN`.
    let coerced =
        (ty.coerce || converted.is_some_and(|c| c.coerce)).then(|| coerce(&ty.kind, value));
    let value = coerced.as_ref().or(value);
    match (&ty.kind, value) {
        (Kind::Enum(values), _) => {
            if let Some(Value::String(string)) = value
                && values.contains(string)
            {
                return Some(Value::String(string.clone()));
            }
            let message = if let [only] = values.as_slice() {
                format!(
                    "Invalid input: expected {}",
                    js::stringify(&only.clone().into())
                )
            } else {
                let list = values
                    .iter()
                    .map(|value| js::stringify(&value.clone().into()))
                    .collect::<Vec<_>>()
                    .join("|");
                format!("Invalid option: expected one of {list}")
            };
            issues.push(Issue {
                kind: IssueKind::InvalidValue(values.clone()),
                message,
                path: path.clone(),
            });
            None
        }
        (_, None) => {
            invalid_type(ty, "undefined", None, path, issues);
            None
        }
        (_, Some(value)) => parse_present(ty, value, path, issues),
    }
}

/// Validates a value that is present in the input.
fn parse_present(
    ty: &Type,
    value: &Value,
    path: &mut Vec<Value>,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    match (&ty.kind, value) {
        (Kind::Array { items, max, min }, Value::Array(values)) => {
            let mut out = Vec::with_capacity(values.len());
            for (index, item) in values.iter().enumerate() {
                path.push(index.into());
                out.push(parse(items, Some(item), path, issues).unwrap_or(Value::Null));
                path.pop();
            }
            #[expect(
                clippy::cast_precision_loss,
                reason = "Array lengths are far below 2^53."
            )]
            let len = values.len() as f64;
            check_bounds(len, *min, *max, "array", path, issues);
            Some(Value::Array(out))
        }
        (Kind::Boolean, Value::Bool(_)) => Some(value.clone()),
        (Kind::Unknown, _) if value.is_null() || !is_null(ty) => Some(finite(value)),
        (Kind::Integer { max, min } | Kind::Number { max, min }, _) => {
            let integer = matches!(ty.kind, Kind::Integer { .. });
            let number = match value {
                Value::Number(number) => number.as_f64(),
                Value::String(string) if string.starts_with(NON_FINITE) => {
                    // Zod names NaN in the message but reports infinities as numbers.
                    let (label, reported) = match &string[NON_FINITE.len()..] {
                        "NaN" => ("NaN", "NaN"),
                        _ => ("number", "Infinity"),
                    };
                    invalid_type(ty, label, Some(reported), path, issues);
                    return None;
                }
                _ => None,
            };
            let Some(number) = number else {
                invalid_type(ty, received(value), None, path, issues);
                return None;
            };
            if integer && number.fract() != 0.0 {
                // Only a finite fraction reports the integer format.
                issues.push(Issue {
                    kind: IssueKind::InvalidType {
                        expected: "int",
                        format: Some("safeint"),
                        received: None,
                    },
                    message: "Invalid input: expected int, received number".into(),
                    path: path.clone(),
                });
                return None;
            }
            if integer {
                let min = min.unwrap_or(-MAX_SAFE_INTEGER);
                let max = max.unwrap_or(MAX_SAFE_INTEGER);
                let origin = if min == -MAX_SAFE_INTEGER && number < min
                    || max == MAX_SAFE_INTEGER && number > max
                {
                    "int"
                } else {
                    "number"
                };
                check_bounds(number, Some(min), Some(max), origin, path, issues);
            } else {
                check_bounds(number, *min, *max, "number", path, issues);
            }
            Some(js::number(number))
        }
        (Kind::Object(fields), Value::Object(map)) => {
            let mut out = Map::new();
            for field in fields {
                path.push(field.name.clone().into());
                if let Some(value) = parse(&field.ty, map.get(&field.name), path, issues) {
                    out.insert(field.name.clone(), value);
                }
                path.pop();
            }
            if ty.converted.as_ref().is_some_and(|c| c.loose) {
                for (key, value) in map {
                    if !out.contains_key(key) && fields.iter().all(|f| &f.name != key) {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
            Some(Value::Object(out))
        }
        (Kind::String { max, min }, Value::String(string)) if !is_non_finite(value) => {
            #[expect(
                clippy::cast_precision_loss,
                reason = "String lengths are far below 2^53."
            )]
            let len = js::utf16_len(string) as f64;
            check_bounds(len, *min, *max, "string", path, issues);
            if let Some((pattern, format)) = ty.converted.as_ref().and_then(|c| c.pattern.as_ref())
                && regex_lite::Regex::new(pattern).is_ok_and(|regex| !regex.is_match(string))
            {
                let (message, reported) = if *format == "datetime" {
                    ("Invalid ISO datetime".to_owned(), pattern.clone())
                } else {
                    (
                        format!("Invalid string: must match pattern /{pattern}/"),
                        format!("/{pattern}/"),
                    )
                };
                issues.push(Issue {
                    kind: IssueKind::InvalidFormat {
                        format,
                        pattern: reported,
                    },
                    message,
                    path: path.clone(),
                });
            }
            Some(value.clone())
        }
        _ => {
            invalid_type(ty, received(value), None, path, issues);
            None
        }
    }
}

/// Validates a value with the members of a union: the first member without issues parses it,
/// as `z.union` does. Otherwise the one member that failed only checks reports its issues, and
/// any other failure reports every member's issues.
fn parse_union(
    members: &[Type],
    value: Option<&Value>,
    path: &[Value],
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    let mut failures = Vec::new();
    for member in members {
        let mut found = Vec::new();
        let parsed = parse(member, value, &mut Vec::new(), &mut found);
        if found.is_empty() {
            return parsed;
        }
        failures.push(found);
    }
    let mut continuing = failures.iter().filter(|found| !aborted(found));
    if let (Some(found), None) = (continuing.next(), continuing.next()) {
        issues.extend(found.iter().map(|issue| Issue {
            path: [path, &issue.path].concat(),
            ..issue.clone()
        }));
        return None;
    }
    issues.push(Issue {
        kind: IssueKind::InvalidUnion(failures),
        message: "Invalid input".into(),
        path: path.to_vec(),
    });
    None
}

/// Whether issues stop Zod from trying later checks: type and value mismatches do, while failed
/// bounds and formats let parsing continue.
fn aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|issue| {
        !matches!(
            issue.kind,
            IssueKind::TooBig { .. } | IssueKind::TooSmall { .. } | IssueKind::InvalidFormat { .. }
        )
    })
}

/// Whether a schema is `type: "null"`.
fn is_null(ty: &Type) -> bool {
    ty.converted.as_ref().is_some_and(|c| c.is_null())
}

/// Reports an `invalid_type` issue for `ty`.
fn invalid_type(
    ty: &Type,
    received: &str,
    reported: Option<&'static str>,
    path: &[Value],
    issues: &mut Vec<Issue>,
) {
    let expected = match ty.kind {
        Kind::Unknown if is_null(ty) => "null",
        Kind::Array { .. } => "array",
        Kind::Boolean => "boolean",
        Kind::Integer { .. } | Kind::Number { .. } => "number",
        Kind::Object(_) => "object",
        // Enums and unknown values never report a type mismatch.
        Kind::Enum(_) | Kind::String { .. } | Kind::Unknown => "string",
    };
    issues.push(Issue {
        kind: IssueKind::InvalidType {
            expected,
            format: None,
            received: reported,
        },
        message: format!("Invalid input: expected {expected}, received {received}"),
        path: path.to_vec(),
    });
}

/// Reports `too_small` and `too_big` issues.
fn check_bounds(
    value: f64,
    min: Option<f64>,
    max: Option<f64>,
    origin: &'static str,
    path: &[Value],
    issues: &mut Vec<Issue>,
) {
    let unit = match origin {
        "string" => " characters",
        "array" => " items",
        _ => "",
    };
    let verb = if unit.is_empty() { "be" } else { "have" };
    if let Some(minimum) = min
        && value < minimum
    {
        issues.push(Issue {
            kind: IssueKind::TooSmall { minimum, origin },
            message: format!(
                "Too small: expected {origin} to {verb} >={}{unit}",
                js::number_to_string(minimum)
            ),
            path: path.to_vec(),
        });
    }
    if let Some(maximum) = max
        && value > maximum
    {
        issues.push(Issue {
            kind: IssueKind::TooBig { maximum, origin },
            message: format!(
                "Too big: expected {origin} to {verb} <={}{unit}",
                js::number_to_string(maximum)
            ),
            path: path.to_vec(),
        });
    }
}

/// Returns Zod's name for the type of a received value.
fn received(value: &Value) -> &'static str {
    match value {
        value if is_non_finite(value) => "number",
        Value::Array(_) => "array",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        Value::Number(_) => "number",
        Value::Object(_) => "object",
        Value::String(_) => "string",
    }
}
