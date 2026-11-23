"""Markdown command manifests for `--llms` and `--llms-full`."""

from __future__ import annotations

from dataclasses import dataclass, field

from . import _js
from ._help import Example
from ._schema import Type


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


def _type_name(ty: Type) -> str:
    """Returns the JSON Schema type name, mapping `integer` to `number`."""
    return {"integer": "number", "enum": "string"}.get(ty.kind, ty.kind)


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
