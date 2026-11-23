"""TOON encoding, ported from `@toon-format/toon` 2.3.1 with its default options."""

from __future__ import annotations

import re

from . import _js
from ._js import Json

_NUMERIC = re.compile(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|0\d+", re.ASCII)
_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")


def encode(value: Json) -> str:
    """Encodes JSON data as TOON. Scalars format as `String(value)`."""
    lines: list[str] = []
    if isinstance(value, list):
        _array_lines(lines, None, value, 0)
    elif isinstance(value, dict):
        _object_lines(lines, value, 0)
    else:
        return _js.to_string(value)
    return "\n".join(lines)


def _is_primitive(value: Json) -> bool:
    return not isinstance(value, (list, dict))


def _primitive(value: Json) -> str:
    return _string_literal(value) if isinstance(value, str) else _js.to_string(value)


def _string_literal(value: str) -> str:
    """Encodes a string, quoting it when it would be ambiguous unquoted."""
    return value if _is_safe_unquoted(value) else f'"{_escape(value)}"'


def _escape(value: str) -> str:
    """Escapes backslashes, quotes, and control characters."""
    out: list[str] = []
    for ch in value:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    return "".join(out)


def _is_safe_unquoted(value: str) -> bool:
    """Whether a string encodes unquoted without changing meaning."""
    return (
        bool(value)
        and value == _js.trim(value)
        and value not in ("true", "false", "null")
        and not _NUMERIC.fullmatch(value)
        and not any(ch in ':"\\[]{},' or ord(ch) < 0x20 for ch in value)
        and not value.startswith("-")
    )


def _key(value: str) -> str:
    r"""Encodes a key, quoting it unless it matches `/^[A-Z_][\\w.]*$/i`."""
    return value if _KEY.fullmatch(value) else f'"{_escape(value)}"'


def _header(length: int, key: str | None, fields: list[str] | None) -> str:
    """Formats an array header such as `key[2]{a,b}:`."""
    out = _key(key) if key is not None else ""
    out += f"[{length}]"
    if fields is not None:
        out += "{" + ",".join(_key(f) for f in fields) + "}"
    return out + ":"


def _join(values: list[Json]) -> str:
    return ",".join(_primitive(v) for v in values)


def _line(depth: int, content: str) -> str:
    return "  " * depth + content


def _item(depth: int, content: str) -> str:
    return _line(depth, f"- {content}")


def _object_lines(lines: list[str], data: dict[str, Json], depth: int) -> None:
    for name, value in data.items():
        if isinstance(value, list):
            _array_lines(lines, name, value, depth)
        elif isinstance(value, dict):
            lines.append(_line(depth, f"{_key(name)}:"))
            _object_lines(lines, value, depth + 1)
        else:
            lines.append(_line(depth, f"{_key(name)}: {_primitive(value)}"))


def _inline(values: list[Json], key: str | None) -> str:
    head = _header(len(values), key, None)
    return f"{head} {_join(values)}" if values else head


def _array_lines(lines: list[str], key: str | None, items: list[Json], depth: int) -> None:
    if not items:
        lines.append(_line(depth, "[]" if key is None else f"{_key(key)}: []"))
        return
    if all(_is_primitive(v) for v in items):
        lines.append(_line(depth, _inline(items, key)))
        return
    rows = [v for v in items if isinstance(v, list) and all(_is_primitive(x) for x in v)]
    if len(rows) == len(items):
        lines.append(_line(depth, _header(len(items), key, None)))
        lines.extend(_item(depth + 1, _inline(v, None)) for v in rows)
        return
    fields = _tabular_header(items)
    if fields is not None:
        lines.append(_line(depth, _header(len(items), key, fields)))
        _rows(lines, items, fields, depth + 1)
        return
    lines.append(_line(depth, _header(len(items), key, None)))
    for v in items:
        _list_item(lines, v, depth + 1)


def _tabular_header(items: list[Json]) -> list[str] | None:
    """Returns the shared keys when every item is an object of the same primitive-valued keys."""
    first = items[0]
    if not isinstance(first, dict) or not first:
        return None
    fields = list(first)
    for row in items:
        if not isinstance(row, dict) or len(row) != len(fields):
            return None
        if not all(f in row and _is_primitive(row[f]) for f in fields):
            return None
    return fields


def _rows(lines: list[str], items: list[Json], fields: list[str], depth: int) -> None:
    for row in items:
        assert isinstance(row, dict)
        lines.append(_line(depth, _join([row[f] for f in fields])))


def _list_item(lines: list[str], value: Json, depth: int) -> None:
    if isinstance(value, list):
        if all(_is_primitive(v) for v in value):
            lines.append(_item(depth, _inline(value, None)))
        else:
            lines.append(_item(depth, _header(len(value), None, None)))
            for v in value:
                _list_item(lines, v, depth + 1)
    elif isinstance(value, dict):
        _object_item(lines, value, depth)
    else:
        lines.append(_item(depth, _primitive(value)))


def _object_item(lines: list[str], data: dict[str, Json], depth: int) -> None:
    """Encodes an object as a list item, with its first field on the marker line."""
    if not data:
        lines.append(_line(depth, "-"))
        return
    entries = list(data.items())
    first_key, first = entries[0]
    rest = dict(entries[1:])
    encoded = _key(first_key)
    if isinstance(first, list):
        if not first:
            lines.append(_item(depth, f"{encoded}: []"))
        elif all(isinstance(v, dict) for v in first):
            fields = _tabular_header(first)
            if fields is not None:
                lines.append(_item(depth, _header(len(first), first_key, fields)))
                _rows(lines, first, fields, depth + 2)
            else:
                lines.append(_item(depth, encoded + _header(len(first), None, None)))
                for v in first:
                    _list_item(lines, v, depth + 2)
        elif all(_is_primitive(v) for v in first):
            lines.append(_item(depth, encoded + _inline(first, None)))
        else:
            lines.append(_item(depth, encoded + _header(len(first), None, None)))
            for v in first:
                _list_item(lines, v, depth + 2)
    elif isinstance(first, dict):
        lines.append(_item(depth, f"{encoded}:"))
        _object_lines(lines, first, depth + 2)
    else:
        lines.append(_item(depth, f"{encoded}: {_primitive(first)}"))
    _object_lines(lines, rest, depth + 1)
