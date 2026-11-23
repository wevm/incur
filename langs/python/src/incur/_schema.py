"""Schema nodes, JSON Schema output, and Zod-compatible validation."""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Literal, TypeAlias

from . import _js
from ._js import Json

#: The shape of a schema node.
Kind = Literal["array", "boolean", "enum", "integer", "number", "object", "string", "unknown"]

#: The largest integer a JavaScript number represents exactly.
MAX_SAFE_INTEGER = 9_007_199_254_740_991.0


@dataclass
class Field:
    """A named field of an object schema."""

    name: str
    ty: Type
    alias: str | None = None
    attr: str = ""


@dataclass
class Type:
    """A schema node: a kind with the metadata Zod attaches through `.describe()` and friends."""

    kind: Kind
    count: bool = False
    default: Json = None
    deprecated: bool = False
    description: str | None = None
    optional: bool = False
    min: float | None = None
    max: float | None = None
    items: Type | None = None
    values: list[str] = field(default_factory=list[str])
    fields: list[Field] = field(default_factory=list[Field])
    py: type | None = None

    def field(self, name: str) -> Field | None:
        """Returns the field with the given name."""
        return next((f for f in self.fields if f.name == name), None)

    def is_optional(self) -> bool:
        """Whether the input may omit the field without a default, as Zod's `optout` reports."""
        return self.optional and self.default is None

    def is_flag(self) -> bool:
        """Whether the option reads no value from the next token."""
        return self.count or self.kind == "boolean"

    def type_name(self) -> str:
        """Returns the type label help output shows."""
        if self.count:
            return "count"
        if self.kind == "enum":
            return "|".join(self.values)
        if self.kind == "integer":
            return "number"
        if self.kind in ("object", "unknown"):
            return "value"
        return self.kind

    def with_count(self) -> Type:
        """Marks the option as a counter of repeated flags: a number that defaults to 0."""
        kind: Kind = "number" if self.kind == "integer" else self.kind
        return replace(
            self, count=True, kind=kind, default=0 if self.default is None else self.default
        )


def object_type(fields: list[Field]) -> Type:
    """Creates an object schema."""
    return Type("object", fields=fields)


def json_schema(ty: Type) -> dict[str, Json]:
    """Converts a schema to the JSON Schema Zod's `z.toJSONSchema()` emits, in the same order."""
    out: dict[str, Json] = {}
    wrapped = ty.optional or ty.default is not None
    if wrapped:
        _metadata(ty, out)
    kind = ty.kind
    if kind == "array":
        _bound(out, "minItems", ty.min)
        _bound(out, "maxItems", ty.max)
        out["type"] = "array"
        assert ty.items is not None
        out["items"] = json_schema(ty.items)
    elif kind == "enum":
        out["type"] = "string"
        values: list[Json] = [*ty.values]
        out["enum"] = values
    elif kind == "integer":
        out["type"] = "integer"
        _bound(out, "minimum", -MAX_SAFE_INTEGER if ty.min is None else ty.min)
        _bound(out, "maximum", MAX_SAFE_INTEGER if ty.max is None else ty.max)
    elif kind == "object":
        out["type"] = "object"
        out["properties"] = {f.name: json_schema(f.ty) for f in ty.fields}
        required: list[Json] = [f.name for f in ty.fields if not f.ty.is_optional()]
        if required:
            out["required"] = required
        out["additionalProperties"] = False
    elif kind != "unknown":
        out["type"] = kind
        if kind != "boolean":
            prefix = "Length" if kind == "string" else "imum"
            _bound(out, "min" + prefix, ty.min)
            _bound(out, "max" + prefix, ty.max)
    if not wrapped:
        _metadata(ty, out)
    return out


def _metadata(ty: Type, out: dict[str, Json]) -> None:
    """Writes the default, description, and `.meta()` keys of a node."""
    if ty.default is not None:
        out["default"] = ty.default
    if ty.description is not None:
        out["description"] = ty.description
    if ty.count:
        out["count"] = True
    if ty.deprecated:
        out["deprecated"] = True


def _bound(out: dict[str, Json], key: str, value: float | None) -> None:
    """Writes a numeric bound when present."""
    if value is not None:
        out[key] = _js.number(value)


@dataclass
class Issue:
    """A validation issue, matching the issues Zod reports."""

    code: str
    message: str
    path: list[str | int]
    expected: str = ""
    format: str | None = None
    received: str | None = None
    values: list[str] = field(default_factory=list[str])
    bound: float = 0.0
    origin: str = ""

    def to_json(self) -> dict[str, Json]:
        """Returns the issue as Zod serializes it in `ZodError.message`, in the same order."""
        out: dict[str, Json] = {}
        if self.code == "invalid_type":
            out["expected"] = self.expected
            if self.format is not None:
                out["format"] = self.format
            out["code"] = self.code
            if self.received is not None:
                out["received"] = self.received
        elif self.code == "invalid_value":
            out["code"] = self.code
            out["values"] = list(self.values)
        else:
            key = "maximum" if self.code == "too_big" else "minimum"
            # Zod's safe-integer check reports its issue with a note and a different key order.
            if self.origin == "int":
                out["code"] = self.code
                out[key] = _js.number(self.bound)
                out["note"] = "Integers must be within the safe integer range."
                out["origin"] = self.origin
            else:
                out["origin"] = self.origin
                out["code"] = self.code
                out[key] = _js.number(self.bound)
            out["inclusive"] = True
        out["path"] = list(self.path)
        out["message"] = self.message
        return out


class _Absent:
    """Marks a value the input omits."""


_ABSENT = _Absent()

#: A value under validation, or `_ABSENT`.
Parsed: TypeAlias = "Json | _Absent"


def parse(ty: Type, value: Parsed, path: list[str | int], issues: list[Issue]) -> Parsed:
    """Validates `value` against `ty`, applying defaults and stripping unknown object keys.

    `value` is `_ABSENT` when the input omits it. Returns `_ABSENT` when an optional value is
    absent or the value is invalid.
    """
    if isinstance(value, _Absent):
        if ty.default is not None:
            return ty.default
        if ty.optional or ty.kind == "unknown":
            return _ABSENT
    if ty.kind == "enum":
        if isinstance(value, str) and value in ty.values:
            return value
        if len(ty.values) == 1:
            message = f"Invalid input: expected {_js.stringify(ty.values[0])}"
        else:
            listed = "|".join(_js.stringify(v) for v in ty.values)
            message = f"Invalid option: expected one of {listed}"
        issues.append(Issue("invalid_value", message, list(path), values=list(ty.values)))
        return _ABSENT
    if isinstance(value, _Absent):
        _invalid_type(ty, "undefined", None, path, issues)
        return _ABSENT
    return _parse_present(ty, value, path, issues)


def _parse_present(ty: Type, value: Json, path: list[str | int], issues: list[Issue]) -> Parsed:
    """Validates a value that is present in the input."""
    kind = ty.kind
    if kind == "unknown" or (kind == "boolean" and isinstance(value, bool)):
        return value
    if kind == "array" and isinstance(value, list):
        assert ty.items is not None
        out: list[Json] = []
        for index, item in enumerate(value):
            path.append(index)
            parsed = parse(ty.items, item, path, issues)
            out.append(None if isinstance(parsed, _Absent) else parsed)
            path.pop()
        _check_bounds(len(value), ty.min, ty.max, "array", path, issues)
        return out
    if kind in ("integer", "number"):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            _invalid_type(ty, _received(value), None, path, issues)
            return _ABSENT
        if math.isnan(value):
            # Zod names NaN in the message but reports infinities as numbers.
            _invalid_type(ty, "NaN", "NaN", path, issues)
            return _ABSENT
        if math.isinf(value):
            _invalid_type(ty, "number", "Infinity", path, issues)
            return _ABSENT
        if kind == "integer":
            if value != math.floor(value):
                issues.append(
                    Issue(
                        "invalid_type",
                        "Invalid input: expected int, received number",
                        list(path),
                        expected="int",
                        format="safeint",
                    )
                )
                return _ABSENT
            low = -MAX_SAFE_INTEGER if ty.min is None else ty.min
            high = MAX_SAFE_INTEGER if ty.max is None else ty.max
            unsafe = (low == -MAX_SAFE_INTEGER and value < low) or (
                high == MAX_SAFE_INTEGER and value > high
            )
            _check_bounds(value, low, high, "int" if unsafe else "number", path, issues)
        else:
            _check_bounds(value, ty.min, ty.max, "number", path, issues)
        return _js.number(value)
    if kind == "object" and isinstance(value, dict):
        result: dict[str, Json] = {}
        for f in ty.fields:
            path.append(f.name)
            parsed = parse(f.ty, value.get(f.name, _ABSENT), path, issues)
            if not isinstance(parsed, _Absent):
                result[f.name] = parsed
            path.pop()
        return result
    if kind == "string" and isinstance(value, str):
        _check_bounds(_js.utf16_len(value), ty.min, ty.max, "string", path, issues)
        return value
    _invalid_type(ty, _received(value), None, path, issues)
    return _ABSENT


def _invalid_type(
    ty: Type, received: str, reported: str | None, path: list[str | int], issues: list[Issue]
) -> None:
    """Reports an `invalid_type` issue for `ty`."""
    expected = {"integer": "number", "unknown": "string", "enum": "string"}.get(ty.kind, ty.kind)
    issues.append(
        Issue(
            "invalid_type",
            f"Invalid input: expected {expected}, received {received}",
            list(path),
            expected=expected,
            received=reported,
        )
    )


def _check_bounds(
    value: float,
    low: float | None,
    high: float | None,
    origin: str,
    path: list[str | int],
    issues: list[Issue],
) -> None:
    """Reports `too_small` and `too_big` issues."""
    unit = {"string": " characters", "array": " items"}.get(origin, "")
    verb = "have" if unit else "be"
    if low is not None and value < low:
        bound = _js.number_to_string(low)
        message = f"Too small: expected {origin} to {verb} >={bound}{unit}"
        issues.append(Issue("too_small", message, list(path), bound=low, origin=origin))
    if high is not None and value > high:
        bound = _js.number_to_string(high)
        message = f"Too big: expected {origin} to {verb} <={bound}{unit}"
        issues.append(Issue("too_big", message, list(path), bound=high, origin=origin))


def _received(value: Json) -> str:
    """Returns Zod's name for the type of a received value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "array" if isinstance(value, list) else "object"


def validate(ty: Type, data: dict[str, Json]) -> tuple[dict[str, Json], list[Issue]]:
    """Validates an object against a schema. Returns the parsed object and the issues."""
    issues: list[Issue] = []
    parsed = parse(ty, data, [], issues)
    return (parsed if isinstance(parsed, dict) else {}), issues
