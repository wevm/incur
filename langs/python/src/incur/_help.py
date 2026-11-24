"""Help text for command groups and commands."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from . import _js
from ._schema import Type


@dataclass
class Entry:
    """A command listed in help output."""

    name: str
    description: str | None


@dataclass
class Usage:
    """An alternative usage line shown in command help."""

    args: list[str] = field(default_factory=list[str])
    """Arguments shown as `<name>`."""
    options: list[str] = field(default_factory=list[str])
    """Options shown as `--name <name>`."""
    prefix: str | None = None
    """Text before the command, such as `cat file.txt |`."""
    suffix: str | None = None
    """Text after the command, such as `| head`."""


@dataclass
class Example:
    """A usage example: the arguments after the command name and what the example shows."""

    command: str = ""
    """The arguments and options after the command name."""
    description: str | None = None
    """What the example shows."""


@dataclass
class Options:
    """Inputs of `format_root` and `format_command`."""

    aliases: list[str] = field(default_factory=list[str])
    args: Type | None = None
    commands: list[Entry] | None = None
    config_flag: str | None = None
    description: str | None = None
    env: Type | None = None
    env_source: Callable[[str], str | None] | None = None
    examples: list[Example] | None = None
    globals: Type | None = None
    hide_global_options: bool = False
    hide_skills: bool = False
    hide_update: bool = False
    hint: str | None = None
    options: Type | None = None
    root: bool = False
    usage: list[Usage] = field(default_factory=list[Usage])
    version: str | None = None


def _title(name: str, options: Options) -> str:
    title = name if options.version is None else f"{name}@{options.version}"
    return f"{title} \u2014 {options.description}" if options.description else title


def _pad(value: str, width: int) -> str:
    return value + " " * max(width - _js.utf16_len(value), 0)


def _width(values: list[str]) -> int:
    return max((_js.utf16_len(v) for v in values), default=0)


def _commands(lines: list[str], entries: list[Entry]) -> None:
    width = _width([e.name for e in entries])
    for entry in entries:
        if entry.description:
            lines.append(f"  {_pad(entry.name, width)}  {entry.description}")
        else:
            lines.append(f"  {entry.name}")


def format_root(name: str, options: Options) -> str:
    """Formats help for a command group."""
    lines = [_title(name, options), "", f"Usage: {name} <command>"]
    if options.aliases:
        lines.append(f"Aliases: {', '.join(options.aliases)}")
    if options.commands:
        lines += ["", "Commands:"]
        _commands(lines, options.commands)
    _global_lines(lines, options)
    return "\n".join(lines)


def format_command(name: str, options: Options) -> str:
    """Formats help for a command."""
    lines = [_title(name, options), ""]
    if not options.usage:
        synopsis = [name]
        for f in options.args.fields if options.args else []:
            type_name = f.ty.type_name()
            label = type_name if "|" in type_name else f.name
            if type_name == "array":
                label += "..."
            synopsis.append(f"[{label}]" if f.ty.is_optional() else f"<{label}>")
        opts = " [options]" if options.options is not None else ""
        subcommands = " | <command>" if options.commands else ""
        lines.append(f"Usage: {' '.join(synopsis)}{opts}{subcommands}")
    else:
        for index, usage in enumerate(options.usage):
            parts: list[str] = []
            if usage.prefix:
                parts.append(usage.prefix)
            parts.append(name)
            parts += [f"<{a}>" for a in usage.args]
            parts += [f"--{o} <{o}>" for o in usage.options]
            if usage.suffix:
                parts.append(usage.suffix)
            lines.append(("Usage: " if index == 0 else "       ") + " ".join(parts))
    if options.aliases:
        lines.append(f"Aliases: {', '.join(options.aliases)}")

    if options.args is not None and options.args.fields:
        lines += ["", "Arguments:"]
        width = _width([f.name for f in options.args.fields])
        for f in options.args.fields:
            lines.append(f"  {_pad(f.name, width)}  {f.ty.description or ''}")

    if options.options is not None and options.options.fields:
        lines += ["", "Options:"]
        _option_lines(lines, options.options)

    if options.examples:
        lines += ["", "Examples:"]

        def full(e: Example) -> str:
            return f"{name} {e.command}" if e.command else name

        width = _width([full(e) for e in options.examples])
        for example in options.examples:
            command = full(example)
            if example.description:
                lines.append(f"  {_pad(command, width)}  # {example.description}")
            else:
                lines.append(f"  {command}")

    if options.hint:
        lines += ["", options.hint]

    if options.commands:
        lines += ["", "Commands:"]
        _commands(lines, options.commands)

    if not options.hide_global_options:
        _global_lines(lines, options)

    if options.env is not None and options.env.fields:
        lines += ["", "Environment Variables:"]
        width = _width([f.name for f in options.env.fields])
        for f in options.env.fields:
            parts = [f.ty.description or ""]
            value = options.env_source(f.name) if options.env_source else None
            if value is not None:
                parts.append(f"set: {_redact(value)}")
            default = _display_default(f.ty)
            if default is not None:
                parts.append(f"default: {default}")
            description = f"{parts[0]} ({', '.join(parts[1:])})" if len(parts) > 1 else parts[0]
            lines.append(f"  {_pad(f.name, width)}  {description}")

    return "\n".join(lines)


def _display_default(ty: Type) -> str | None:
    """Returns the default shown in help, omitting empty arrays."""
    if ty.default is None or ty.default == []:
        return None
    return _js.to_string(ty.default)


def _option_lines(lines: list[str], schema: Type) -> None:
    """Lists options with flags, aliases, value hints, and defaults."""
    entries: list[tuple[str, str]] = []
    for f in schema.fields:
        type_name = f.ty.type_name()
        kebab = _js.to_kebab(f.name)
        hint = "" if type_name == "boolean" else f" <{type_name}>"
        flag = f"--{kebab}, -{f.alias}{hint}" if f.alias else f"--{kebab}{hint}"
        default = (
            None if type_name == "boolean" and f.ty.default is False else _display_default(f.ty)
        )
        prefix = "[deprecated] " if f.ty.deprecated else ""
        description = prefix + (f.ty.description or "")
        if default is not None:
            description += f" (default: {default})"
        entries.append((flag, description))
    width = _width([flag for flag, _ in entries])
    for flag, description in entries:
        lines.append(f"  {_pad(flag, width)}  {description}")


_INTEGRATIONS = (
    ("completions", "Generate shell completion script"),
    ("mcp", "Register as MCP server (add, doctor)"),
    ("skills", "Sync skill files to agents (add, list)"),
)


def _global_lines(lines: list[str], options: Options) -> None:
    """Writes the integrations and global options sections."""
    if options.root:
        builtins = [b for b in _INTEGRATIONS if not options.hide_skills or b[0] != "skills"]
        width = _width([n for n, _ in builtins])
        lines += ["", "Integrations:"]
        for name, description in builtins:
            lines.append(f"  {_pad(name, width)}  {description}")

    if options.globals is not None and options.globals.fields:
        lines += ["", "Custom Global Options:"]
        _option_lines(lines, options.globals)

    flags: list[tuple[str, str]] = []
    if options.config_flag is not None:
        flag = options.config_flag
        flags.append((f"--{flag} <path>", "Load JSON option defaults from a file"))
        flags.append((f"--no-{flag}", "Disable JSON option defaults for this run"))
    flags += [
        ("--filter-output <keys>", "Filter output by key paths (e.g. foo,bar.baz,a[0,3])"),
        ("--format <toon|json|yaml|md|jsonl>", "Output format"),
        ("--help", "Show help"),
        ("--json", "Shorthand for --format json"),
        ("--llms, --llms-full", "Print LLM-readable manifest"),
        ("--schema", "Show JSON Schema for command"),
        ("--token-count", "Print token count of output (instead of output)"),
        ("--token-limit <n>", "Limit output to n tokens"),
        ("--token-offset <n>", "Skip first n tokens of output"),
        ("--full-output", "Show full output envelope"),
    ]
    if options.root:
        flags += [("--mcp", "Start as MCP stdio server"), ("--version", "Show version")]
        if not options.hide_update:
            flags.append(("--update", "Update to latest version"))
    flags.sort(key=lambda entry: _js.locale_key(entry[0]))
    width = max(len(flag) for flag, _ in flags)
    lines += ["", "Global Options:"]
    for flag, description in flags:
        lines.append(f"  {_pad(flag, width)}  {description}")


def _redact(value: str) -> str:
    """Redacts a value, keeping only the last four characters of long values."""
    units = _js.utf16(value)
    if len(units) <= 4:
        return "****"
    return "****" + _js.from_utf16(units[-4:])
