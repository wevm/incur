"""JSON Schema to schema nodes, as Zod's `z.fromJSONSchema` converts them.

Generated OpenAPI and MCP-source commands build their input from JSON Schema. Each node keeps
the JSON Schema that Zod would emit for it (`Type.raw`), because that output follows Zod's
wrapper rules: a wrapper's own keys, such as `default` or a description added after
`.optional()`, come before the keys of the schema it wraps.
"""

from __future__ import annotations

from dataclasses import replace

from ._js import Json
from ._schema import ISO_DATETIME, MAX_SAFE_INTEGER, Field, Kind, Type, is_number

#: Keys Zod's converter reads; any other key is kept as metadata.
_RECOGNIZED = frozenset(
    {
        "$schema",
        "$ref",
        "$defs",
        "definitions",
        "$id",
        "id",
        "$comment",
        "$anchor",
        "$vocabulary",
        "$dynamicRef",
        "$dynamicAnchor",
        "type",
        "enum",
        "const",
        "anyOf",
        "oneOf",
        "allOf",
        "not",
        "properties",
        "required",
        "additionalProperties",
        "patternProperties",
        "propertyNames",
        "minProperties",
        "maxProperties",
        "items",
        "prefixItems",
        "additionalItems",
        "minItems",
        "maxItems",
        "uniqueItems",
        "contains",
        "minContains",
        "maxContains",
        "minLength",
        "maxLength",
        "pattern",
        "format",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "description",
        "default",
        "contentEncoding",
        "contentMediaType",
        "contentSchema",
        "unevaluatedItems",
        "unevaluatedProperties",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "dependentRequired",
        "nullable",
        "readOnly",
    }
)
#: Recognized keys that Zod still keeps as metadata.
_KEPT = ("$id", "id", "$comment", "$anchor", "$vocabulary", "$dynamicRef", "$dynamicAnchor")
_CONTENT = ("contentEncoding", "contentMediaType", "contentSchema")


def _number(value: Json | None) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def convert(schema: Json) -> Type:
    """Converts a JSON Schema to a schema node, as `z.fromJSONSchema` does."""
    if not isinstance(schema, dict):
        return Type("unknown", raw={})
    ty = _compose(schema, _base(schema))
    extra = {k: schema[k] for k in (*_KEPT, *_CONTENT) if k in schema}
    extra.update((k, v) for k, v in schema.items() if k not in _RECOGNIZED)
    if not extra:
        return ty
    raw = ty.raw or {}
    deprecated = extra.get("deprecated") is True
    if ty.default is not None:
        rest = {k: v for k, v in raw.items() if k != "default" and k not in extra}
        raw = {"default": ty.default, **extra, **rest}
        return replace(ty, raw=raw, extra=extra, deprecated=deprecated)
    # Zod stores the metadata in place of the description, which is lost.
    raw = {**{k: v for k, v in raw.items() if k != "description"}, **extra}
    return replace(ty, raw=raw, extra=extra, deprecated=deprecated, description=None)


def _compose(schema: dict[str, Json], ty: Type) -> Type:
    """Applies `anyOf`, `oneOf`, and `allOf`: each replaces an untyped base or intersects it."""
    explicit = schema.get("type") not in (None, "") or "enum" in schema or "const" in schema
    for key in ("anyOf", "oneOf"):
        options = schema.get(key)
        if isinstance(options, list):
            variants = [convert(o) for o in options]
            raws: list[Json] = [v.raw for v in variants]
            union = Type("union", variants=variants, exclusive=key == "oneOf", raw={key: raws})
            ty = _intersect(ty, union) if explicit else union
    members = schema.get("allOf")
    if isinstance(members, list):
        if not members:
            return ty if explicit else Type("unknown", raw={})
        if not explicit:
            ty = convert(members[0])
        for member in members if explicit else members[1:]:
            ty = _intersect(ty, convert(member))
    return ty


def _intersect(left: Type, right: Type) -> Type:
    """Intersects two schemas, as `z.intersection` does, flattening plain `allOf` lists."""
    raws: list[Json] = []
    for side in (left.raw or {}, right.raw or {}):
        allof = side.get("allOf")
        raws += allof if list(side) == ["allOf"] and isinstance(allof, list) else [side]
    return Type("intersection", variants=[left, right], raw={"allOf": raws})


def _base(schema: dict[str, Json]) -> Type:
    """Converts the type-defining keys, then applies the description and default."""
    kind = schema.get("type")
    enum = schema.get("enum")
    const = schema.get("const", ...)
    if isinstance(enum, list) and len(enum) == 1:
        const = enum[0]
    # Enums, constants, and type unions skip the description and default, as Zod's converter
    # returns them early.
    if isinstance(enum, list) and len(enum) > 1:
        strings = [v for v in enum if isinstance(v, str)]
        if len(strings) == len(enum):
            return Type("enum", values=strings, raw={"type": "string", "enum": list[Json](strings)})
        literals = [_literal(v) for v in enum]
        raws: list[Json] = [v.raw for v in literals]
        return Type("union", variants=literals, raw={"anyOf": raws})
    if const is not ...:
        if isinstance(const, str):
            return Type("enum", values=[const], raw={"type": "string", "const": const})
        return _literal(const)
    if isinstance(kind, list):
        variants = [_base({**schema, "type": t}) for t in kind]
        if len(variants) == 1:
            return variants[0]
        raws: list[Json] = [v.raw for v in variants if v.raw is not None]
        return Type("union", variants=variants, raw={"anyOf": raws})
    if kind == "string":
        ty = _string(schema)
    elif kind in ("number", "integer"):
        ty = _numeric(schema, "integer" if kind == "integer" else "number")
    elif kind in ("boolean", "null"):
        ty = Type("boolean" if kind == "boolean" else "null", raw={"type": kind})
    elif kind == "object":
        ty = _object(schema)
    elif kind == "array":
        ty = _array(schema)
    else:
        ty = Type("unknown", raw={})
    description = schema.get("description")
    if isinstance(description, str) and description:
        ty = describe(ty, description)
    if "default" in schema and schema["default"] is not None:
        default = schema["default"]
        assert ty.raw is not None
        ty = replace(ty, default=default, raw={"default": default, **ty.raw})
    return ty


def _literal(value: Json) -> Type:
    """A schema that accepts one value, as `z.literal` does."""
    if value is None:
        kind = "null"
    elif isinstance(value, bool):
        kind = "boolean"
    elif is_number(value):
        kind = "number"
    else:
        kind = "string" if isinstance(value, str) else "object"
    return Type("literal", literal=value, raw={"type": kind, "const": value})


def _string(schema: dict[str, Json]) -> Type:
    low, high = _number(schema.get("minLength")), _number(schema.get("maxLength"))
    pattern = schema.get("pattern")
    pattern = pattern if isinstance(pattern, str) and pattern else None
    date_time = schema.get("format") == "date-time"
    raw: dict[str, Json] = {"type": "string"}
    if low is not None:
        raw["minLength"] = low
    if high is not None:
        raw["maxLength"] = high
    patterns = [p for p in (ISO_DATETIME if date_time else None, pattern) if p is not None]
    # A pattern check replaces the format Zod reports.
    if date_time and pattern is None:
        raw["format"] = "date-time"
    if len(patterns) == 1:
        raw["pattern"] = patterns[0]
    elif patterns:
        raw["allOf"] = [{"pattern": p} for p in patterns]
    return Type(
        "string",
        min=low,
        max=high,
        pattern=pattern,
        format="date-time" if date_time else None,
        raw=raw,
    )


def _numeric(schema: dict[str, Json], kind: Kind) -> Type:
    low, high = _number(schema.get("minimum")), _number(schema.get("maximum"))
    raw: dict[str, Json] = {"type": kind}
    if kind == "integer":
        raw["minimum"] = -MAX_SAFE_INTEGER if low is None else max(low, -MAX_SAFE_INTEGER)
        raw["maximum"] = MAX_SAFE_INTEGER if high is None else min(high, MAX_SAFE_INTEGER)
    else:
        if low is not None:
            raw["minimum"] = low
        if high is not None:
            raw["maximum"] = high
    return Type(kind, min=low, max=high, raw=raw)


def _object(schema: dict[str, Json]) -> Type:
    properties = schema.get("properties")
    required = schema.get("required")
    names = set(required) if isinstance(required, list) else set[Json]()
    fields: list[Field] = []
    for name, prop in (properties if isinstance(properties, dict) else {}).items():
        ty = convert(prop)
        fields.append(Field(name, ty if name in names else optional(ty)))
    extra = schema.get("additionalProperties")
    raw: dict[str, Json] = {
        "type": "object",
        "properties": {f.name: f.ty.raw for f in fields},
    }
    listed: list[Json] = [f.name for f in fields if f.ty.required is not False]
    if listed:
        raw["required"] = listed
    raw["additionalProperties"] = (
        False if extra is False else convert(extra).raw if isinstance(extra, dict) else {}
    )
    return Type("object", fields=fields, loose=extra is not False, raw=raw)


def _array(schema: dict[str, Json]) -> Type:
    items = schema.get("items")
    item = convert(items) if isinstance(items, dict) else Type("unknown", raw={})
    low, high = _number(schema.get("minItems")), _number(schema.get("maxItems"))
    raw: dict[str, Json] = {}
    if low is not None:
        raw["minItems"] = low
    if high is not None:
        raw["maxItems"] = high
    raw.update(type="array", items=item.raw)
    return Type("array", items=item, min=low, max=high, raw=raw)


def describe(ty: Type, text: str) -> Type:
    """Adds a description, as `.describe()` does.

    A wrapper's own keys come first: the description of an optional schema leads, and that of a
    schema with a default follows the default. A plain schema lists it last.
    """
    raw = {k: v for k, v in (ty.raw or {}).items() if k != "description"}
    if ty.optional:
        raw = {"description": text, **raw}
    elif ty.default is not None:
        raw = {"default": ty.default, **ty.extra, "description": text, **raw}
    else:
        raw = {**(ty.raw or {}), "description": text}
    return replace(ty, description=text, raw=raw)


def optional(ty: Type) -> Type:
    """Makes a schema optional, as `.optional()` does."""
    return replace(ty, optional=True, required=False)


def coerce(ty: Type) -> Type:
    """Coerces number and boolean input from text, as incur's `coerceIfNeeded` does.

    Applies to plain and optional numbers, booleans, and unions containing them; a schema with a
    default keeps its type.
    """
    if ty.default is not None:
        return ty
    kinds = [v.kind for v in ty.variants] if ty.kind == "union" else [ty.kind]
    if "number" in kinds or "integer" in kinds:
        kind: Kind = "number"
    elif "boolean" in kinds:
        kind = "boolean"
    else:
        return ty
    coerced = Type(
        kind,
        coerce=True,
        optional=ty.optional,
        required=False if ty.optional else None,
        raw={"type": kind},
    )
    return describe(coerced, ty.description) if ty.description else coerced
