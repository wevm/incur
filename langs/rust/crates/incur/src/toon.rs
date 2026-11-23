//! TOON encoding, ported from `@toon-format/toon` 2.3.1 with its default options: two-space
//! indentation, comma delimiters, and no key folding.

use std::fmt::Write as _;

use serde_json::{Map, Value};

use crate::js;

/// Encodes a JSON value as TOON. Scalars format as `String(value)`, as incur's formatter does.
pub(crate) fn encode(value: &Value) -> String {
    let mut lines = Vec::new();
    match value {
        Value::Array(items) => array_lines(&mut lines, None, items, 0),
        Value::Object(map) => object_lines(&mut lines, map, 0),
        scalar => return js::to_string(scalar),
    }
    lines.join("\n")
}

/// Whether a value is a JSON primitive.
fn is_primitive(value: &Value) -> bool {
    !matches!(value, Value::Array(_) | Value::Object(_))
}

/// Encodes a primitive value.
fn primitive(value: &Value) -> String {
    match value {
        Value::String(string) => string_literal(string),
        value => js::to_string(value),
    }
}

/// Encodes a string, quoting it when it would be ambiguous unquoted.
fn string_literal(value: &str) -> String {
    if is_safe_unquoted(value) {
        value.to_owned()
    } else {
        format!("\"{}\"", escape(value))
    }
}

/// Escapes backslashes, quotes, and control characters.
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if u32::from(ch) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(ch));
            }
            ch => out.push(ch),
        }
    }
    out
}

/// Whether a string encodes unquoted without changing meaning.
fn is_safe_unquoted(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim_matches(js::is_whitespace)
        && !matches!(value, "true" | "false" | "null")
        && !is_numeric_like(value)
        && !value.contains([':', '"', '\\', '[', ']', '{', '}', ','])
        && !value.chars().any(|ch| u32::from(ch) < 0x20)
        && !value.starts_with('-')
}

/// Matches `/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i` or `/^0\d+$/`.
fn is_numeric_like(value: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|byte| byte.is_ascii_digit());
    let body = value.strip_prefix('-').unwrap_or(value);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(index) => (&body[..index], Some(&body[index + 1..])),
        None => (body, None),
    };
    let mantissa_ok = match mantissa.split_once('.') {
        Some((int, frac)) => digits(int) && digits(frac),
        None => digits(mantissa),
    };
    let exponent_ok =
        exponent.is_none_or(|exp| digits(exp.strip_prefix(['+', '-']).unwrap_or(exp)));
    mantissa_ok && exponent_ok
}

/// Encodes a key, quoting it unless it matches `/^[A-Z_][\w.]*$/i`.
fn key(value: &str) -> String {
    let mut chars = value.chars();
    let valid = chars
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.');
    if valid {
        value.to_owned()
    } else {
        format!("\"{}\"", escape(value))
    }
}

/// Formats an array header such as `key[2]{a,b}:`.
fn header(length: usize, key_name: Option<&str>, fields: Option<&[&String]>) -> String {
    let mut out = String::new();
    if let Some(name) = key_name {
        out.push_str(&key(name));
    }
    let _ = write!(out, "[{length}]");
    if let Some(fields) = fields {
        let fields = fields.iter().map(|field| key(field)).collect::<Vec<_>>();
        let _ = write!(out, "{{{}}}", fields.join(","));
    }
    out.push(':');
    out
}

/// Joins encoded primitives with the delimiter.
fn join(values: &[&Value]) -> String {
    values
        .iter()
        .map(|value| primitive(value))
        .collect::<Vec<_>>()
        .join(",")
}

/// Indents a line by `depth` levels.
fn line(depth: usize, content: &str) -> String {
    format!("{}{content}", "  ".repeat(depth))
}

/// Indents a list item by `depth` levels.
fn item(depth: usize, content: &str) -> String {
    line(depth, &format!("- {content}"))
}

/// Encodes every key-value pair of an object.
fn object_lines(lines: &mut Vec<String>, map: &Map<String, Value>, depth: usize) {
    for (name, value) in map {
        let encoded = key(name);
        match value {
            Value::Array(items) => array_lines(lines, Some(name), items, depth),
            Value::Object(nested) => {
                lines.push(line(depth, &format!("{encoded}:")));
                object_lines(lines, nested, depth + 1);
            }
            value => lines.push(line(depth, &format!("{encoded}: {}", primitive(value)))),
        }
    }
}

/// Encodes an inline array of primitives.
fn inline(values: &[Value], key_name: Option<&str>) -> String {
    let head = header(values.len(), key_name, None);
    if values.is_empty() {
        return head;
    }
    format!("{head} {}", join(&values.iter().collect::<Vec<_>>()))
}

/// Encodes an array under an optional key.
fn array_lines(lines: &mut Vec<String>, key_name: Option<&str>, items: &[Value], depth: usize) {
    if items.is_empty() {
        let content = key_name.map_or_else(|| "[]".to_owned(), |name| format!("{}: []", key(name)));
        lines.push(line(depth, &content));
        return;
    }
    if items.iter().all(is_primitive) {
        lines.push(line(depth, &inline(items, key_name)));
        return;
    }
    if items
        .iter()
        .all(|value| matches!(value, Value::Array(inner) if inner.iter().all(is_primitive)))
    {
        lines.push(line(depth, &header(items.len(), key_name, None)));
        for value in items {
            if let Value::Array(inner) = value {
                lines.push(item(depth + 1, &inline(inner, None)));
            }
        }
        return;
    }
    if let Some(fields) = tabular_header(items) {
        lines.push(line(depth, &header(items.len(), key_name, Some(&fields))));
        rows(lines, items, &fields, depth + 1);
        return;
    }
    lines.push(line(depth, &header(items.len(), key_name, None)));
    for value in items {
        list_item(lines, value, depth + 1);
    }
}

/// Returns the shared keys when every item is an object of the same primitive-valued keys.
fn tabular_header(items: &[Value]) -> Option<Vec<&String>> {
    let Value::Object(first) = items.first()? else {
        return None;
    };
    let fields = first.keys().collect::<Vec<_>>();
    if fields.is_empty() {
        return None;
    }
    let tabular = items.iter().all(|value| match value {
        Value::Object(row) => {
            row.len() == fields.len()
                && fields
                    .iter()
                    .all(|field| row.get(*field).is_some_and(is_primitive))
        }
        _ => false,
    });
    tabular.then_some(fields)
}

/// Writes tabular rows.
fn rows(lines: &mut Vec<String>, items: &[Value], fields: &[&String], depth: usize) {
    for value in items {
        let values = fields
            .iter()
            .map(|field| value.get(field.as_str()).unwrap_or(&Value::Null))
            .collect::<Vec<_>>();
        lines.push(line(depth, &join(&values)));
    }
}

/// Encodes one item of a mixed list.
fn list_item(lines: &mut Vec<String>, value: &Value, depth: usize) {
    match value {
        Value::Array(inner) if inner.iter().all(is_primitive) => {
            lines.push(item(depth, &inline(inner, None)));
        }
        Value::Array(inner) => {
            lines.push(item(depth, &header(inner.len(), None, None)));
            for value in inner {
                list_item(lines, value, depth + 1);
            }
        }
        Value::Object(map) => object_item(lines, map, depth),
        value => lines.push(item(depth, &primitive(value))),
    }
}

/// Encodes an object as a list item, with its first field on the marker line.
fn object_item(lines: &mut Vec<String>, map: &Map<String, Value>, depth: usize) {
    let mut entries = map.iter();
    let Some((first_key, first)) = entries.next() else {
        lines.push(line(depth, "-"));
        return;
    };
    let rest = entries
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Map<_, _>>();
    let encoded = key(first_key);
    match first {
        Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_object) => {
            if let Some(fields) = tabular_header(items) {
                lines.push(item(
                    depth,
                    &header(items.len(), Some(first_key), Some(&fields)),
                ));
                rows(lines, items, &fields, depth + 2);
            } else {
                lines.push(item(
                    depth,
                    &format!("{encoded}{}", header(items.len(), None, None)),
                ));
                for value in items {
                    list_item(lines, value, depth + 2);
                }
            }
        }
        Value::Array(items) if items.is_empty() => {
            lines.push(item(depth, &format!("{encoded}: []")));
        }
        Value::Array(items) if items.iter().all(is_primitive) => {
            lines.push(item(depth, &format!("{encoded}{}", inline(items, None))));
        }
        Value::Array(items) => {
            lines.push(item(
                depth,
                &format!("{encoded}{}", header(items.len(), None, None)),
            ));
            for value in items {
                list_item(lines, value, depth + 2);
            }
        }
        Value::Object(nested) => {
            lines.push(item(depth, &format!("{encoded}:")));
            object_lines(lines, nested, depth + 2);
        }
        value => lines.push(item(depth, &format!("{encoded}: {}", primitive(value)))),
    }
    object_lines(lines, &rest, depth + 1);
}
