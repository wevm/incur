"""Output serialization in TOON, JSON, YAML, Markdown, and JSONL."""

from __future__ import annotations

from typing import Literal, TypeGuard

from . import _js, _toon, _yaml
from ._js import Json

#: A supported output format.
Format = Literal["toon", "json", "yaml", "md", "jsonl"]

#: Every format, in the order help output lists them.
FORMATS: tuple[Format, ...] = ("toon", "json", "yaml", "md", "jsonl")


def format_value(value: Json, fmt: Format) -> str:
    """Serializes a value in the given format. `None` formats as an empty string."""
    if value is None:
        return ""
    if fmt == "json":
        if isinstance(value, str):
            trimmed = _js.trim(value)
            if trimmed.startswith(("{", "[")) and _js.json_parse_error(value) is None:
                return _js.stringify_pretty(_js.parse_json(value))
        return _js.stringify_pretty(value)
    if fmt == "jsonl":
        if isinstance(value, list):
            return "\n".join(_js.stringify(item) for item in value)
        return _js.stringify(value)
    if fmt == "yaml":
        return _yaml.stringify(value)
    if fmt == "md":
        return _markdown(value)
    return _toon.encode(value)


def _is_scalar(value: Json) -> bool:
    return not isinstance(value, (list, dict))


def _is_flat(data: dict[str, Json]) -> bool:
    return all(_is_scalar(v) for v in data.values())


def _is_array_of_objects(value: Json) -> TypeGuard[list[dict[str, Json]]]:
    return isinstance(value, list) and bool(value) and all(isinstance(v, dict) for v in value)


def _pad(value: str, width: int) -> str:
    return value + " " * max(width - _js.utf16_len(value), 0)


def _table(headers: list[str], rows: list[list[str]]) -> str:
    """Renders an aligned Markdown table."""
    widths = [
        max([_js.utf16_len(row[i]) for row in rows] + [_js.utf16_len(header)])
        for i, header in enumerate(headers)
    ]
    head = " | ".join(_pad(h, w) for h, w in zip(headers, widths, strict=True))
    sep = "|".join("-" * (w + 2) for w in widths)
    body = "\n".join(
        "| " + " | ".join(_pad(row[i], w) for i, w in enumerate(widths)) + " |" for row in rows
    )
    return f"| {head} |\n|{sep}|\n{body}"


def _kv_table(data: dict[str, Json]) -> str:
    return _table(["Key", "Value"], [[k, _js.to_string(v)] for k, v in data.items()])


def _cell(value: Json) -> str:
    """Renders a table cell: scalars as strings, nested values as compact JSON."""
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        # Escape pipes so the JSON stays inside its cell.
        return _js.stringify(value).replace("|", "\\|")
    return _js.to_string(value)


def _columnar_table(items: list[dict[str, Json]]) -> str:
    keys: list[str] = []
    for item in items:
        for key in item:
            if key not in keys:
                keys.append(key)
    rows = [[_cell(item.get(key)) for key in keys] for item in items]
    return _table(keys, rows)


def _markdown(value: Json) -> str:
    """Formats a value as Markdown: tables, and headed sections for nested objects."""
    if _is_array_of_objects(value):
        return _columnar_table(value)
    if isinstance(value, dict):
        return _kv_table(value) if _is_flat(value) else _sections(value, [])
    return _js.to_string(value)


def _sections(data: dict[str, Json], path: list[str]) -> str:
    """Formats each entry of a nested object as a section headed by its dotted path."""

    def heading(child: list[str], body: str) -> str:
        return f"## {'.'.join(child)}\n\n{body}"

    out: list[str] = []
    for key, value in data.items():
        child = [*path, key]
        if isinstance(value, dict):
            if _is_flat(value):
                out.append(heading(child, _kv_table(value)))
            else:
                out.append(_sections(value, child))
        elif _is_array_of_objects(value):
            out.append(heading(child, _columnar_table(value)))
        else:
            out.append(heading(child, _js.to_string(value)))
    return "\n\n".join(out)
