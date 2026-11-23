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
        }
    }

    /// Creates an object schema from its fields.
    pub fn object(fields: Vec<Field>) -> Self {
        Self::new(Kind::Object(fields))
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
    pub(crate) fn is_optional(&self) -> bool {
        self.optional && self.default.is_none()
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
}

impl Issue {
    /// Returns the Zod issue code.
    pub(crate) fn code(&self) -> &'static str {
        match self.kind {
            IssueKind::InvalidType { .. } => "invalid_type",
            IssueKind::InvalidValue(_) => "invalid_value",
            IssueKind::TooBig { .. } => "too_big",
            IssueKind::TooSmall { .. } => "too_small",
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

/// The marker a coerced non-finite number carries through validation. JSON has no NaN.
pub(crate) const NON_FINITE: &str = "\u{0}incur:non-finite:";

/// Validates `value` against `ty`, applying defaults and stripping unknown object keys.
///
/// Returns `None` when an optional value is absent.
pub(crate) fn parse(
    ty: &Type,
    value: Option<&Value>,
    path: &mut Vec<Value>,
    issues: &mut Vec<Issue>,
) -> Option<Value> {
    if value.is_none() {
        if let Some(default) = &ty.default {
            return Some(default.clone());
        }
        if ty.optional || ty.kind == Kind::Unknown {
            return None;
        }
    }
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
        (Kind::Boolean, Value::Bool(_)) | (Kind::Unknown, _) => Some(value.clone()),
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
            Some(Value::Object(out))
        }
        (Kind::String { max, min }, Value::String(string)) => {
            #[expect(
                clippy::cast_precision_loss,
                reason = "String lengths are far below 2^53."
            )]
            let len = js::utf16_len(string) as f64;
            check_bounds(len, *min, *max, "string", path, issues);
            Some(value.clone())
        }
        _ => {
            invalid_type(ty, received(value), None, path, issues);
            None
        }
    }
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
        Value::Array(_) => "array",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        Value::Number(_) => "number",
        Value::Object(_) => "object",
        Value::String(_) => "string",
    }
}
