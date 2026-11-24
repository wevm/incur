"""Markdown command manifests for `--llms` and `--llms-full`."""

from __future__ import annotations

import hashlib
import re
import typing
from dataclasses import dataclass, field

from . import _js, _yaml
from ._command import Command
from ._help import Example
from ._js import Json
from ._schema import Type, json_schema
from ._tree import Entry, Gateway, Group


@dataclass
class CommandInfo:
    """A command described in a manifest."""

    name: str | None
    args: Type | None = None
    description: str | None = None
    env: Type | None = None
    examples: list[Example] = field(default_factory=list[Example])
    hint: str | None = None
    options: Type | None = None
    output: Type | None = None


#: The hint of fetch gateways in agent skills.
GATEWAY_HINT = "Fetch gateway. Pass path segments and curl-style flags (-X, -H, -d, --key value)."

#: The hint appended to destructive commands in agent skills.
DESTRUCTIVE_HINT = "Confirm with the user before executing this destructive command."


def _is_destructive(command: Command) -> bool:
    annotations = command.mcp.annotations if command.mcp and command.mcp_enabled else None
    return command.destructive or (annotations or {}).get("destructiveHint") is True


def _hint_with_destructive(command: Command) -> str | None:
    if not _is_destructive(command):
        return command.hint
    if not command.hint:
        return DESTRUCTIVE_HINT
    if DESTRUCTIVE_HINT in command.hint:
        return command.hint
    return f"{command.hint} {DESTRUCTIVE_HINT}"


def prefixed_examples(examples: list[Example], name: str) -> list[Example]:
    """Prefixes examples with a command path."""
    return [Example(f"{name} {e.command}" if e.command else name, e.description) for e in examples]


def _command_info(name: str | None, command: Command) -> CommandInfo:
    examples = prefixed_examples(command.examples, name) if name else list(command.examples)
    return CommandInfo(
        name=name,
        args=command.args,
        description=command.description,
        env=command.env,
        examples=examples,
        hint=_hint_with_destructive(command),
        options=command.options,
        output=command.output,
    )


def collect(
    commands: dict[str, Entry],
    prefix: list[str],
    groups: dict[str, str],
    root: Command | None,
) -> list[CommandInfo]:
    """Collects the commands that skill files and Markdown manifests describe, sorted by name.

    `groups` receives the descriptions of groups along the way.
    """
    out: list[CommandInfo] = []
    if root is not None:
        out.append(_command_info(None, root))
    for name, entry in commands.items():
        path = [*prefix, name]
        joined = " ".join(path)
        if isinstance(entry, Command):
            out.append(_command_info(joined, entry))
        elif isinstance(entry, Gateway):
            out.append(CommandInfo(name=joined, description=entry.description, hint=GATEWAY_HINT))
        elif isinstance(entry, Group):
            if entry.description is not None:
                groups[joined] = entry.description
            if entry.root is not None:
                out.append(_command_info(joined, entry.root))
            out += collect(entry.commands, path, groups, None)
    out.sort(key=lambda info: _js.locale_key(info.name or ""))
    return out


def _type_name(ty: Type) -> str:
    """Returns the JSON Schema type name, mapping `integer` to `number`; a union has none."""
    return {"integer": "number", "enum": "string", "union": "unknown"}.get(ty.kind, ty.kind)


def _required(ty: Type) -> str:
    return "no" if ty.is_optional() else "yes"


def _signature(cli: str, cmd: CommandInfo) -> str:
    base = cli if cmd.name is None else f"{cli} {cmd.name}"
    if cmd.args is None:
        return base
    names: list[str] = []
    for f in cmd.args.fields:
        label = f"{f.name}..." if f.ty.kind == "array" else f.name
        names.append(f"[{label}]" if f.ty.is_optional() else f"<{label}>")
    return f"{base} {' '.join(names)}"


def index(name: str, commands: list[CommandInfo], description: str | None) -> str:
    """Generates the compact command index `--llms` prints."""
    lines = [f"# {name}"]
    if description:
        lines += ["", description]
    lines += ["", "| Command | Description |", "|---------|-------------|"]
    for cmd in commands:
        lines.append(f"| `{_signature(name, cmd)}` | {cmd.description or ''} |")
    lines += [
        "",
        f"Run `{name} --llms-full` for full manifest. "
        f"Run `{name} <command> --schema` for argument details.",
    ]
    return "\n".join(lines)


def generate(name: str, commands: list[CommandInfo], groups: dict[str, str]) -> str:
    """Generates the full Markdown manifest `--llms-full` prints."""
    if not groups:
        return "\n\n".join(_body(name, cmd, 1) for cmd in commands)
    sections = [f"# {name}"]
    last: str | None = None
    for cmd in commands:
        segment = cmd.name.split(" ")[0] if cmd.name else ""
        if last != segment:
            last = segment
            if segment:
                description = groups.get(segment)
                heading = f"## {name} {segment}"
                sections.append(f"{heading}\n\n{description}" if description else heading)
        sections.append(_body(name, cmd, 3 if segment else 2))
    return "\n\n".join(sections)


def _body(cli: str, cmd: CommandInfo, level: int) -> str:
    full = cli if cmd.name is None else f"{cli} {cmd.name}"
    heading = f"{'#' * level} {full}"
    if cmd.description:
        heading += f"\n\n{cmd.description}"
    sections = [heading]
    sub = "#" * (level + 1)

    if cmd.args is not None:
        rows = [
            f"| `{f.name}` | `{_type_name(f.ty)}` | {_required(f.ty)} | {f.ty.description or ''} |"
            for f in cmd.args.fields
        ]
        sections.append(
            f"{sub} Arguments\n\n| Name | Type | Required | Description |\n"
            "|------|------|----------|-------------|\n" + "\n".join(rows)
        )

    if cmd.env is not None:
        rows = [
            f"| `{f.name}` | `{_type_name(f.ty)}` | {_required(f.ty)} | "
            f"{_default_cell(f.ty)} | {f.ty.description or ''} |"
            for f in cmd.env.fields
        ]
        sections.append(
            f"{sub} Environment Variables\n\n| Name | Type | Required | Default | Description |\n"
            "|------|------|----------|---------|-------------|\n" + "\n".join(rows)
        )

    if cmd.options is not None:
        rows: list[str] = []
        for f in cmd.options.fields:
            raw = f.ty.description or ""
            description = f"**Deprecated.** {raw}" if f.ty.deprecated else raw
            rows.append(
                f"| `--{f.name}` | `{_type_name(f.ty)}` | {_default_cell(f.ty)} | {description} |"
            )
        sections.append(
            f"{sub} Options\n\n| Flag | Type | Default | Description |\n"
            "|------|------|---------|-------------|\n" + "\n".join(rows)
        )

    if cmd.output is not None:
        table = _schema_table(cmd.output, "")
        if table is None:
            sections.append(f"{sub} Output\n\nType: `{_type_name(cmd.output)}`")
        else:
            sections.append(f"{sub} Output\n\n{table}")

    if cmd.examples:
        lines = [
            (f"# {e.description}\n" if e.description else "") + f"{cli} {e.command}"
            for e in cmd.examples
        ]
        sections.append(f"{sub} Examples\n\n```sh\n" + "\n\n".join(lines) + "\n```")

    if cmd.hint:
        sections.append(f"> {cmd.hint}")
    return "\n\n".join(sections)


def _default_cell(ty: Type) -> str:
    text = "" if ty.default is None else _js.to_string(ty.default)
    return f"`{text}`" if text else ""


def _schema_table(ty: Type, prefix: str) -> str | None:
    """Renders an object schema as a Markdown table, expanding nested objects."""
    if ty.kind != "object" or not ty.fields:
        return None
    rows: list[str] = []
    for f in ty.fields:
        name = f"{prefix}.{f.name}" if prefix else f.name
        rows.append(
            f"| `{name}` | `{_type_name(f.ty)}` | {_required(f.ty)} | {f.ty.description or ''} |"
        )
        nested = None
        if f.ty.kind == "object":
            nested = _schema_table(f.ty, name)
        elif f.ty.items is not None:
            nested = _schema_table(f.ty.items, f"{name}[]")
        if nested is not None:
            rows += nested.split("\n")[2:]
    return (
        "| Field | Type | Required | Description |\n"
        "|-------|------|----------|-------------|\n" + "\n".join(rows)
    )


@dataclass
class File:
    """A generated skill file: its directory, `SKILL.md` contents, and description."""

    dir: str
    content: str
    description: str


def slugify(value: str) -> str:
    """Converts text to a lowercase slug, such as `My Tool` to `my-tool`."""
    slug = re.sub("[^a-z0-9-]+", "-", value.lower())
    return re.sub("^-|-$", "", re.sub("-{2,}", "-", slug))


def split(
    name: str, commands: list[CommandInfo], depth: float, groups: dict[str, str]
) -> list[File]:
    """Splits commands into skill files, grouped by their first `depth` name segments.

    `depth` bounds a JavaScript `slice`, as `--depth` parses it: fractions truncate, negative
    values count from the end, and `NaN` takes no segments.
    """
    if depth == 0:
        return [_group(name, name, commands, groups, name, "")]

    def head(cmd: str) -> list[str]:
        segments = cmd.split(" ")
        return segments[: _js.relative_index(depth, len(segments))]

    buckets: dict[str, list[CommandInfo]] = {}
    for cmd in commands:
        key = slugify(name) if not cmd.name else "-".join(head(cmd.name))
        buckets.setdefault(key, []).append(cmd)
    files: list[File] = []
    for key in sorted(buckets, key=_js.locale_key):
        cmds = buckets[key]
        first = cmds[0]
        prefix = " ".join(head(first.name)) if first.name else ""
        title = f"{name} {prefix}" if prefix else name
        files.append(_group(name, title, cmds, groups, prefix or None, key))
    return files


def _group(
    cli: str,
    title: str,
    cmds: list[CommandInfo],
    groups: dict[str, str],
    prefix: str | None,
    directory: str,
) -> File:
    """Renders a skill file: frontmatter, then command bodies."""
    described = groups.get(prefix) if prefix else None
    fallback = cmds[0].description if len(cmds) == 1 and cmds[0].description else None
    desc = described if described is not None else fallback
    usage = f"Run `{title} --help` for usage details."
    description = f"{desc.removesuffix('.')}. {usage}" if desc else usage
    frontmatter = {
        "name": slugify(title),
        "description": description,
        "requires_bin": cli,
        "command": title,
    }
    meta = _yaml.stringify(typing.cast("Json", frontmatter), line_width=0).rstrip()
    body = "\n\n---\n\n".join(_body(cli, cmd, 1) for cmd in cmds)
    return File(directory, f"---\n{meta}\n---\n\n{body}", description)


def hash_commands(commands: list[CommandInfo]) -> str:
    """Hashes the command structure, to detect when installed skills are out of date."""
    data: list[Json] = []
    for cmd in commands:
        entry: dict[str, Json] = {}
        if cmd.name is not None:
            entry["name"] = cmd.name
        if cmd.description is not None:
            entry["description"] = cmd.description
        if cmd.hint is not None:
            entry["hint"] = cmd.hint
        for key, ty in (
            ("args", cmd.args),
            ("env", cmd.env),
            ("options", cmd.options),
            ("output", cmd.output),
        ):
            if ty is not None:
                entry[key] = json_schema(ty)
        data.append(entry)
    return hashlib.sha256(_js.stringify(data).encode()).hexdigest()[:16]


def discovery(origin: str, files: list[tuple[str, str, str]]) -> dict[str, Json]:
    """Builds the Agent Skills discovery index (v0.2.0) of `(name, description, content)`."""
    skills: list[Json] = []
    for name, description, content in files:
        digest = hashlib.sha256(content.encode()).hexdigest()
        skills.append(
            {
                "name": name,
                "type": "skill-md",
                "description": description,
                "url": f"{origin}/.well-known/agent-skills/{name}/SKILL.md",
                "digest": f"sha256:{digest}",
            }
        )
    return {
        "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        "skills": skills,
    }
