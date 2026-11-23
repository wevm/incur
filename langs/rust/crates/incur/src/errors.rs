//! Command errors and call-to-action suggestions.

use std::fmt::{self, Write as _};

use serde_json::{Map, Value};

use crate::{js, schema};

/// A command failure with a machine-readable code, rendered like the TypeScript `c.error()`.
///
/// Return it from a handler or middleware. Strings convert to an error with code `UNKNOWN`.
///
/// ```
/// let error = incur::Error::new("NOT_AUTHENTICATED", "GitHub token not found")
///     .hint("Tokens expire after 30 days.")
///     .cta(incur::CtaBlock::new([incur::Cta::new("auth login").description("Log in")]));
/// assert_eq!(error.code, "NOT_AUTHENTICATED");
/// ```
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Error {
    /// Machine-readable error code.
    pub code: String,
    /// Suggested commands to run next.
    pub cta: Option<Box<CtaBlock>>,
    /// Process exit code. Defaults to 1.
    pub exit_code: Option<i32>,
    /// Per-field validation errors.
    pub field_errors: Option<Vec<FieldError>>,
    /// Actionable hint.
    pub hint: Option<String>,
    /// Human-readable message.
    pub message: String,
    /// Whether the operation can be retried.
    pub retryable: Option<bool>,
}

impl Error {
    /// Creates an error with a code and message.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            ..Self::default()
        }
    }

    /// Sets suggested commands.
    #[must_use]
    pub fn cta(mut self, cta: CtaBlock) -> Self {
        self.cta = Some(Box::new(cta));
        self
    }

    /// Sets the process exit code.
    #[must_use]
    pub fn exit_code(mut self, code: i32) -> Self {
        self.exit_code = Some(code);
        self
    }

    /// Sets an actionable hint.
    #[must_use]
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// Sets whether the operation can be retried.
    #[must_use]
    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = Some(retryable);
        self
    }

    /// Creates an `UNKNOWN` error from any error value.
    pub fn unknown(error: impl fmt::Display) -> Self {
        Self::new("UNKNOWN", error.to_string())
    }

    /// Returns the `error` object of the output envelope.
    pub(crate) fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("code".into(), self.code.clone().into());
        out.insert("message".into(), self.message.clone().into());
        if let Some(hint) = &self.hint {
            out.insert("hint".into(), hint.clone().into());
        }
        if let Some(retryable) = self.retryable {
            out.insert("retryable".into(), retryable.into());
        }
        if let Some(field_errors) = &self.field_errors {
            out.insert(
                "fieldErrors".into(),
                field_errors.iter().map(FieldError::to_value).collect(),
            );
        }
        Value::Object(out)
    }

    /// Builds a validation error from schema issues, with Zod's message and details.
    pub(crate) fn validation(issues: &[schema::Issue], input: &Value) -> Self {
        let short = issues
            .iter()
            .map(|issue| issue.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        let details = js::stringify_pretty(&issues.iter().map(schema::Issue::to_json).collect());
        let field_errors = issues
            .iter()
            .map(|issue| {
                let (expected, received) = match &issue.kind {
                    schema::IssueKind::InvalidType {
                        expected, received, ..
                    } => (*expected, received.unwrap_or_default()),
                    _ => ("", ""),
                };
                FieldError {
                    code: issue.code().into(),
                    expected: expected.into(),
                    message: issue.message.clone(),
                    missing: !has_path(input, &issue.path),
                    path: issue
                        .path
                        .iter()
                        .map(js::to_string)
                        .collect::<Vec<_>>()
                        .join("."),
                    received: received.into(),
                }
            })
            .collect();
        Self {
            field_errors: Some(field_errors),
            ..Self::new("VALIDATION_ERROR", format!("{short}\n\nDetails: {details}"))
        }
    }
}

/// Whether the input contains the full issue path.
fn has_path(input: &Value, path: &[Value]) -> bool {
    let mut current = input;
    for part in path {
        // Issue paths hold object keys and array indices.
        let next = match part.as_u64().and_then(|index| usize::try_from(index).ok()) {
            Some(index) => current.get(index),
            None => part.as_str().and_then(|key| current.get(key)),
        };
        let Some(next) = next else {
            return false;
        };
        current = next;
    }
    true
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Self::new("UNKNOWN", message)
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Self::new("UNKNOWN", message)
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::unknown(error)
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::unknown(error)
    }
}

/// A field-level validation error.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FieldError {
    /// The Zod issue code.
    pub code: String,
    /// The expected type.
    pub expected: String,
    /// Human-readable message.
    pub message: String,
    /// Whether the input omitted the field.
    pub missing: bool,
    /// The dotted field path.
    pub path: String,
    /// The received value, when reported.
    pub received: String,
}

impl FieldError {
    /// Returns the field error as output data.
    fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("code".into(), self.code.clone().into());
        out.insert("missing".into(), self.missing.into());
        out.insert("path".into(), self.path.clone().into());
        out.insert("expected".into(), self.expected.clone().into());
        out.insert("received".into(), self.received.clone().into());
        out.insert("message".into(), self.message.clone().into());
        Value::Object(out)
    }
}

/// A suggested command.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cta {
    /// Positional arguments appended as bare values. `true` renders `<name>`.
    pub args: Map<String, Value>,
    /// The command to run, without the CLI name.
    pub command: String,
    /// What the command does.
    pub description: Option<String>,
    /// Options appended as `--key value`. `true` renders `--key <key>`.
    pub options: Map<String, Value>,
}

impl Cta {
    /// Creates a suggestion for a command.
    pub fn new(command: impl Into<String>) -> Self {
        Self {
            command: command.into(),
            ..Self::default()
        }
    }

    /// Appends a positional argument.
    #[must_use]
    pub fn arg(mut self, name: impl Into<String>, value: impl Into<Value>) -> Self {
        self.args.insert(name.into(), value.into());
        self
    }

    /// Sets the description.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Appends an option.
    #[must_use]
    pub fn option(mut self, name: impl Into<String>, value: impl Into<Value>) -> Self {
        self.options.insert(name.into(), value.into());
        self
    }
}

impl From<&str> for Cta {
    fn from(command: &str) -> Self {
        Self::new(command)
    }
}

/// A list of suggested commands with an optional label.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CtaBlock {
    /// Suggested commands.
    pub commands: Vec<Cta>,
    /// Label. Defaults to `Suggested command:` or `Suggested commands:`.
    pub description: Option<String>,
}

impl CtaBlock {
    /// Creates a block of suggestions.
    pub fn new(commands: impl IntoIterator<Item = impl Into<Cta>>) -> Self {
        Self {
            commands: commands.into_iter().map(Into::into).collect(),
            description: None,
        }
    }

    /// Sets the label.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// A suggestion with the CLI name and arguments folded into one command line.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FormattedCta {
    /// The full command line.
    pub(crate) command: String,
    /// What the command does.
    pub(crate) description: Option<String>,
}

/// A formatted block of suggestions.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FormattedCtaBlock {
    /// Formatted suggestions.
    pub(crate) commands: Vec<FormattedCta>,
    /// Label.
    pub(crate) description: String,
}

impl FormattedCtaBlock {
    /// Formats a block, prefixing commands with the CLI name. Empty blocks format as `None`.
    pub(crate) fn new(name: &str, block: Option<&CtaBlock>) -> Option<Self> {
        let block = block.filter(|block| !block.commands.is_empty())?;
        let description = block.description.clone().unwrap_or_else(|| {
            if block.commands.len() == 1 {
                "Suggested command:".into()
            } else {
                "Suggested commands:".into()
            }
        });
        let program = name.split(' ').next().unwrap_or(name);
        let commands = block
            .commands
            .iter()
            .map(|cta| {
                let prefixed =
                    cta.command == program || cta.command.starts_with(&format!("{program} "));
                let mut command = if prefixed {
                    cta.command.clone()
                } else {
                    format!("{name} {}", cta.command)
                };
                for (key, value) in &cta.args {
                    let _ = if *value == Value::Bool(true) {
                        write!(command, " <{key}>")
                    } else {
                        write!(command, " {}", js::to_string(value))
                    };
                }
                for (key, value) in &cta.options {
                    let _ = if *value == Value::Bool(true) {
                        write!(command, " --{key} <{key}>")
                    } else {
                        write!(command, " --{key} {}", js::to_string(value))
                    };
                }
                FormattedCta {
                    command,
                    description: cta.description.clone().filter(|d| !d.is_empty()),
                }
            })
            .collect();
        Some(Self {
            commands,
            description,
        })
    }

    /// Returns the block as output data.
    pub(crate) fn to_value(&self) -> Value {
        let commands = self
            .commands
            .iter()
            .map(|cta| {
                let mut out = Map::new();
                out.insert("command".into(), cta.command.clone().into());
                if let Some(description) = &cta.description {
                    out.insert("description".into(), description.clone().into());
                }
                Value::Object(out)
            })
            .collect();
        let mut out = Map::new();
        out.insert("description".into(), self.description.clone().into());
        out.insert("commands".into(), commands);
        Value::Object(out)
    }

    /// Renders the block for a terminal.
    pub(crate) fn human(&self) -> String {
        let width = self
            .commands
            .iter()
            .map(|cta| js::utf16_len(&cta.command))
            .max()
            .unwrap_or(0);
        let mut lines = vec![String::new(), self.description.clone()];
        for cta in &self.commands {
            let description = cta.description.as_ref().map_or_else(String::new, |d| {
                format!("  {}# {d}", " ".repeat(width - js::utf16_len(&cta.command)))
            });
            lines.push(format!("  {}{description}", cta.command));
        }
        lines.join("\n")
    }
}

/// Renders an error for a terminal.
pub(crate) fn human_error(error: &Error) -> String {
    let prefix = if error.code == "UNKNOWN" || error.code == "COMMAND_NOT_FOUND" {
        "Error".to_owned()
    } else {
        format!("Error ({})", error.code)
    };
    let mut out = format!("{prefix}: {}", error.message);
    for field in error.field_errors.iter().flatten() {
        let _ = write!(out, "\n  {}: {}", field.path, field.message);
    }
    if let Some(hint) = error.hint.as_ref().filter(|hint| !hint.is_empty()) {
        let _ = write!(out, "\nHint: {hint}");
    }
    out
}
