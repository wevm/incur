"""Typed schema classes: `@incur.schema` dataclasses with `incur.field` metadata."""

from __future__ import annotations

import dataclasses
import enum
import inspect
import math
import types
import typing
from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated, Any, Literal, TypeVar, Union, dataclass_transform, overload

from . import _js
from ._errors import Error
from ._js import Json
from ._schema import Field, Type, object_type

_T = TypeVar("_T")

#: Naming rules for `rename_all`, as `serde` spells them.
RenameRule = Literal[
    "camelCase",
    "kebab-case",
    "lowercase",
    "PascalCase",
    "SCREAMING-KEBAB-CASE",
    "SCREAMING_SNAKE_CASE",
    "snake_case",
    "UPPERCASE",
]

_RULES: dict[str, Callable[[list[str]], str]] = {
    "camelCase": lambda w: w[0].lower() + "".join(p.capitalize() for p in w[1:]),
    "kebab-case": lambda w: "-".join(p.lower() for p in w),
    "lowercase": lambda w: "_".join(w).lower(),
    "PascalCase": lambda w: "".join(p.capitalize() for p in w),
    "SCREAMING-KEBAB-CASE": lambda w: "-".join(p.upper() for p in w),
    "SCREAMING_SNAKE_CASE": lambda w: "_".join(p.upper() for p in w),
    "snake_case": "_".join,
    "UPPERCASE": lambda w: "_".join(w).upper(),
}

_SCHEMA = "__incur_schema__"


class SchemaError(TypeError):
    """A schema class, field, or handler declaration that incur cannot describe."""


@dataclass(frozen=True)
class FieldInfo:
    """Command-line metadata of a schema field. Create it with `incur.field`."""

    description: str | None = None
    """Help text for the field."""
    alias: str | None = None
    """A single-character short flag."""
    name: str | None = None
    """The name in input and output, overriding `rename_all`."""
    min: float | None = None
    """Minimum value, string length, or item count."""
    max: float | None = None
    """Maximum value, string length, or item count."""
    count: bool = False
    """Whether the option counts repeated flags."""
    deprecated: bool = False
    """Whether the option warns when used."""


def field(
    description: str | None = None,
    *,
    alias: str | None = None,
    name: str | None = None,
    min: float | None = None,
    max: float | None = None,
    count: bool = False,
    deprecated: bool = False,
) -> FieldInfo:
    """Describes a schema field. Use it as `typing.Annotated` metadata.

    Args:
        description: Help text for the field.
        alias: A single-character short flag, such as `"D"` for `-D`.
        name: The name in input and output, overriding `rename_all`.
        min: Minimum value, string length, or item count.
        max: Maximum value, string length, or item count.
        count: Counts repeated flags (`-vvv`). The field must be a number.
        deprecated: Warns when the option is used.
    """
    return FieldInfo(description, alias, name, min, max, count, deprecated)


@overload
def schema(cls: type[_T], /) -> type[_T]: ...
@overload
def schema(*, rename_all: RenameRule | None = None) -> Callable[[type[_T]], type[_T]]: ...
@dataclass_transform(kw_only_default=True, field_specifiers=(dataclasses.field,))
def schema(
    cls: type[_T] | None = None, /, *, rename_all: RenameRule | None = None
) -> type[_T] | Callable[[type[_T]], type[_T]]:
    """Declares a schema class for arguments, options, environment variables, or output.

    The class becomes a keyword-only dataclass. Each annotated attribute is a field: `str`,
    `bool`, `int`, `float`, `list[T]`, `Literal[...]` of strings, a string `Enum`, `Any`,
    another schema class, or `T | None` for optional fields. Attach `incur.field` metadata with
    `typing.Annotated`, and give defaults as ordinary attribute values.

    >>> from typing import Annotated
    >>> @schema(rename_all="camelCase")
    ... class Options:
    ...     save_dev: Annotated[bool | None, field("Save as a dev dependency", alias="D")] = None
    >>> Options(save_dev=True)
    Options(save_dev=True)

    Raises:
        SchemaError: When a field cannot be described.
    """
    # Annotations may name classes local to the declaring function.
    scope = caller_locals()

    def wrap(target: type[_T]) -> type[_T]:
        return _declare(target, rename_all, scope)

    return wrap if cls is None else wrap(cls)


def caller_locals() -> dict[str, Any]:
    """Returns the local variables of the function calling the caller."""
    frame = inspect.currentframe()
    caller = frame.f_back.f_back if frame and frame.f_back else None
    assert caller is not None, "incur needs Python frames to resolve local annotations"
    return dict(caller.f_locals)


def _declare(cls: type[_T], rename_all: str | None, scope: dict[str, Any]) -> type[_T]:
    """Turns a class into a dataclass and attaches its schema."""
    where = cls.__qualname__
    if rename_all is not None and rename_all not in _RULES:
        raise SchemaError(
            f"{where}: unknown rename_all rule {rename_all!r}; expected one of {', '.join(_RULES)}"
        )
    # Lists are valid JSON defaults; give each instance its own copy.
    annotations = inspect.get_annotations(cls)
    for attr, value in list(vars(cls).items()):
        if isinstance(value, list) and attr in annotations:
            items = typing.cast("list[object]", value)
            setattr(cls, attr, dataclasses.field(default_factory=_copier(items)))
    data_cls = dataclasses.dataclass(kw_only=True)(cls)
    hints = typing.get_type_hints(data_cls, localns=scope, include_extras=True)
    fields: list[Field] = []
    for item in dataclasses.fields(typing.cast("Any", data_cls)):
        label = f"{where}.{item.name}"
        hint, info = _unwrap(hints[item.name], label)
        ty = _describe(hint, label)
        info = info or FieldInfo()
        ty = _apply(ty, info, label)
        default = _default(item)
        if default is not dataclasses.MISSING:
            value = _to_json(default, label)
            if value is not None:
                ty = dataclasses.replace(ty, default=_js.normalize(value))
        if info.name is not None:
            name = info.name
        elif rename_all is not None:
            name = _RULES[rename_all]([w for w in item.name.split("_") if w] or [item.name])
        else:
            name = item.name
        if any(f.name == name for f in fields):
            raise SchemaError(f"{label}: duplicate field name {name!r}")
        if info.alias is not None and any(f.alias == info.alias for f in fields):
            raise SchemaError(f"{label}: duplicate alias {info.alias!r}")
        fields.append(Field(name, ty, info.alias, item.name))
    setattr(data_cls, _SCHEMA, object_type(fields))
    return data_cls


def _copier(value: list[object]) -> Callable[[], list[object]]:
    return lambda: list(value)


def _default(item: dataclasses.Field[Any]) -> Any:
    if item.default_factory is not dataclasses.MISSING:
        return item.default_factory()
    return item.default


def _unwrap(hint: Any, label: str) -> tuple[Any, FieldInfo | None]:
    """Splits `Annotated[T, incur.field(...)]` into `T` and its metadata."""
    if typing.get_origin(hint) is not Annotated:
        return hint, None
    infos = [m for m in hint.__metadata__ if isinstance(m, FieldInfo)]
    if len(infos) > 1:
        raise SchemaError(f"{label}: more than one incur.field()")
    return hint.__origin__, (infos[0] if infos else None)


def _describe(hint: Any, label: str) -> Type:
    """Returns the schema of a type annotation."""
    origin = typing.get_origin(hint)
    if origin is Union or origin is types.UnionType:
        members = [a for a in typing.get_args(hint) if a is not type(None)]
        if len(members) != 1:
            raise SchemaError(f"{label}: unions other than `T | None` are not supported")
        return dataclasses.replace(_describe(_unwrap(members[0], label)[0], label), optional=True)
    if hint is str:
        return Type("string")
    if hint is bool:
        return Type("boolean")
    if hint is int:
        return Type("integer", py=int)
    if hint is float:
        return Type("number", py=float)
    if hint is Any:
        return Type("unknown")
    if origin is list:
        (item,) = typing.get_args(hint)
        return Type("array", items=_describe(_unwrap(item, label)[0], f"{label}[]"))
    if origin is Literal:
        values = typing.get_args(hint)
        if not all(isinstance(v, str) for v in values):
            raise SchemaError(f"{label}: Literal values must be strings")
        return Type("enum", values=list(values))
    if isinstance(hint, type) and issubclass(hint, enum.Enum):
        values = [member.value for member in hint]
        if not all(isinstance(v, str) for v in values):
            raise SchemaError(f"{label}: Enum values must be strings")
        return Type("enum", values=values, py=hint)
    nested = getattr(hint, _SCHEMA, None) if isinstance(hint, type) else None
    if isinstance(nested, Type):
        return dataclasses.replace(nested, py=hint)
    raise SchemaError(f"{label}: unsupported type {hint!r}")


def _apply(ty: Type, info: FieldInfo, label: str) -> Type:
    """Applies `incur.field` metadata to a field schema."""
    if info.alias is not None and (len(info.alias) != 1 or info.alias in "- "):
        raise SchemaError(f"{label}: alias must be one character, got {info.alias!r}")
    if (info.min is not None or info.max is not None) and ty.kind not in (
        "array",
        "integer",
        "number",
        "string",
    ):
        raise SchemaError(f"{label}: min and max apply to numbers, strings, and lists")
    if info.count and ty.kind not in ("integer", "number"):
        raise SchemaError(f"{label}: count applies to int and float fields")
    ty = dataclasses.replace(
        ty,
        description=info.description,
        deprecated=info.deprecated,
        min=info.min,
        max=info.max,
    )
    return ty.with_count() if info.count else ty


def type_of(hint: Any, label: str) -> Type:
    """Returns the schema of a type used as a command output or context parameter."""
    hint, info = _unwrap(hint, label)
    ty = _describe(hint, label)
    return _apply(ty, info, label) if info else ty


def schema_of(cls: type) -> Type | None:
    """Returns the schema attached to a schema class."""
    found = getattr(cls, _SCHEMA, None)
    return found if isinstance(found, Type) else None


def build(ty: Type, value: Any) -> Any:
    """Converts validated JSON data into the Python value a field declares."""
    if value is None:
        return None
    if ty.kind == "object" and ty.py is not None:
        kwargs = {f.attr: build(f.ty, value.get(f.name)) for f in ty.fields}
        return ty.py(**kwargs)
    if ty.kind == "array" and ty.items is not None:
        return [build(ty.items, item) for item in value]
    if ty.py is not None:
        return ty.py(value)
    return value


def dump(instance: object) -> dict[str, Json]:
    """Returns a schema class instance as JSON data, with field names as input spells them.

    Optional fields that are `None` are omitted, as they are absent from parsed input.

    >>> @schema(rename_all="camelCase")
    ... class Options:
    ...     dry_run: bool | None = None
    ...     retries: int = 3
    >>> dump(Options(retries=5))
    {'retries': 5}
    """
    ty = schema_of(type(instance))
    if ty is None:
        raise SchemaError(f"{type(instance).__qualname__} is not an @incur.schema class")
    out: dict[str, Json] = {}
    for f in ty.fields:
        value = getattr(instance, f.attr)
        if value is None and f.ty.optional:
            continue
        out[f.name] = to_json(value)
    return out


def to_json(value: object) -> Json:
    """Converts handler data into JSON data.

    Accepts JSON-compatible values, tuples, string enums, and schema class instances.
    Non-finite floats become `None`, as `JSON.stringify` writes them.

    Raises:
        Error: An `UNKNOWN` error when the value has no JSON representation.
    """
    return _js.normalize(_to_json(value, None))


def _to_json(value: object, label: str | None) -> Json:
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, enum.Enum):
        return _to_json(value.value, label)
    if isinstance(value, (list, tuple)):
        items = typing.cast("list[object] | tuple[object, ...]", value)
        return [_to_json(item, label) for item in items]
    if isinstance(value, dict):
        out: dict[str, Json] = {}
        for key, item in typing.cast("dict[object, object]", value).items():
            if not isinstance(key, str):
                raise _unserializable(f"key {key!r} is not a string", label)
            out[key] = _to_json(item, label)
        return out
    if schema_of(type(value)) is not None:
        return dump(value)
    raise _unserializable(f"{type(value).__qualname__} is not JSON serializable", label)


def _unserializable(message: str, label: str | None) -> Exception:
    if label is not None:
        return SchemaError(f"{label}: default {message}")
    return Error("UNKNOWN", message)
