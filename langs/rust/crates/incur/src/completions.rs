//! Dynamic shell completions for bash, fish, nushell, and zsh.

use std::fmt;
use std::str::FromStr;

use serde_json::{Map, Value};

use crate::js;
use crate::schema::{Field, Kind, Type};

/// A supported shell.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Shell {
    /// Bash.
    Bash,
    /// Fish.
    Fish,
    /// Nushell.
    Nushell,
    /// Zsh.
    Zsh,
}

impl Shell {
    /// Every shell, in help order.
    pub const ALL: [Self; 4] = [Self::Bash, Self::Fish, Self::Nushell, Self::Zsh];

    /// Returns the shell name.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bash => "bash",
            Self::Fish => "fish",
            Self::Nushell => "nushell",
            Self::Zsh => "zsh",
        }
    }
}

impl fmt::Display for Shell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Shell {
    type Err = ();

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|s| s.as_str() == value)
            .ok_or(())
    }
}

/// A completion candidate.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    /// Description shown beside the value.
    pub description: Option<String>,
    /// Whether the shell must not append a space, as for command groups.
    pub no_space: bool,
    /// The completion value.
    pub value: String,
}

/// A command tree node that completions walk.
pub(crate) enum Node<'a> {
    /// A group with subcommands and an optional root command.
    Group {
        /// Subcommands, aliases resolved to their targets.
        commands: Vec<(&'a str, Node<'a>, bool)>,
        /// Description.
        description: Option<&'a str>,
        /// The group's own command options.
        leaf: Option<&'a Type>,
    },
    /// A command with options.
    Leaf {
        /// Description.
        description: Option<&'a str>,
        /// Options schema.
        options: Option<&'a Type>,
    },
}

impl<'a> Node<'a> {
    /// Returns the options of the command this node runs.
    fn options(&self) -> Option<&'a Type> {
        match self {
            Self::Group { leaf, .. } => *leaf,
            Self::Leaf { options, .. } => *options,
        }
    }

    /// Returns the description.
    fn description(&self) -> Option<&str> {
        match self {
            Node::Group { description, .. } | Node::Leaf { description, .. } => *description,
        }
    }
}

/// Generates the shell hook that calls back into the binary at every tab press.
pub fn register(shell: Shell, name: &str) -> String {
    let id = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    match shell {
        Shell::Bash => format!(
            r#"_incur_complete_{id}() {{
    local IFS=$'\013'
    local _COMPLETE_INDEX=${{COMP_CWORD}}
    local _completions
    _completions=( $(
        export COMPLETE="bash"
        export _COMPLETE_INDEX="$_COMPLETE_INDEX"
        "{name}" -- "${{COMP_WORDS[@]}}"
    ) )
    if [[ $? != 0 ]]; then
        unset COMPREPLY
        return
    fi
    local _nospace=false
    COMPREPLY=()
    for _c in "${{_completions[@]}}"; do
        if [[ "$_c" == *$'\001' ]]; then
            _nospace=true
            _c=${{_c%$'\001'}}
        fi
        COMPREPLY+=("$_c")
    done
    if [[ $_nospace == true ]]; then
        compopt -o nospace 2>/dev/null
    fi
}}
complete -o default -o bashdefault -o nosort -F _incur_complete_{id} {name} 2>/dev/null ||
    complete -o default -o bashdefault -F _incur_complete_{id} {name}"#
        ),
        Shell::Zsh => format!(
            r#"#compdef {name}
_incur_complete_{id}() {{
    local completions=("${{(@f)$(
        export _COMPLETE_INDEX=$(( CURRENT - 1 ))
        export COMPLETE="zsh"
        "{name}" -- "${{words[@]}}" 2>/dev/null
    )}}")
    if [[ -n $completions ]]; then
        _describe 'values' completions -S ''
    fi
}}
compdef _incur_complete_{id} {name}"#
        ),
        Shell::Fish => format!(
            r#"complete --keep-order --exclusive --command {name} \
    --arguments "(COMPLETE=fish {name} -- (commandline --current-process --tokenize --cut-at-cursor) (commandline --current-token))""#
        ),
        Shell::Nushell => format!(
            r"# External completer for {name}
# Add to $env.config.completions.external.completer or use in a dispatch completer.
let _incur_complete_{id} = {{|spans|
    COMPLETE=nushell {name} -- ...$spans | from json
}}"
        ),
    }
}

/// Resolves a flag token to its option field.
fn option_field<'a>(token: &str, options: &'a Type) -> Option<&'a Field> {
    let fields = options.fields();
    if let Some(raw) = token.strip_prefix("--") {
        return fields
            .iter()
            .find(|f| js::to_kebab(&f.name) == raw)
            .or_else(|| fields.iter().find(|f| f.name == raw));
    }
    let mut chars = token.chars();
    if chars.next() == Some('-') && js::utf16_len(token) == 2 {
        let short = chars.next();
        return fields
            .iter()
            .find(|f| f.alias.is_some() && f.alias == short);
    }
    None
}

/// Suggests the option flags of a schema that match the current word.
fn flags(candidates: &mut Vec<Candidate>, options: &Type, current: &str) {
    for field in options.fields() {
        let flag = format!("--{}", js::to_kebab(&field.name));
        if flag.starts_with(current) && !candidates.iter().any(|c| c.value == flag) {
            candidates.push(Candidate {
                description: field.ty.description.clone(),
                no_space: false,
                value: flag,
            });
        }
    }
    for field in options.fields() {
        if let Some(alias) = field.alias {
            let flag = format!("-{alias}");
            if flag.starts_with(current) && !candidates.iter().any(|c| c.value == flag) {
                candidates.push(Candidate {
                    description: field.ty.description.clone(),
                    no_space: false,
                    value: flag,
                });
            }
        }
    }
}

/// Suggests enum values for an option expecting a value. Returns `true` when the option takes a
/// value, so no other candidates apply.
fn values(candidates: &mut Vec<Candidate>, prev: &str, options: &Type, current: &str) -> bool {
    let Some(field) = option_field(prev, options) else {
        return false;
    };
    if let Kind::Enum(values) = &field.ty.kind {
        for value in values.iter().filter(|v| v.starts_with(current)) {
            candidates.push(Candidate {
                description: None,
                no_space: false,
                value: value.clone(),
            });
        }
        return true;
    }
    !field.ty.is_flag()
}

/// Computes completion candidates for the word at `index`.
pub(crate) fn complete(
    root: &Node<'_>,
    argv: &[String],
    index: usize,
    globals: Option<&Type>,
) -> Vec<Candidate> {
    let current = argv.get(index).map_or("", String::as_str);
    let mut scope = root;
    for token in argv
        .iter()
        .take(index)
        .filter(|token| !token.starts_with('-'))
    {
        // Tokens after a command are its arguments.
        let Node::Group { commands, .. } = scope else {
            break;
        };
        if let Some((_, entry, _)) = commands.iter().find(|(name, ..)| *name == token) {
            scope = entry;
        }
    }
    let leaf = scope.options();

    let mut candidates = Vec::new();
    if current.starts_with('-') {
        if let Some(options) = leaf {
            flags(&mut candidates, options, current);
        }
        if let Some(globals) = globals {
            flags(&mut candidates, globals, current);
        }
        return candidates;
    }

    if let Some(prev) = index.checked_sub(1).and_then(|i| argv.get(i))
        && prev.starts_with('-')
    {
        for options in [leaf, globals].into_iter().flatten() {
            if values(&mut candidates, prev, options, current) {
                return candidates;
            }
        }
    }

    if let Node::Group { commands, .. } = scope {
        for (name, entry, alias) in commands {
            if !alias && name.starts_with(current) {
                candidates.push(Candidate {
                    description: entry.description().map(str::to_owned),
                    no_space: matches!(entry, Node::Group { .. }),
                    value: (*name).to_owned(),
                });
            }
        }
    }
    candidates
}

/// Formats candidates for a shell.
pub fn format(shell: Shell, candidates: &[Candidate]) -> String {
    match shell {
        Shell::Bash => candidates
            .iter()
            .map(|c| {
                if c.no_space {
                    format!("{}\u{1}", c.value)
                } else {
                    c.value.clone()
                }
            })
            .collect::<Vec<_>>()
            .join("\u{b}"),
        Shell::Zsh => candidates
            .iter()
            .map(|c| {
                let escaped = c.value.replace(':', "\\:");
                match c.description.as_deref().filter(|d| !d.is_empty()) {
                    Some(description) => format!("{escaped}:{description}"),
                    None => escaped,
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Shell::Fish => candidates
            .iter()
            .map(
                |c| match c.description.as_deref().filter(|d| !d.is_empty()) {
                    Some(description) => format!("{}\t{description}", c.value),
                    None => c.value.clone(),
                },
            )
            .collect::<Vec<_>>()
            .join("\n"),
        Shell::Nushell => {
            let records = candidates
                .iter()
                .map(|c| {
                    let mut record = Map::new();
                    record.insert("value".into(), c.value.clone().into());
                    if let Some(description) = c.description.as_deref().filter(|d| !d.is_empty()) {
                        record.insert("description".into(), description.into());
                    }
                    Value::Object(record)
                })
                .collect();
            js::stringify(&records)
        }
    }
}
