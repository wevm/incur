"""Schema nodes, JSON Schema output, and Zod-compatible validation."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field, replace
from typing import Literal, TypeAlias

from . import _js
from ._js import Json

#: The shape of a schema node.
Kind = Literal[
    "array",
    "boolean",
    "enum",
    "integer",
    "intersection",
    "literal",
    "null",
    "number",
    "object",
    "record",
    "string",
    "union",
    "unknown",
]

#: The pattern of Zod's `z.iso.datetime()`: UTC timestamps with optional seconds and fractions.
ISO_DATETIME = (
    r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29"
    r"|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)"
    r"|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$"
)

#: The largest integer a JavaScript number represents exactly, which bounds Zod's `z.int()`.
MAX_SAFE_INTEGER = 9_007_199_254_740_991


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
    coerce: bool = False
    """Whether input converts with JavaScript's `Number()` or `Boolean()` first, as
    `z.coerce` does."""
    pattern: str | None = None
    """A regular expression strings must match somewhere."""
    format: str | None = None
    """A string format Zod checks, such as `date-time`."""
    loose: bool = False
    """Whether an object keeps unknown keys."""
    variants: list[Type] = field(default_factory=list["Type"])
    """The options of a union, or the two sides of an intersection."""
    literal: Json = None
    """The value a `literal` schema accepts."""
    exclusive: bool = False
    """Whether exactly one option of a union must match, as `z.xor` requires."""
    extra: dict[str, Json] = field(default_factory=dict[str, Json])
    """Metadata that JSON Schema output carries verbatim, such as `example`."""
    raw: dict[str, Json] | None = None
    """The JSON Schema to emit, for schemas converted from JSON Schema."""
    required: bool | None = None
    """Whether an object lists the field as required, when it differs from `is_optional`."""
    null_default: bool = False
    """Whether the default is JSON null, which `default` cannot tell from no default."""

    def field(self, name: str) -> Field | None:
        """Returns the field with the given name."""
        return next((f for f in self.fields if f.name == name), None)

    def has_default(self) -> bool:
        """Whether the input may omit the field and get a default, including JSON null."""
        return self.default is not None or self.null_default

    def is_optional(self) -> bool:
        """Whether the input may omit the field without a default, as Zod's `optout` reports."""
        return self.optional and not self.has_default()

    def is_flag(self) -> bool:
        """Whether the option reads no value from the next token."""
        return self.count or self.kind == "boolean"

    def unwrap(self) -> Type:
        """Returns the only non-null option of a union, or the schema itself.

        The parser and help read a union such as `type: ["array", "null"]` as its array.
        """
        if self.kind != "union":
            return self
        options = [v for v in self.variants if v.kind != "null"]
        return options[0].unwrap() if len(options) == 1 else self

    def type_name(self) -> str:
        """Returns the type label help output shows."""
        if self.count:
            return "count"
        ty = self.unwrap()
        if ty.kind == "enum":
            return "|".join(ty.values)
        if ty.kind == "integer":
            return "number"
        if ty.kind in ("object", "record", "unknown"):
            return "value"
        return ty.kind

    def with_count(self) -> Type:
        """Marks the option as a counter of repeated flags: a number that defaults to 0."""
        kind: Kind = "number" if self.kind == "integer" else self.kind
        return replace(
            self, count=True, kind=kind, default=0 if self.default is None else self.default
        )


def object_type(fields: list[Field]) -> Type:
    """Creates an object schema."""
    return Type("object", fields=fields)


def json_schema(ty: Type, io: Literal["input", "output"] = "output") -> dict[str, Json]:
    """Converts a schema to the JSON Schema Zod's `z.toJSONSchema()` emits, in the same order.

    The `input` view describes what the input may omit: fields with defaults are not required,
    and objects accept other keys.
    """
    if ty.raw is not None:
        return dict(ty.raw)
    out: dict[str, Json] = {}
    wrapped = ty.optional or ty.has_default()
    if wrapped:
        _metadata(ty, out)
    kind = ty.kind
    if kind == "array":
        _bound(out, "minItems", ty.min)
        _bound(out, "maxItems", ty.max)
        out["type"] = "array"
        assert ty.items is not None
        out["items"] = json_schema(ty.items, io)
    elif kind == "enum":
        out["type"] = "string"
        values: list[Json] = [*ty.values]
        out["enum"] = values
    elif kind == "integer":
        out["type"] = "integer"
        _bound(out, "minimum", -MAX_SAFE_INTEGER if ty.min is None else ty.min)
        _bound(out, "maximum", MAX_SAFE_INTEGER if ty.max is None else ty.max)
    elif kind == "record":
        out["type"] = "object"
        out["propertyNames"] = {"type": "string"}
        out["additionalProperties"] = {}
    elif kind == "object":
        out["type"] = "object"
        out["properties"] = {f.name: json_schema(f.ty, io) for f in ty.fields}
        required: list[Json] = [
            f.name
            for f in ty.fields
            if (not f.ty.is_optional() if f.ty.required is None else f.ty.required)
            and (io == "output" or not f.ty.has_default())
        ]
        if required:
            out["required"] = required
        if io == "output":
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
    if ty.has_default():
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
        out[key] = value


@dataclass
class Issue:
    """A validation issue, matching the issues Zod reports."""

    code: str
    message: str
    path: list[str | int]
    expected: str = ""
    format: str | None = None
    received: str | None = None
    values: list[Json] = field(default_factory=list[Json])
    bound: float = 0.0
    origin: str = ""
    pattern: str = ""
    errors: list[list[Issue]] = field(default_factory=list[list["Issue"]])
    """The issues of each option of a failed union, with paths relative to the union."""
    inclusive: bool | None = None
    """`False` when more than one option of an exclusive union matched."""

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
        elif self.code == "invalid_format":
            out["origin"] = self.origin
            out["code"] = self.code
            out["format"] = self.format
            out["pattern"] = self.pattern
        elif self.code == "invalid_union":
            out["code"] = self.code
            out["errors"] = [[i.to_json() for i in option] for option in self.errors]
            if self.inclusive is not None:
                out["inclusive"] = self.inclusive
        else:
            key = "maximum" if self.code == "too_big" else "minimum"
            # Zod's safe-integer check reports its issue with a note and a different key order.
            if self.origin == "int":
                out["code"] = self.code
                out[key] = self.bound
                out["note"] = "Integers must be within the safe integer range."
                out["origin"] = self.origin
            else:
                out["origin"] = self.origin
                out["code"] = self.code
                out[key] = self.bound
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
        if ty.has_default():
            return ty.default
        if ty.optional or ty.kind == "unknown":
            return _ABSENT
        if ty.coerce:
            # `Number(undefined)` is NaN; `Boolean(undefined)` is false.
            number = ty.kind in ("integer", "number")
            return _parse_present(ty, math.nan if number else False, path, issues)
    if ty.kind in ("enum", "literal"):
        return _parse_choice(ty, value, path, issues)
    if isinstance(value, _Absent):
        _invalid_type(ty, "undefined", None, path, issues)
        return _ABSENT
    return _parse_present(ty, value, path, issues)


def _parse_choice(ty: Type, value: Parsed, path: list[str | int], issues: list[Issue]) -> Parsed:
    """Validates a value against an enum or a literal, which report absent values the same."""
    if ty.kind == "literal":
        literal = ty.literal
        # Zod compares with `===`: numbers by value, objects never.
        numbers = is_number(literal) and not isinstance(value, (_Absent, bool)) and is_number(value)
        same = numbers or (type(value) is type(literal) and not isinstance(value, (list, dict)))
        if same and value == literal:
            return value
        message = f"Invalid input: expected {_js.stringify(literal)}"
        issues.append(Issue("invalid_value", message, list(path), values=[literal]))
        return _ABSENT
    if isinstance(value, str) and value in ty.values:
        return value
    if len(ty.values) == 1:
        message = f"Invalid input: expected {_js.stringify(ty.values[0])}"
    else:
        listed = "|".join(_js.stringify(v) for v in ty.values)
        message = f"Invalid option: expected one of {listed}"
    issues.append(Issue("invalid_value", message, list(path), values=list(ty.values)))
    return _ABSENT


def _parse_present(ty: Type, value: Json, path: list[str | int], issues: list[Issue]) -> Parsed:
    """Validates a value that is present in the input."""
    kind = ty.kind
    if ty.coerce:
        value = _js_number(value) if kind in ("integer", "number") else _js_truthy(value)
    if kind in ("enum", "literal"):
        return _parse_choice(ty, value, path, issues)
    if kind == "union":
        return _parse_union(ty, value, path, issues)
    if kind == "intersection":
        return _parse_intersection(ty, value, path, issues)
    if kind == "unknown" or (kind == "boolean" and isinstance(value, bool)):
        return value
    if kind == "null" and value is None:
        return None
    if kind == "record" and isinstance(value, dict):
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
        if isinstance(value, float) and math.isnan(value):
            # Zod names NaN in the message but reports infinities as numbers.
            _invalid_type(ty, "NaN", "NaN", path, issues)
            return _ABSENT
        if isinstance(value, float) and math.isinf(value):
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
            return int(value)
        _check_bounds(value, ty.min, ty.max, "number", path, issues)
        return value
    if kind == "object" and isinstance(value, dict):
        result: dict[str, Json] = {}
        for f in ty.fields:
            path.append(f.name)
            parsed = parse(f.ty, value.get(f.name, _ABSENT), path, issues)
            if not isinstance(parsed, _Absent):
                result[f.name] = parsed
            path.pop()
        if ty.loose:
            known = {f.name for f in ty.fields}
            result.update((k, v) for k, v in value.items() if k not in known)
        return result
    if kind == "string" and isinstance(value, str):
        if ty.format == "date-time" and not re.search(ISO_DATETIME, value):
            issues.append(
                Issue(
                    "invalid_format",
                    "Invalid ISO datetime",
                    list(path),
                    format="datetime",
                    origin="string",
                    pattern=f"/{ISO_DATETIME}/",
                )
            )
        _check_bounds(_js.utf16_len(value), ty.min, ty.max, "string", path, issues)
        if ty.pattern is not None and not re.search(ty.pattern, value):
            issues.append(
                Issue(
                    "invalid_format",
                    f"Invalid string: must match pattern /{ty.pattern}/",
                    list(path),
                    format="regex",
                    origin="string",
                    pattern=f"/{ty.pattern}/",
                )
            )
        return value
    _invalid_type(ty, _received(value), None, path, issues)
    return _ABSENT


def is_number(value: Json) -> bool:
    """Whether a value is a JavaScript number: an `int` or `float`, but not a `bool`."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _js_number(value: Json) -> Json:
    """Converts a value as JavaScript's `Number()` does."""
    if value is None or value is False:
        return 0
    if value is True:
        return 1
    if isinstance(value, str):
        return _js.to_number(value)
    return value if isinstance(value, (int, float)) else math.nan


def _js_truthy(value: Json) -> bool:
    """Converts a value as JavaScript's `Boolean()` does."""
    return value not in (None, False, 0, "")


def _parse_union(ty: Type, value: Json, path: list[str | int], issues: list[Issue]) -> Parsed:
    """Returns the value parsed by the first matching option, as `z.union` does."""
    errors: list[list[Issue]] = []
    matches: list[Parsed] = []
    for variant in ty.variants:
        attempt: list[Issue] = []
        parsed = _parse_present(variant, value, [], attempt)
        if not attempt and not ty.exclusive:
            return parsed
        if attempt:
            errors.append(attempt)
        else:
            matches.append(parsed)
    if len(matches) == 1:
        return matches[0]
    if matches:
        # More than one option of `z.xor` matched.
        issues.append(Issue("invalid_union", "Invalid input", list(path), inclusive=False))
    else:
        issues.append(Issue("invalid_union", "Invalid input", list(path), errors=errors))
    return _ABSENT


def _parse_intersection(
    ty: Type, value: Json, path: list[str | int], issues: list[Issue]
) -> Parsed:
    """Parses a value with both sides of an intersection and merges the results.

    Raises:
        ValueError: When both sides succeed with values that cannot merge, as Zod throws.
    """
    count = len(issues)
    left, right = (_parse_present(side, value, path, issues) for side in ty.variants)
    if len(issues) > count or isinstance(left, _Absent) or isinstance(right, _Absent):
        return _ABSENT
    merged, at = _merge(left, right)
    if at is not None:
        raise ValueError(f"Unmergable intersection. Error path: {_js.stringify(at)}")
    return merged


def _merge(a: Json, b: Json) -> tuple[Json, list[Json] | None]:
    """Merges the results of an intersection, as Zod's `mergeValues` does.

    Returns the merged value and, when the results conflict, the path of the conflict.
    """
    if a == b and type(a) is type(b):
        return a, None
    if isinstance(a, dict) and isinstance(b, dict):
        out = {**a, **b}
        for key in a.keys() & b.keys():
            out[key], at = _merge(a[key], b[key])
            if at is not None:
                return None, [key, *at]
        return out, None
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        items: list[Json] = []
        for index, (x, y) in enumerate(zip(a, b, strict=True)):
            item, at = _merge(x, y)
            if at is not None:
                return None, [index, *at]
            items.append(item)
        return items, None
    return None, []


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
