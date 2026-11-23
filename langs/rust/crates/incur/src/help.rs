//! Help text for command groups and commands.

use serde_json::Value;

use crate::js;
use crate::schema::Type;

/// A command listed in help output.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// What the command does.
    pub description: Option<String>,
    /// The command name.
    pub name: String,
}

/// An alternative usage line.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    /// Arguments shown as `<name>`.
    pub args: Vec<String>,
    /// Options shown as `--name <name>`.
    pub options: Vec<String>,
    /// Text before the command, such as `cat file.txt |`.
    pub prefix: Option<String>,
    /// Text after the command, such as `| head`.
    pub suffix: Option<String>,
}

/// A formatted usage example: the arguments after the command name and a description.
#[derive(Clone, Debug, PartialEq)]
pub struct Example {
    /// The arguments and options after the command name.
    pub command: String,
    /// What the example shows.
    pub description: Option<String>,
}

/// Looks up an environment variable.
pub type EnvSource<'a> = dyn Fn(&str) -> Option<String> + 'a;

/// Options for [`format_root`] and [`format_command`].
#[derive(Clone, Copy, Default)]
pub struct Options<'a> {
    /// Alternative binary names.
    pub aliases: &'a [String],
    /// Positional arguments schema.
    pub args: Option<&'a Type>,
    /// Subcommands to list.
    pub commands: Option<&'a [Entry]>,
    /// Config file flag name, such as `config`.
    pub config_flag: Option<&'a str>,
    /// Description.
    pub description: Option<&'a str>,
    /// Environment variables schema.
    pub env: Option<&'a Type>,
    /// Environment lookup for showing which variables are set.
    pub env_source: Option<&'a EnvSource<'a>>,
    /// Usage examples.
    pub examples: Option<&'a [Example]>,
    /// Global options schema.
    pub globals: Option<&'a Type>,
    /// Hide the global options section.
    pub hide_global_options: bool,
    /// Hide the skills integration.
    pub hide_skills: bool,
    /// Text shown after examples.
    pub hint: Option<&'a str>,
    /// Options schema.
    pub options: Option<&'a Type>,
    /// Whether to show root-only integrations and flags.
    pub root: bool,
    /// Alternative usage lines.
    pub usage: &'a [Usage],
    /// Version shown in the title.
    pub version: Option<&'a str>,
}

/// Formats the title line.
fn title(name: &str, options: &Options<'_>) -> String {
    let title = options
        .version
        .map_or_else(|| name.to_owned(), |version| format!("{name}@{version}"));
    match options.description.filter(|d| !d.is_empty()) {
        Some(description) => format!("{title} \u{2014} {description}"),
        None => title,
    }
}

/// Pads a name to a UTF-16 width.
fn pad(value: &str, width: usize) -> String {
    format!(
        "{value}{}",
        " ".repeat(width.saturating_sub(js::utf16_len(value)))
    )
}

/// Lists commands with aligned descriptions.
fn commands(lines: &mut Vec<String>, entries: &[Entry]) {
    let width = entries
        .iter()
        .map(|e| js::utf16_len(&e.name))
        .max()
        .unwrap_or(0);
    for entry in entries {
        match entry.description.as_deref().filter(|d| !d.is_empty()) {
            Some(description) => {
                lines.push(format!("  {}  {description}", pad(&entry.name, width)));
            }
            None => lines.push(format!("  {}", entry.name)),
        }
    }
}

/// Formats help for a command group.
pub fn format_root(name: &str, options: &Options<'_>) -> String {
    let mut lines = vec![
        title(name, options),
        String::new(),
        format!("Usage: {name} <command>"),
    ];
    if !options.aliases.is_empty() {
        lines.push(format!("Aliases: {}", options.aliases.join(", ")));
    }
    if let Some(entries) = options.commands.filter(|c| !c.is_empty()) {
        lines.push(String::new());
        lines.push("Commands:".into());
        commands(&mut lines, entries);
    }
    global_lines(&mut lines, options);
    lines.join("\n")
}

/// Formats help for a command.
pub fn format_command(name: &str, options: &Options<'_>) -> String {
    let mut lines = vec![title(name, options), String::new()];

    if options.usage.is_empty() {
        let mut synopsis = vec![name.to_owned()];
        for field in options.args.map(Type::fields).unwrap_or_default() {
            let type_name = field.ty.type_name();
            let mut label = if type_name.contains('|') {
                type_name.clone()
            } else {
                field.name.clone()
            };
            if type_name == "array" {
                label.push_str("...");
            }
            synopsis.push(if field.ty.is_optional() {
                format!("[{label}]")
            } else {
                format!("<{label}>")
            });
        }
        let opts = if options.options.is_some() {
            " [options]"
        } else {
            ""
        };
        let subcommands = if options.commands.is_some_and(|c| !c.is_empty()) {
            " | <command>"
        } else {
            ""
        };
        lines.push(format!("Usage: {}{opts}{subcommands}", synopsis.join(" ")));
    } else {
        for (index, usage) in options.usage.iter().enumerate() {
            let mut parts = Vec::new();
            parts.extend(usage.prefix.clone().filter(|p| !p.is_empty()));
            parts.push(name.to_owned());
            parts.extend(usage.args.iter().map(|a| format!("<{a}>")));
            parts.extend(usage.options.iter().map(|o| format!("--{o} <{o}>")));
            parts.extend(usage.suffix.clone().filter(|s| !s.is_empty()));
            let prefix = if index == 0 { "Usage: " } else { "       " };
            lines.push(format!("{prefix}{}", parts.join(" ")));
        }
    }
    if !options.aliases.is_empty() {
        lines.push(format!("Aliases: {}", options.aliases.join(", ")));
    }

    if let Some(args) = options.args.filter(|a| !a.fields().is_empty()) {
        lines.push(String::new());
        lines.push("Arguments:".into());
        let width = args
            .fields()
            .iter()
            .map(|f| js::utf16_len(&f.name))
            .max()
            .unwrap_or(0);
        for field in args.fields() {
            let description = field.ty.description.clone().unwrap_or_default();
            lines.push(format!("  {}  {description}", pad(&field.name, width)));
        }
    }

    if let Some(schema) = options.options.filter(|o| !o.fields().is_empty()) {
        lines.push(String::new());
        lines.push("Options:".into());
        option_lines(&mut lines, schema);
    }

    if let Some(examples) = options.examples.filter(|e| !e.is_empty()) {
        lines.push(String::new());
        lines.push("Examples:".into());
        let full = |e: &Example| {
            if e.command.is_empty() {
                name.to_owned()
            } else {
                format!("{name} {}", e.command)
            }
        };
        let width = examples
            .iter()
            .map(|e| js::utf16_len(&full(e)))
            .max()
            .unwrap_or(0);
        for example in examples {
            let command = full(example);
            match example.description.as_deref().filter(|d| !d.is_empty()) {
                Some(description) => {
                    lines.push(format!("  {}  # {description}", pad(&command, width)));
                }
                None => lines.push(format!("  {command}")),
            }
        }
    }

    if let Some(hint) = options.hint.filter(|h| !h.is_empty()) {
        lines.push(String::new());
        lines.push(hint.to_owned());
    }

    if let Some(entries) = options.commands.filter(|c| !c.is_empty()) {
        lines.push(String::new());
        lines.push("Commands:".into());
        commands(&mut lines, entries);
    }

    if !options.hide_global_options {
        global_lines(&mut lines, options);
    }

    if let Some(env) = options.env.filter(|e| !e.fields().is_empty()) {
        lines.push(String::new());
        lines.push("Environment Variables:".into());
        let width = env
            .fields()
            .iter()
            .map(|f| js::utf16_len(&f.name))
            .max()
            .unwrap_or(0);
        for field in env.fields() {
            let mut parts = vec![field.ty.description.clone().unwrap_or_default()];
            if let Some(value) = options.env_source.and_then(|source| source(&field.name)) {
                parts.push(format!("set: {}", redact(&value)));
            }
            if let Some(default) = display_default(&field.ty) {
                parts.push(format!("default: {default}"));
            }
            let description = if parts.len() > 1 {
                format!("{} ({})", parts[0], parts[1..].join(", "))
            } else {
                parts.remove(0)
            };
            lines.push(format!("  {}  {description}", pad(&field.name, width)));
        }
    }

    lines.join("\n")
}

/// Returns the default shown in help, omitting empty arrays.
fn display_default(ty: &Type) -> Option<String> {
    match &ty.default {
        None => None,
        Some(Value::Array(items)) if items.is_empty() => None,
        Some(value) => Some(js::to_string(value)),
    }
}

/// Lists options with flags, aliases, value hints, and defaults.
fn option_lines(lines: &mut Vec<String>, schema: &Type) {
    let entries = schema
        .fields()
        .iter()
        .map(|field| {
            let type_name = field.ty.type_name();
            let kebab = js::to_kebab(&field.name);
            let hint = if type_name == "boolean" {
                String::new()
            } else {
                format!(" <{type_name}>")
            };
            let flag = match field.alias {
                Some(alias) => format!("--{kebab}, -{alias}{hint}"),
                None => format!("--{kebab}{hint}"),
            };
            let default = if type_name == "boolean" && field.ty.default == Some(Value::Bool(false))
            {
                None
            } else {
                display_default(&field.ty)
            };
            let prefix = if field.ty.deprecated {
                "[deprecated] "
            } else {
                ""
            };
            let description = field.ty.description.clone().unwrap_or_default();
            let description = match default {
                Some(default) => format!("{prefix}{description} (default: {default})"),
                None => format!("{prefix}{description}"),
            };
            (flag, description)
        })
        .collect::<Vec<_>>();
    let width = entries
        .iter()
        .map(|(f, _)| js::utf16_len(f))
        .max()
        .unwrap_or(0);
    for (flag, description) in entries {
        lines.push(format!("  {}  {description}", pad(&flag, width)));
    }
}

/// Built-in integrations listed in root help: name, description.
const INTEGRATIONS: [(&str, &str); 3] = [
    ("completions", "Generate shell completion script"),
    ("mcp", "Register as MCP server (add, doctor)"),
    ("skills", "Sync skill files to agents (add, list)"),
];

/// Writes the integrations and global options sections.
fn global_lines(lines: &mut Vec<String>, options: &Options<'_>) {
    if options.root {
        let builtins = INTEGRATIONS
            .iter()
            .filter(|(name, _)| !options.hide_skills || *name != "skills")
            .collect::<Vec<_>>();
        let width = builtins.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
        lines.push(String::new());
        lines.push("Integrations:".into());
        for (name, description) in builtins {
            lines.push(format!("  {}  {description}", pad(name, width)));
        }
    }

    if let Some(globals) = options.globals.filter(|g| !g.fields().is_empty()) {
        lines.push(String::new());
        lines.push("Custom Global Options:".into());
        option_lines(lines, globals);
    }

    let mut flags: Vec<(String, &str)> = Vec::new();
    if let Some(flag) = options.config_flag {
        flags.push((
            format!("--{flag} <path>"),
            "Load JSON option defaults from a file",
        ));
        flags.push((
            format!("--no-{flag}"),
            "Disable JSON option defaults for this run",
        ));
    }
    flags.extend([
        (
            "--filter-output <keys>".into(),
            "Filter output by key paths (e.g. foo,bar.baz,a[0,3])",
        ),
        ("--format <toon|json|yaml|md|jsonl>".into(), "Output format"),
        ("--help".into(), "Show help"),
        ("--llms, --llms-full".into(), "Print LLM-readable manifest"),
        ("--schema".into(), "Show JSON Schema for command"),
        (
            "--token-count".into(),
            "Print token count of output (instead of output)",
        ),
        ("--token-limit <n>".into(), "Limit output to n tokens"),
        ("--token-offset <n>".into(), "Skip first n tokens of output"),
        ("--full-output".into(), "Show full output envelope"),
    ]);
    if options.root {
        flags.push(("--mcp".into(), "Start as MCP stdio server"));
        flags.push(("--version".into(), "Show version"));
    }
    flags.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
    let width = flags.iter().map(|(f, _)| f.len()).max().unwrap_or(0);
    lines.push(String::new());
    lines.push("Global Options:".into());
    for (flag, description) in flags {
        lines.push(format!("  {}  {description}", pad(&flag, width)));
    }
}

/// Redacts a value, keeping only the last four characters of long values.
fn redact(value: &str) -> String {
    let units = value.encode_utf16().collect::<Vec<_>>();
    if units.len() <= 4 {
        return "****".into();
    }
    format!(
        "****{}",
        String::from_utf16_lossy(&units[units.len() - 4..])
    )
}
