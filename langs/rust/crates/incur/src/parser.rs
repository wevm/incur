//! Parses argv tokens and environment variables against schemas.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::errors::Error;
use crate::js;
use crate::schema::{self, Kind, Type};

/// Parsed positional arguments and options.
#[derive(Clone, Debug, PartialEq)]
pub struct Parsed {
    /// Positional arguments.
    pub args: Value,
    /// Named options.
    pub options: Value,
}

/// Lookup tables for option names and aliases.
struct Names<'a> {
    /// Short alias to option name.
    aliases: IndexMap<char, &'a str>,
    /// The options schema.
    schema: Option<&'a Type>,
}

impl<'a> Names<'a> {
    /// Builds lookup tables for an options schema.
    fn new(schema: Option<&'a Type>) -> Self {
        let aliases = schema
            .map(Type::fields)
            .unwrap_or_default()
            .iter()
            .filter_map(|field| Some((field.alias?, field.name.as_str())))
            .collect();
        Self { aliases, schema }
    }

    /// Resolves a long option, accepting kebab-case for camelCase names.
    fn long(&self, raw: &str) -> Option<&'a str> {
        let fields = self.schema?.fields();
        fields
            .iter()
            .find(|field| {
                js::to_kebab(&field.name) == raw && js::to_kebab(&field.name) != field.name
            })
            .or_else(|| fields.iter().find(|field| field.name == raw))
            .map(|field| field.name.as_str())
    }

    /// Returns the schema of an option.
    fn ty(&self, name: &str) -> Option<&'a Type> {
        self.schema?.field(name).map(|field| &field.ty)
    }

    /// Whether an option counts repeated flags.
    fn is_count(&self, name: &str) -> bool {
        self.ty(name).is_some_and(|ty| ty.count)
    }

    /// Whether an option is a boolean flag.
    fn is_boolean(&self, name: &str) -> bool {
        self.ty(name).is_some_and(|ty| ty.kind == Kind::Boolean)
    }

    /// Whether an option reads the next token as its value.
    fn takes_value(&self, name: &str) -> bool {
        !self.is_count(name) && !self.is_boolean(name)
    }
}

/// Error for an unknown flag.
fn parse_error(message: impl Into<String>) -> Error {
    Error::new("UNKNOWN", message)
}

/// Reads a `true` or `false` token as a boolean.
fn literal(token: Option<&String>) -> Option<bool> {
    match token?.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// Increments a counter option.
fn increment(raw: &mut Map<String, Value>, name: &str) {
    let next = raw.get(name).and_then(Value::as_i64).unwrap_or(0) + 1;
    raw.insert(name.to_owned(), next.into());
}

/// Sets an option value, collecting values of array options.
fn set(raw: &mut Map<String, Value>, names: &Names<'_>, name: &str, value: &str) {
    let array = names
        .ty(name)
        .is_some_and(|ty| matches!(ty.kind, Kind::Array { .. }));
    if array {
        match raw.get_mut(name) {
            Some(Value::Array(items)) => items.push(value.into()),
            _ => {
                raw.insert(name.to_owned(), Value::Array(vec![value.into()]));
            }
        }
    } else {
        raw.insert(name.to_owned(), value.into());
    }
}

/// Coerces a raw string to the option's type before validation.
fn coerce(value: Value, ty: Option<&Type>) -> Value {
    match (ty.map(|ty| &ty.kind), &value) {
        (Some(Kind::Number { .. } | Kind::Integer { .. }), Value::String(string)) => {
            number_value(js::to_number(string))
        }
        (Some(Kind::Boolean), Value::String(string)) => Value::Bool(string == "true"),
        _ => value,
    }
}

/// Wraps a coerced number, marking non-finite results for validation.
pub(crate) fn number_value(number: f64) -> Value {
    if number.is_finite() {
        js::number(number)
    } else {
        Value::String(format!(
            "{}{}",
            schema::NON_FINITE,
            js::number_to_string(number)
        ))
    }
}

/// Validates an object against a schema.
pub(crate) fn validate(schema: &Type, input: &Map<String, Value>) -> Result<Value, Error> {
    let input = Value::Object(input.clone());
    let mut issues = Vec::new();
    let parsed = schema::parse(schema, Some(&input), &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        return Ok(parsed.unwrap_or_else(|| Value::Object(Map::new())));
    }
    Err(Error::validation(&issues, &input))
}

/// Parses argv tokens against an args schema and an options schema.
///
/// `defaults` are config-file option defaults, applied before argv values.
///
/// # Errors
///
/// Returns an `UNKNOWN` error for unknown flags and missing values, and a `VALIDATION_ERROR` when
/// values do not match the schemas.
pub fn parse(
    argv: &[String],
    args: Option<&Type>,
    options: Option<&Type>,
    defaults: Option<&Map<String, Value>>,
) -> Result<Parsed, Error> {
    let names = Names::new(options);
    let mut positionals = Vec::new();
    let mut raw = Map::new();
    // `true`/`false` tokens after boolean flags, kept as positionals until the arg count is known.
    let mut candidates = Vec::new();
    // The argv index of the last token that set each boolean option.
    let mut last_boolean = IndexMap::new();

    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        if token == "--" {
            positionals.extend_from_slice(&argv[i + 1..]);
            break;
        } else if let Some(rest) = token.strip_prefix("--no-").filter(|rest| !rest.is_empty()) {
            let name = names
                .long(rest)
                .ok_or_else(|| parse_error(format!("Unknown flag: {token}")))?;
            raw.insert(name.to_owned(), false.into());
            last_boolean.insert(name, i);
            i += 1;
        } else if let Some(body) = token.strip_prefix("--") {
            if let Some((flag, value)) = body.split_once('=') {
                let name = names
                    .long(flag)
                    .ok_or_else(|| parse_error(format!("Unknown flag: --{flag}")))?;
                set(&mut raw, &names, name, value);
                if names.is_boolean(name) {
                    last_boolean.insert(name, i);
                }
                i += 1;
            } else {
                let name = names
                    .long(body)
                    .ok_or_else(|| parse_error(format!("Unknown flag: {token}")))?;
                if names.is_count(name) {
                    increment(&mut raw, name);
                    i += 1;
                } else if names.is_boolean(name) {
                    raw.insert(name.to_owned(), true.into());
                    last_boolean.insert(name, i);
                    if let Some(value) = literal(argv.get(i + 1)) {
                        candidates.push((positionals.len(), name, value, i));
                        positionals.push(argv[i + 1].clone());
                        i += 1;
                    }
                    i += 1;
                } else {
                    let value = argv
                        .get(i + 1)
                        .ok_or_else(|| parse_error(format!("Missing value for flag: {token}")))?;
                    set(&mut raw, &names, name, value);
                    i += 2;
                }
            }
        } else if token.len() >= 2 && token.starts_with('-') {
            let chars = token[1..].chars().collect::<Vec<_>>();
            for (j, short) in chars.iter().enumerate() {
                let name = *names
                    .aliases
                    .get(short)
                    .ok_or_else(|| parse_error(format!("Unknown flag: -{short}")))?;
                let last = j == chars.len() - 1;
                if names.is_count(name) {
                    increment(&mut raw, name);
                } else if names.is_boolean(name) {
                    raw.insert(name.to_owned(), true.into());
                    last_boolean.insert(name, i);
                    if let Some(value) = literal(argv.get(i + 1)).filter(|_| last) {
                        candidates.push((positionals.len(), name, value, i));
                        positionals.push(argv[i + 1].clone());
                        i += 1;
                    }
                } else if !last {
                    return Err(parse_error(format!(
                        "Non-boolean flag -{short} must be last in a stacked alias"
                    )));
                } else {
                    let value = argv
                        .get(i + 1)
                        .ok_or_else(|| parse_error(format!("Missing value for flag: -{short}")))?;
                    set(&mut raw, &names, name, value);
                    i += 1;
                }
            }
            i += 1;
        } else {
            positionals.push(token.clone());
            i += 1;
        }
    }

    // A spaced `true`/`false` after a boolean flag is its value only when no positional slot is
    // left for it, earliest first; a later assignment of the same flag still wins.
    let fields = args.map_or(&[][..], Type::fields);
    let variadic = fields
        .last()
        .is_some_and(|field| matches!(field.ty.kind, Kind::Array { .. }));
    if !variadic {
        let mut consumed = 0;
        for &(_, name, value, flag) in &candidates {
            if positionals.len() - consumed <= fields.len() {
                break;
            }
            consumed += 1;
            if last_boolean.get(name) == Some(&flag) {
                raw.insert(name.to_owned(), value.into());
            }
        }
        let mut index = 0;
        positionals.retain(|_| {
            index += 1;
            !candidates[..consumed].iter().any(|c| c.0 == index - 1)
        });
    }

    // Positionals fill args in order; a final array arg collects the rest.
    let mut raw_args = Map::new();
    for (j, field) in fields.iter().enumerate() {
        if matches!(field.ty.kind, Kind::Array { .. }) {
            if j != fields.len() - 1 {
                return Err(parse_error(format!(
                    "Variadic arg \"{}\" must be the last key in the args schema",
                    field.name
                )));
            }
            let rest = positionals.get(j..).unwrap_or_default();
            if !rest.is_empty() {
                raw_args.insert(
                    field.name.clone(),
                    rest.iter().cloned().map(Value::from).collect(),
                );
            }
        } else if let Some(value) = positionals.get(j) {
            raw_args.insert(field.name.clone(), value.clone().into());
        }
    }
    if let Some(extra) = positionals.get(fields.len()).filter(|_| !variadic) {
        return Err(parse_error(format!("Unexpected argument: {extra}")));
    }
    let args = match args {
        Some(schema) => validate(schema, &raw_args)?,
        None => Value::Object(Map::new()),
    };

    let mut merged = normalize_defaults(defaults, &names)?;
    for (name, value) in raw {
        let ty = names.ty(&name);
        merged.insert(name, coerce(value, ty));
    }
    let options = match options {
        Some(schema) => validate(schema, &merged)?,
        None => Value::Object(Map::new()),
    };
    Ok(Parsed { args, options })
}

/// Parses a config section on its own: normalizes its keys as [`parse`] does and validates only
/// the options it sets.
pub(crate) fn parse_defaults(
    defaults: &Map<String, Value>,
    schema: Option<&Type>,
) -> Result<Map<String, Value>, Error> {
    let normalized = normalize_defaults(Some(defaults), &Names::new(schema))?;
    // Without a schema, any key is unknown, so nothing is left to validate.
    let empty = Type::object(Vec::new());
    validate_passed(schema.unwrap_or(&empty), &normalized)
}

/// Coerces and validates the globals passed in argv against their fields only, so missing
/// required globals are not an error.
pub(crate) fn parse_passed_globals(
    schema: &Type,
    raw: Map<String, Value>,
) -> Result<Map<String, Value>, Error> {
    let names = Names::new(Some(schema));
    let coerced = raw
        .into_iter()
        .map(|(name, value)| {
            let ty = names.ty(&name);
            (name, coerce(value, ty))
        })
        .collect();
    validate_passed(schema, &coerced)
}

/// Validates values against only their fields of an object schema, in input order.
fn validate_passed(schema: &Type, input: &Map<String, Value>) -> Result<Map<String, Value>, Error> {
    let fields = input
        .keys()
        .filter_map(|key| schema.field(key).cloned())
        .collect();
    let parsed = validate(&Type::object(fields), input)?;
    Ok(parsed.as_object().cloned().unwrap_or_default())
}

/// Normalizes config-file defaults and rejects unknown keys.
fn normalize_defaults(
    defaults: Option<&Map<String, Value>>,
    names: &Names<'_>,
) -> Result<Map<String, Value>, Error> {
    let mut out = Map::new();
    for (raw, value) in defaults.into_iter().flatten() {
        let name = names
            .long(raw)
            .ok_or_else(|| parse_error(format!("Unknown config option: {raw}")))?;
        out.insert(name.to_owned(), value.clone());
    }
    Ok(out)
}

/// Parses environment variables against a schema.
///
/// # Errors
///
/// Returns a `VALIDATION_ERROR` when values do not match the schema.
pub fn parse_env(schema: &Type, env: &dyn Fn(&str) -> Option<String>) -> Result<Value, Error> {
    let mut raw = Map::new();
    for field in schema.fields() {
        if let Some(value) = env(&field.name) {
            let coerced = match field.ty.kind {
                Kind::Number { .. } | Kind::Integer { .. } => number_value(js::to_number(&value)),
                Kind::Boolean => Value::Bool(value == "true" || value == "1"),
                _ => Value::String(value),
            };
            raw.insert(field.name.clone(), coerced);
        }
    }
    validate(schema, &raw)
}

/// Options for [`parse_globals`].
#[derive(Clone, Copy, Debug, Default)]
pub struct GlobalsOptions<'a> {
    /// The command that receives the remaining tokens. Values of its value-taking options pass
    /// through untouched, and an unknown flag stops global parsing. `Some(None)` means the command
    /// is not yet known.
    pub command: Option<Option<&'a Type>>,
    /// Whether to validate parsed globals.
    pub validate: bool,
}

/// Parses known global options, passing other tokens through in order.
///
/// # Errors
///
/// Returns an error for missing values and invalid global values.
pub fn parse_globals(
    argv: &[String],
    schema: &Type,
    options: GlobalsOptions<'_>,
) -> Result<(Value, Vec<String>), Error> {
    let names = Names::new(Some(schema));
    let command = options.command.map(Names::new);
    let mut rest = Vec::new();
    let mut raw = Map::new();

    let mut i = 0;
    while i < argv.len() {
        let token = &argv[i];
        if token == "--"
            || command
                .as_ref()
                .is_some_and(|c| is_unknown_flag(token, &names, c))
        {
            rest.extend(argv[i..].iter().cloned());
            break;
        }
        if let Some(body) = token.strip_prefix("--no-").filter(|body| !body.is_empty()) {
            match names.long(body) {
                Some(name) => {
                    raw.insert(name.to_owned(), false.into());
                }
                None => rest.push(token.clone()),
            }
            i += 1;
        } else if let Some(body) = token.strip_prefix("--") {
            if let Some((flag, value)) = body.split_once('=') {
                match names.long(flag) {
                    Some(name) => set(&mut raw, &names, name, value),
                    None => rest.push(token.clone()),
                }
                i += 1;
            } else if let Some(name) = names.long(body) {
                if names.is_count(name) {
                    increment(&mut raw, name);
                    i += 1;
                } else if names.is_boolean(name) {
                    raw.insert(name.to_owned(), true.into());
                    i += 1;
                } else {
                    let value = argv
                        .get(i + 1)
                        .ok_or_else(|| parse_error(format!("Missing value for flag: {token}")))?;
                    set(&mut raw, &names, name, value);
                    i += 2;
                }
            } else {
                rest.push(token.clone());
                i += 1;
                let takes = command
                    .as_ref()
                    .and_then(|c| c.long(body).map(|name| c.takes_value(name)))
                    .unwrap_or(false);
                if takes && let Some(value) = argv.get(i) {
                    rest.push(value.clone());
                    i += 1;
                }
            }
        } else if token.len() >= 2 && token.starts_with('-') {
            let chars = token[1..].chars().collect::<Vec<_>>();
            let known = chars.iter().all(|ch| {
                names.aliases.contains_key(ch)
                    || command.as_ref().is_some_and(|c| c.aliases.contains_key(ch))
            });
            if !known {
                rest.push(token.clone());
                i += 1;
                continue;
            }
            let mut command_chars = String::new();
            let mut command_value = None;
            for (j, short) in chars.iter().enumerate() {
                let last = j == chars.len() - 1;
                let Some(&name) = names.aliases.get(short) else {
                    command_chars.push(*short);
                    let takes = command
                        .as_ref()
                        .and_then(|c| c.aliases.get(short).map(|name| c.takes_value(name)))
                        .unwrap_or(false);
                    if !takes {
                        continue;
                    }
                    if !last {
                        return Err(parse_error(format!(
                            "Non-boolean flag -{short} must be last in a stacked alias"
                        )));
                    }
                    command_value = argv.get(i + 1).cloned();
                    if command_value.is_some() {
                        i += 1;
                    }
                    continue;
                };
                if names.is_count(name) {
                    increment(&mut raw, name);
                } else if names.is_boolean(name) {
                    raw.insert(name.to_owned(), true.into());
                } else if !last {
                    return Err(parse_error(format!(
                        "Non-boolean flag -{short} must be last in a stacked alias"
                    )));
                } else {
                    let value = argv
                        .get(i + 1)
                        .ok_or_else(|| parse_error(format!("Missing value for flag: -{short}")))?;
                    set(&mut raw, &names, name, value);
                    i += 1;
                }
            }
            if !command_chars.is_empty() {
                rest.push(format!("-{command_chars}"));
            }
            if let Some(value) = command_value {
                rest.push(value);
            }
            i += 1;
        } else {
            rest.push(token.clone());
            i += 1;
        }
    }

    if !options.validate {
        return Ok((Value::Object(raw), rest));
    }
    let coerced = raw
        .into_iter()
        .map(|(name, value)| {
            let ty = names.ty(&name);
            (name, coerce(value, ty))
        })
        .collect();
    Ok((validate(schema, &coerced)?, rest))
}

/// Whether a flag that may read the next token is neither a global nor a command option.
fn is_unknown_flag(token: &str, globals: &Names<'_>, command: &Names<'_>) -> bool {
    if let Some(raw) = token.strip_prefix("--") {
        if token.starts_with("--no-") || token.contains('=') {
            return false;
        }
        return globals.long(raw).is_none() && command.long(raw).is_none();
    }
    if !token.starts_with('-') || token.len() < 2 {
        return false;
    }
    token[1..]
        .chars()
        .any(|ch| !globals.aliases.contains_key(&ch) && !command.aliases.contains_key(&ch))
}
