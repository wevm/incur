//! Output serialization in TOON, JSON, YAML, Markdown, and JSONL.

use std::fmt;
use std::str::FromStr;

use serde_json::{Map, Value};

use crate::{js, toon, yaml};

/// A supported output format.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Format {
    /// Pretty-printed JSON.
    Json,
    /// One JSON value per line.
    Jsonl,
    /// Markdown tables and headings.
    Md,
    /// Token-oriented object notation, the default.
    #[default]
    Toon,
    /// YAML.
    Yaml,
}

impl Format {
    /// Every format, in the order help output lists them.
    pub const ALL: [Self; 5] = [Self::Toon, Self::Json, Self::Yaml, Self::Md, Self::Jsonl];

    /// Returns the format name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Jsonl => "jsonl",
            Self::Md => "md",
            Self::Toon => "toon",
            Self::Yaml => "yaml",
        }
    }
}

impl fmt::Display for Format {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Format {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|format| format.as_str() == value)
            .ok_or(())
    }
}

/// Serializes a value in the given format. `null` formats as an empty string.
pub fn format(value: &Value, format: Format) -> String {
    match (format, value) {
        (_, Value::Null) => String::new(),
        (Format::Json, Value::String(string)) => {
            let trimmed = string.trim_matches(js::is_whitespace);
            // `JSON.stringify` writes infinities as `null`.
            if (trimmed.starts_with('{') || trimmed.starts_with('['))
                && let Ok(parsed) = js::json_parse(string, |_| Value::Null)
            {
                return js::stringify_pretty(&js::normalize(parsed));
            }
            js::stringify_pretty(value)
        }
        (Format::Json, value) => js::stringify_pretty(value),
        (Format::Jsonl, Value::Array(items)) => items
            .iter()
            .map(js::stringify)
            .collect::<Vec<_>>()
            .join("\n"),
        (Format::Jsonl, value) => js::stringify(value),
        (Format::Yaml, value) => yaml::stringify(value),
        (Format::Md, value) => markdown(value),
        (Format::Toon, value) => toon::encode(value),
    }
}

/// Whether a value is a scalar.
fn is_scalar(value: &Value) -> bool {
    !matches!(value, Value::Array(_) | Value::Object(_))
}

/// Whether every value of an object is a scalar.
fn is_flat(map: &Map<String, Value>) -> bool {
    map.values().all(is_scalar)
}

/// Renders a value outside a table: arrays that nest values as compact JSON, anything else as
/// `String(value)` does.
fn text(value: &Value) -> String {
    match value {
        Value::Array(items) if !items.iter().all(is_scalar) => js::stringify(value),
        value => js::to_string(value),
    }
}

/// Whether a value is a non-empty array of objects.
fn is_array_of_objects(value: &Value) -> bool {
    matches!(value, Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_object))
}

/// Pads a string to a UTF-16 width.
fn pad(value: &str, width: usize) -> String {
    let len = js::utf16_len(value);
    format!("{value}{}", " ".repeat(width.saturating_sub(len)))
}

/// Renders an aligned Markdown table.
fn table(headers: &[String], rows: &[Vec<String>]) -> String {
    let widths = headers
        .iter()
        .enumerate()
        .map(|(i, header)| {
            rows.iter()
                .map(|row| js::utf16_len(row.get(i).map_or("", String::as_str)))
                .chain([js::utf16_len(header)])
                .max()
                .unwrap_or(0)
        })
        .collect::<Vec<_>>();
    let header_row = headers
        .iter()
        .zip(&widths)
        .map(|(h, w)| pad(h, *w))
        .collect::<Vec<_>>()
        .join(" | ");
    let sep = widths
        .iter()
        .map(|w| "-".repeat(w + 2))
        .collect::<Vec<_>>()
        .join("|");
    let body = rows
        .iter()
        .map(|row| {
            let cells = widths
                .iter()
                .enumerate()
                .map(|(i, w)| pad(row.get(i).map_or("", String::as_str), *w))
                .collect::<Vec<_>>()
                .join(" | ");
            format!("| {cells} |")
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("| {header_row} |\n|{sep}|\n{body}")
}

/// Renders a key-value table from a flat object.
fn kv_table(map: &Map<String, Value>) -> String {
    let rows = map
        .iter()
        .map(|(key, value)| vec![key.clone(), js::to_string(value)])
        .collect::<Vec<_>>();
    table(&["Key".into(), "Value".into()], &rows)
}

/// Renders a columnar table from an array of objects. Nested cells render as compact JSON.
fn columnar_table(items: &[Value]) -> String {
    let mut keys: Vec<String> = Vec::new();
    for map in items.iter().filter_map(Value::as_object) {
        for key in map.keys() {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    let rows = items
        .iter()
        .map(|item| {
            keys.iter()
                .map(|key| match item.get(key) {
                    None | Some(Value::Null) => String::new(),
                    // Escape pipes so the JSON stays inside its cell.
                    Some(value @ (Value::Array(_) | Value::Object(_))) => {
                        js::stringify(value).replace('|', "\\|")
                    }
                    Some(value) => js::to_string(value),
                })
                .collect()
        })
        .collect::<Vec<_>>();
    table(&keys, &rows)
}

/// Formats a value as Markdown: tables for flat objects and arrays of objects, and headed
/// sections for nested objects.
fn markdown(value: &Value) -> String {
    match value {
        Value::Array(items) if is_array_of_objects(value) => columnar_table(items),
        Value::Object(map) if is_flat(map) => kv_table(map),
        Value::Object(map) => sections(map, &[]),
        value => text(value),
    }
}

/// Formats each entry of a nested object as a section headed by its dotted path.
fn sections(map: &Map<String, Value>, path: &[String]) -> String {
    let heading = |path: &[String], body: String| format!("## {}\n\n{body}", path.join("."));
    map.iter()
        .map(|(key, val)| {
            let mut child = path.to_vec();
            child.push(key.clone());
            match val {
                Value::Object(nested) if is_flat(nested) => heading(&child, kv_table(nested)),
                Value::Object(nested) => sections(nested, &child),
                Value::Array(items) if is_array_of_objects(val) => {
                    heading(&child, columnar_table(items))
                }
                val => heading(&child, text(val)),
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
