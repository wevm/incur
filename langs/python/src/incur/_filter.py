"""Output filtering with `--filter-output` key paths such as `foo,bar.baz,a[0,3]`."""

from __future__ import annotations

import copy
import math
from dataclasses import dataclass
from typing import TypeAlias

from . import _js
from ._js import Json


@dataclass
class Slice:
    """An array slice from `start` (inclusive) to `end` (exclusive)."""

    start: float
    end: float


#: One step of a filter path: an object key or an array slice.
Segment = str | Slice


class Missing:
    """The type of `MISSING`."""


#: The `undefined` result of filtering, and the absence of command data.
MISSING = Missing()

#: A filtered value, or `MISSING`.
Filtered: TypeAlias = "Json | Missing"

_Container: TypeAlias = "list[Json] | dict[str, Json]"


def parse(expression: str) -> list[list[Segment]]:
    """Parses a filter expression into paths."""
    tokens: list[str] = []
    current = ""
    depth = 0
    for ch in expression:
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
        if ch == "," and depth == 0:
            tokens.append(current)
            current = ""
        else:
            current += ch
    if current:
        tokens.append(current)

    paths: list[list[Segment]] = []
    for token in tokens:
        path: list[Segment] = []
        remaining = token
        while remaining:
            open_ = remaining.find("[")
            if open_ < 0:
                path.extend(part for part in remaining.split(".") if part)
                break
            path.extend(part for part in remaining[:open_].split(".") if part)
            close = remaining.find("]", open_)
            inner = remaining[open_ + 1 : close if close >= 0 else len(remaining)]
            bounds = inner.split(",")
            start = _js.to_number(bounds[0])
            end = _js.to_number(bounds[1]) if len(bounds) > 1 else math.nan
            path.append(Slice(start, end))
            remaining = remaining[close + 1 :] if close >= 0 else ""
            remaining = remaining.removeprefix(".")
        paths.append(path)
    return paths


def apply(data: Json, paths: list[list[Segment]]) -> Filtered:
    """Applies filter paths to a value and returns the filtered copy. `MISSING` is `undefined`."""
    if len(paths) == 1 and len(paths[0]) == 1 and isinstance(paths[0][0], str):
        key = paths[0][0]
        if isinstance(data, list):
            return [_defined(apply(item, paths)) for item in data]
        if isinstance(data, dict):
            value = _get(data, key)
            if isinstance(value, (dict, list)):
                return {key: value}
            return value
        return MISSING
    if isinstance(data, list):
        return [_defined(apply(item, paths)) for item in data]
    out: dict[str, Json] = {}
    for path in paths:
        _merge(out, data, path, 0)
    return out


def _defined(value: Filtered) -> Json:
    return None if isinstance(value, Missing) else value


def _merge(target: _Container, data: Json, segments: list[Segment], index: int) -> None:
    """Copies the value at `segments[index:]` from `data` into `target`, an object or array."""
    key = segments[index] if index < len(segments) else None
    if not isinstance(key, str):
        return
    value = _get(data, key)
    if isinstance(value, Missing):
        return
    nxt = segments[index + 1] if index + 1 < len(segments) else None
    if nxt is None:
        _set(target, key, copy.deepcopy(value))
    elif isinstance(nxt, Slice):
        if not isinstance(value, list):
            return
        begin = _js.relative_index(nxt.start, len(value))
        stop = _js.relative_index(nxt.end, len(value))
        sliced = value[begin:stop]
        if index + 2 >= len(segments):
            _set(target, key, copy.deepcopy(sliced))
            return
        mapped: list[Json] = []
        for item in sliced:
            sub: dict[str, Json] = {}
            _merge(sub, item, segments, index + 2)
            mapped.append(sub)
        _set(target, key, mapped)
    else:
        if not isinstance(value, (dict, list)):
            return
        # Existing objects and arrays are reused; anything else is replaced.
        if not isinstance(_entry(target, key), (dict, list)):
            _set(target, key, {})
        entry = _entry(target, key)
        assert isinstance(entry, (dict, list))
        _merge(entry, value, segments, index + 1)


def _get(data: Json, key: str) -> Filtered:
    """Reads a property as JavaScript does: object keys, and the indices and `length` of arrays."""
    if isinstance(data, list):
        if key == "length":
            return len(data)
        return _entry(data, key)
    if isinstance(data, dict):
        return _entry(data, key)
    return MISSING


def _entry(target: _Container, key: str) -> Filtered:
    """Returns an object property or array element."""
    if isinstance(target, list):
        index = _js.array_index(key)
        return target[index] if index is not None and index < len(target) else MISSING
    return target.get(key, MISSING)


def _set(target: _Container, key: str, value: Json) -> None:
    """Writes a property as JavaScript does; arrays take indices and `length` only."""
    if isinstance(target, dict):
        target[key] = value
        return
    index = _js.array_index(key)
    if index is not None:
        if len(target) <= index:
            target.extend([None] * (index + 1 - len(target)))
        target[index] = value
    else:
        # Array targets mirror array data, whose only other readable property is `length`.
        assert isinstance(value, int)
        del target[value:]
        target.extend([None] * (value - len(target)))
