"""Dynamic shell completions for bash, fish, nushell, and zsh."""

from __future__ import annotations

from dataclasses import dataclass

from . import _js
from ._js import Json
from ._schema import Field, Type

#: Every shell, in help order.
SHELLS = ("bash", "fish", "nushell", "zsh")


@dataclass
class Candidate:
    """A completion candidate."""

    value: str
    description: str | None = None
    no_space: bool = False


@dataclass
class Node:
    """A command tree node: a group with subcommands, or a command with options."""

    description: str | None
    options: Type | None
    group: bool
    commands: list[tuple[str, Node, bool]]


def register(shell: str, name: str) -> str:
    """Generates the shell hook that calls back into the binary at every tab press."""
    ident = "".join(ch if (ch.isascii() and ch.isalnum()) or ch == "_" else "_" for ch in name)
    if shell == "bash":
        return f"""_incur_complete_{ident}() {{
    local IFS=$'\\013'
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
        if [[ "$_c" == *$'\\001' ]]; then
            _nospace=true
            _c=${{_c%$'\\001'}}
        fi
        COMPREPLY+=("$_c")
    done
    if [[ $_nospace == true ]]; then
        compopt -o nospace 2>/dev/null
    fi
}}
complete -o default -o bashdefault -o nosort -F _incur_complete_{ident} {name} 2>/dev/null ||
    complete -o default -o bashdefault -F _incur_complete_{ident} {name}"""
    if shell == "zsh":
        return f"""#compdef {name}
_incur_complete_{ident}() {{
    local completions=("${{(@f)$(
        export _COMPLETE_INDEX=$(( CURRENT - 1 ))
        export COMPLETE="zsh"
        "{name}" -- "${{words[@]}}" 2>/dev/null
    )}}")
    if [[ -n $completions ]]; then
        _describe 'values' completions -S ''
    fi
}}
compdef _incur_complete_{ident} {name}"""
    if shell == "fish":
        return (
            f"complete --keep-order --exclusive --command {name} \\\n"
            f'    --arguments "(COMPLETE=fish {name} -- (commandline --current-process '
            '--tokenize --cut-at-cursor) (commandline --current-token))"'
        )
    return f"""# External completer for {name}
# Add to $env.config.completions.external.completer or use in a dispatch completer.
let _incur_complete_{ident} = {{|spans|
    COMPLETE=nushell {name} -- ...$spans | from json
}}"""


def _option_field(token: str, options: Type) -> Field | None:
    """Resolves a flag token to its option field."""
    if token.startswith("--"):
        raw = token[2:]
        found = next((f for f in options.fields if _js.to_kebab(f.name) == raw), None)
        return found or next((f for f in options.fields if f.name == raw), None)
    if token.startswith("-") and _js.utf16_len(token) == 2:
        return next((f for f in options.fields if f.alias == token[1]), None)
    return None


def _flags(candidates: list[Candidate], options: Type, current: str) -> None:
    """Suggests the option flags of a schema that match the current word."""
    flags = [(f"--{_js.to_kebab(f.name)}", f) for f in options.fields]
    flags += [(f"-{f.alias}", f) for f in options.fields if f.alias is not None]
    for flag, f in flags:
        if flag.startswith(current) and not any(c.value == flag for c in candidates):
            candidates.append(Candidate(flag, f.ty.description))


def _values(candidates: list[Candidate], prev: str, options: Type, current: str) -> bool:
    """Suggests enum values. Returns whether the option takes a value."""
    f = _option_field(prev, options)
    if f is None:
        return False
    if f.ty.kind == "enum":
        candidates.extend(Candidate(v) for v in f.ty.values if v.startswith(current))
        return True
    return not f.ty.is_flag()


def complete(root: Node, argv: list[str], index: int, globals_: Type | None) -> list[Candidate]:
    """Computes completion candidates for the word at `index`."""
    current = argv[index] if index < len(argv) else ""
    scope = root
    for token in argv[:index]:
        if token.startswith("-"):
            continue
        # Tokens after a command are its arguments.
        if not scope.group:
            break
        scope = next((node for name, node, _ in scope.commands if name == token), scope)
    leaf = scope.options
    candidates: list[Candidate] = []
    if current.startswith("-"):
        for options in (leaf, globals_):
            if options is not None:
                _flags(candidates, options, current)
        return candidates
    if 0 < index <= len(argv) and argv[index - 1].startswith("-"):
        for options in (leaf, globals_):
            if options is not None and _values(candidates, argv[index - 1], options, current):
                return candidates
    for name, node, alias in scope.commands:
        if not alias and name.startswith(current):
            candidates.append(Candidate(name, node.description, node.group))
    return candidates


def format_candidates(shell: str, candidates: list[Candidate]) -> str:
    """Formats candidates for a shell."""
    if shell == "bash":
        return "\x0b".join(c.value + ("\x01" if c.no_space else "") for c in candidates)
    if shell == "zsh":
        return "\n".join(
            c.value.replace(":", "\\:") + (f":{c.description}" if c.description else "")
            for c in candidates
        )
    if shell == "fish":
        return "\n".join(
            c.value + (f"\t{c.description}" if c.description else "") for c in candidates
        )
    records: list[Json] = []
    for c in candidates:
        record: dict[str, Json] = {"value": c.value}
        if c.description:
            record["description"] = c.description
        records.append(record)
    return _js.stringify(records)
