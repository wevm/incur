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

/// A generated skill file.
pub(crate) struct File {
    /// The directory relative to the skills root, empty for a root-level file.
    pub(crate) dir: String,
    /// The `SKILL.md` contents, without a trailing newline.
    pub(crate) content: String,
    /// The skill name from the frontmatter.
    pub(crate) name: String,
    /// The skill description from the frontmatter.
    pub(crate) description: String,
}

/// Splits commands into skill files, one per group of `depth` leading command segments. Depth
/// 0 puts every command in one root-level file.
pub(crate) fn split(
    name: &str,
    commands: &[CommandInfo],
    depth: usize,
    groups: &IndexMap<String, String>,
) -> Vec<File> {
    if depth == 0 {
        return vec![render_group(
            name,
            name,
            commands,
            groups,
            Some(name),
            String::new(),
        )];
    }
    let mut buckets: IndexMap<String, Vec<CommandInfo>> = IndexMap::new();
    for cmd in commands {
        let key = match &cmd.name {
            None => slugify(name),
            Some(path) => path.split(' ').take(depth).collect::<Vec<_>>().join("-"),
        };
        buckets.entry(key).or_default().push(cmd.clone());
    }
    let mut buckets = buckets.into_iter().collect::<Vec<_>>();
    buckets.sort_by(|a, b| crate::js::locale_compare(&a.0, &b.0));
    buckets
        .into_iter()
        .map(|(dir, cmds)| {
            let prefix = cmds[0]
                .name
                .as_deref()
                .map(|path| path.split(' ').take(depth).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let title = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {prefix}")
            };
            let prefix = (!prefix.is_empty()).then_some(prefix.as_str());
            render_group(name, &title, &cmds, groups, prefix, dir)
        })
        .collect()
}

/// Renders a skill file: frontmatter, then command bodies.
fn render_group(
    cli: &str,
    title: &str,
    cmds: &[CommandInfo],
    groups: &IndexMap<String, String>,
    prefix: Option<&str>,
    dir: String,
) -> File {
    let fallback = match cmds {
        [only] => only.description.clone().filter(|d| !d.is_empty()),
        _ => None,
    };
    let desc = prefix.and_then(|p| groups.get(p).cloned()).or(fallback);
    let description = match desc {
        Some(desc) => format!(
            "{}. Run `{title} --help` for usage details.",
            desc.strip_suffix('.').unwrap_or(&desc)
        ),
        None => format!("Run `{title} --help` for usage details."),
    };
    let name = slugify(title);
    let mut meta = serde_json::Map::new();
    meta.insert("name".into(), name.clone().into());
    meta.insert("description".into(), description.clone().into());
    meta.insert("requires_bin".into(), cli.into());
    meta.insert("command".into(), title.into());
    let frontmatter = crate::yaml::stringify_unfolded(&Value::Object(meta));
    let body = cmds
        .iter()
        .map(|cmd| body(cli, cmd, 1))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    File {
        dir,
        content: format!("---\n{}\n---\n\n{body}", frontmatter.trim_end()),
        name,
        description,
    }
}

/// Converts text to a lowercase slug of letters, digits, and single hyphens.
pub(crate) fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in value.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
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
    let mut collapsed = String::new();
    for ch in out.chars() {
        if !(ch == '-' && collapsed.ends_with('-')) {
            collapsed.push(ch);
        }
    }
    let trimmed = collapsed.strip_prefix('-').unwrap_or(&collapsed);
    trimmed.strip_suffix('-').unwrap_or(trimmed).to_owned()
}

/// Returns a deterministic hash of the command structure, for skill staleness checks.
pub(crate) fn hash(commands: &[CommandInfo]) -> String {
    let data = commands
        .iter()
        .map(|cmd| {
            let mut out = serde_json::Map::new();
            if let Some(name) = &cmd.name {
                out.insert("name".into(), name.clone().into());
            }
            if let Some(description) = &cmd.description {
                out.insert("description".into(), description.clone().into());
            }
            if let Some(hint) = &cmd.hint {
                out.insert("hint".into(), hint.clone().into());
            }
            for (key, ty) in [
                ("args", &cmd.args),
                ("env", &cmd.env),
                ("options", &cmd.options),
                ("output", &cmd.output),
            ] {
                if let Some(ty) = ty {
                    out.insert(key.into(), schema::json_schema(ty));
                }
            }
            Value::Object(out)
        })
        .collect();
    let digest = sha256_hex(crate::js::stringify(&Value::Array(data)).as_bytes());
    digest[..16].to_owned()
}

/// Returns the lowercase hexadecimal SHA-256 digest of bytes.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes)
        .iter()
        .fold(String::new(), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

/// Reads the `name` and `description` of a skill file's YAML frontmatter, or returns `None`
/// when the frontmatter is not valid YAML.
///
/// The description is the text JavaScript displays for it, and `None` when it is falsy.
pub(crate) fn frontmatter(content: &str) -> Option<(Option<Value>, Option<String>)> {
    let mut meta = crate::yaml::frontmatter(content)?;
    let description = meta
        .get("description")
        .filter(|value| {
            !matches!(value, Value::Null | Value::Bool(false))
                && value.as_f64() != Some(0.0)
                && value.as_str() != Some("")
        })
        .map(crate::js::to_string);
    Some((meta.remove("name"), description))
}
