//! Markdown command manifests for `--llms` and `--llms-full`.

use std::fmt::Write as _;

use indexmap::IndexMap;
use serde_json::Value;

use crate::help::Example;
use crate::schema::{self, Type};

/// A command described in a manifest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CommandInfo {
    /// Positional arguments schema.
    pub args: Option<Type>,
    /// What the command does.
    pub description: Option<String>,
    /// Environment variables schema.
    pub env: Option<Type>,
    /// Examples with full command lines after the CLI name.
    pub examples: Vec<Example>,
    /// Extra guidance.
    pub hint: Option<String>,
    /// The subcommand path. `None` for the root command.
    pub name: Option<String>,
    /// Options schema.
    pub options: Option<Type>,
    /// Output schema.
    pub output: Option<Type>,
}

/// Returns the JSON Schema type name, mapping `integer` to `number`.
fn type_name(prop: Option<&Value>) -> String {
    match prop.and_then(|p| p.get("type")).and_then(Value::as_str) {
        Some("integer") => "number".into(),
        Some(name) => name.into(),
        None => "unknown".into(),
    }
}

/// Returns the names of required properties.
fn required(json: &Value) -> Vec<&str> {
    json.get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// Builds a command signature with argument placeholders.
fn signature(cli: &str, cmd: &CommandInfo) -> String {
    let base = cmd
        .name
        .as_ref()
        .map_or_else(|| cli.to_owned(), |name| format!("{cli} {name}"));
    let Some(args) = &cmd.args else {
        return base;
    };
    let json = schema::json_schema(args);
    let required = required(&json);
    let names = args
        .fields()
        .iter()
        .map(|field| {
            let array = json["properties"][&field.name]["type"] == "array";
            let label = if array {
                format!("{}...", field.name)
            } else {
                field.name.clone()
            };
            if required.contains(&field.name.as_str()) {
                format!("<{label}>")
            } else {
                format!("[{label}]")
            }
        })
        .collect::<Vec<_>>();
    format!("{base} {}", names.join(" "))
}

/// Generates the compact command index `--llms` prints.
pub fn index(name: &str, commands: &[CommandInfo], description: Option<&str>) -> String {
    let mut lines = vec![format!("# {name}")];
    if let Some(description) = description.filter(|d| !d.is_empty()) {
        lines.push(String::new());
        lines.push(description.to_owned());
    }
    lines.push(String::new());
    lines.push("| Command | Description |".into());
    lines.push("|---------|-------------|".into());
    for cmd in commands {
        lines.push(format!(
            "| `{}` | {} |",
            signature(name, cmd),
            cmd.description.as_deref().unwrap_or_default()
        ));
    }
    lines.push(String::new());
    lines.push(format!(
        "Run `{name} --llms-full` for full manifest. Run `{name} <command> --schema` for argument details."
    ));
    lines.join("\n")
}

/// Generates the full Markdown manifest `--llms-full` prints.
pub fn generate(name: &str, commands: &[CommandInfo], groups: &IndexMap<String, String>) -> String {
    if groups.is_empty() {
        return commands
            .iter()
            .map(|cmd| body(name, cmd, 1))
            .collect::<Vec<_>>()
            .join("\n\n");
    }
    let mut sections = vec![format!("# {name}")];
    let mut last: Option<String> = None;
    for cmd in commands {
        let segment = cmd
            .name
            .as_deref()
            .and_then(|n| n.split(' ').next())
            .unwrap_or_default()
            .to_owned();
        if last.as_ref() != Some(&segment) {
            last = Some(segment.clone());
            if !segment.is_empty() {
                sections.push(match groups.get(&segment).filter(|d| !d.is_empty()) {
                    Some(description) => format!("## {name} {segment}\n\n{description}"),
                    None => format!("## {name} {segment}"),
                });
            }
        }
        sections.push(body(name, cmd, if segment.is_empty() { 2 } else { 3 }));
    }
    sections.join("\n\n")
}

/// Renders one command's heading and sections.
fn body(cli: &str, cmd: &CommandInfo, level: usize) -> String {
    let full = cmd
        .name
        .as_ref()
        .map_or_else(|| cli.to_owned(), |name| format!("{cli} {name}"));
    let mut sections = Vec::new();
    let mut heading = format!("{} {full}", "#".repeat(level));
    if let Some(description) = cmd.description.as_deref().filter(|d| !d.is_empty()) {
        let _ = write!(heading, "\n\n{description}");
    }
    sections.push(heading);
    let sub = "#".repeat(level + 1);

    if let Some(args) = &cmd.args {
        let json = schema::json_schema(args);
        let required = required(&json);
        let rows = args
            .fields()
            .iter()
            .map(|field| {
                let req = if required.contains(&field.name.as_str()) {
                    "yes"
                } else {
                    "no"
                };
                format!(
                    "| `{}` | `{}` | {req} | {} |",
                    field.name,
                    type_name(json["properties"].get(&field.name)),
                    field.ty.description.as_deref().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>();
        sections.push(format!(
            "{sub} Arguments\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n{}",
            rows.join("\n")
        ));
    }

    if let Some(env) = &cmd.env {
        let json = schema::json_schema(env);
        let required = required(&json);
        let rows = env
            .fields()
            .iter()
            .map(|field| {
                let prop = json["properties"].get(&field.name);
                let default = default_cell(prop);
                let req = if required.contains(&field.name.as_str()) {
                    "yes"
                } else {
                    "no"
                };
                format!(
                    "| `{}` | `{}` | {req} | {default} | {} |",
                    field.name,
                    type_name(prop),
                    field.ty.description.as_deref().unwrap_or_default()
                )
            })
            .collect::<Vec<_>>();
        sections.push(format!(
            "{sub} Environment Variables\n\n| Name | Type | Required | Default | Description |\n|------|------|----------|---------|-------------|\n{}",
            rows.join("\n")
        ));
    }

    if let Some(options) = &cmd.options {
        let json = schema::json_schema(options);
        let rows = options
            .fields()
            .iter()
            .map(|field| {
                let prop = json["properties"].get(&field.name);
                let raw = field.ty.description.as_deref().unwrap_or_default();
                let description = if field.ty.deprecated {
                    format!("**Deprecated.** {raw}")
                } else {
                    raw.to_owned()
                };
                format!(
                    "| `--{}` | `{}` | {} | {description} |",
                    field.name,
                    type_name(prop),
                    default_cell(prop)
                )
            })
            .collect::<Vec<_>>();
        sections.push(format!(
            "{sub} Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n{}",
            rows.join("\n")
        ));
    }

    if let Some(output) = &cmd.output {
        let json = schema::json_schema(output);
        match schema_table(&json, "") {
            Some(table) => sections.push(format!("{sub} Output\n\n{table}")),
            None => sections.push(format!(
                "{sub} Output\n\nType: `{}`",
                type_name(Some(&json))
            )),
        }
    }

    if !cmd.examples.is_empty() {
        let lines = cmd
            .examples
            .iter()
            .map(|example| {
                let comment = example
                    .description
                    .as_deref()
                    .filter(|d| !d.is_empty())
                    .map_or_else(String::new, |d| format!("# {d}\n"));
                format!("{comment}{cli} {}", example.command)
            })
            .collect::<Vec<_>>();
        sections.push(format!(
            "{sub} Examples\n\n```sh\n{}\n```",
            lines.join("\n\n")
        ));
    }

    if let Some(hint) = cmd.hint.as_deref().filter(|h| !h.is_empty()) {
        sections.push(format!("> {hint}"));
    }
    sections.join("\n\n")
}

/// Formats a default value cell.
fn default_cell(prop: Option<&Value>) -> String {
    match prop.and_then(|p| p.get("default")) {
        Some(value) => {
            let text = crate::js::to_string(value);
            if text.is_empty() {
                String::new()
            } else {
                format!("`{text}`")
            }
        }
        None => String::new(),
    }
}

/// Renders an object JSON Schema as a Markdown table, expanding nested objects.
fn schema_table(schema: &Value, prefix: &str) -> Option<String> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return None;
    }
    let properties = schema.get("properties").and_then(Value::as_object)?;
    if properties.is_empty() {
        return None;
    }
    let required = required(schema);
    let mut rows = Vec::new();
    for (key, prop) in properties {
        let name = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let req = if required.contains(&key.as_str()) {
            "yes"
        } else {
            "no"
        };
        let description = prop
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        rows.push(format!(
            "| `{name}` | `{}` | {req} | {description} |",
            type_name(Some(prop))
        ));
        let nested = match prop.get("type").and_then(Value::as_str) {
            Some("object") => schema_table(prop, &name),
            Some("array") => prop
                .get("items")
                .and_then(|items| schema_table(items, &format!("{name}[]"))),
            _ => None,
        };
        if let Some(nested) = nested {
            rows.extend(nested.lines().skip(2).map(str::to_owned));
        }
    }
    Some(format!(
        "| Field | Type | Required | Description |\n|-------|------|----------|-------------|\n{}",
        rows.join("\n")
    ))
}
