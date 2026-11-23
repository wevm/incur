"""`@incur.schema` classes: the field syntax, renaming, typed handler input, and the declarations
it rejects when a class is defined or a handler is registered.
"""

from __future__ import annotations

import enum
import io
import json
import typing
from typing import Annotated, Any, Literal

import pytest
from inline_snapshot import snapshot

import incur
from incur import Context, field


def schema_json(options: type) -> Any:
    """Returns the JSON Schema `--schema` prints for a command taking `options`."""
    cli = incur.Cli("tool")

    def run(c: Context) -> None: ...

    run.__annotations__["c"] = Context[None, options]
    cli.command("run")(run)
    out = io.StringIO()
    cli.serve_with(["run", "--schema", "--format", "json"], stdout=out)
    return json.loads(out.getvalue())["options"]


class Level(enum.Enum):
    LOW = "low"
    HIGH = "high"


@incur.schema
class Inner:
    a: Annotated[str, field("A")]


@incur.schema(rename_all="camelCase")
class Options:
    out_dir: Annotated[str, field("Output directory")] = ""
    verbose: Annotated[float, field("Explicit description", alias="v", count=True, deprecated=True)]
    jobs_count: Annotated[float | None, field(name="jobs", alias="j", min=-1.5, max=2.5)] = None
    retries: int = 3
    level: Level = Level.LOW
    mode: Literal["fast", "slow"] | None = None
    tags: Annotated[list[str], field(min=1)] = ["a"]
    inner: Inner | None = None
    extra: Any = None


def test_describes_fields() -> None:
    assert schema_json(Options) == snapshot(
        {
            "type": "object",
            "properties": {
                "outDir": {"default": "", "description": "Output directory", "type": "string"},
                "verbose": {
                    "default": 0,
                    "description": "Explicit description",
                    "count": True,
                    "deprecated": True,
                    "type": "number",
                },
                "jobs": {"type": "number", "minimum": -1.5, "maximum": 2.5},
                "retries": {
                    "default": 3,
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991,
                },
                "level": {"default": "low", "type": "string", "enum": ["low", "high"]},
                "mode": {"type": "string", "enum": ["fast", "slow"]},
                "tags": {
                    "default": ["a"],
                    "minItems": 1,
                    "type": "array",
                    "items": {"type": "string"},
                },
                "inner": {
                    "type": "object",
                    "properties": {"a": {"type": "string", "description": "A"}},
                    "required": ["a"],
                    "additionalProperties": False,
                },
                "extra": {},
            },
            "required": ["outDir", "verbose", "retries", "level", "tags", "extra"],
            "additionalProperties": False,
        }
    )


def test_builds_typed_instances() -> None:
    cli = incur.Cli("tool")
    seen: list[Options] = []

    @cli.command("run")
    def run(c: Context[None, Options]) -> Options:
        seen.append(c.options)
        return c.options

    out = io.StringIO()
    argv = ["run", "-vv", "--jobs", "2", "--level", "high", "--tags", "x", "--tags", "y"]
    assert cli.serve_with(argv, stdout=out) == 0
    assert seen == [
        Options(verbose=2.0, jobs_count=2.0, level=Level.HIGH, tags=["x", "y"]),
    ]
    assert isinstance(seen[0].verbose, float)
    assert out.getvalue() == snapshot("""\
outDir: ""
verbose: 2
jobs: 2
retries: 3
level: high
tags[2]: x,y
extra: null
""")
    assert Options(verbose=0).tags == ["a"]
    assert Options(verbose=0).tags is not Options(verbose=0).tags


def test_dumps_instances() -> None:
    options = Options(verbose=1, inner=Inner(a="x"), mode="fast")
    assert incur.dump(options) == snapshot(
        {
            "outDir": "",
            "verbose": 1,
            "retries": 3,
            "level": "low",
            "mode": "fast",
            "tags": ["a"],
            "inner": {"a": "x"},
            "extra": None,
        }
    )
    with pytest.raises(incur.SchemaError, match=r"not an @incur\.schema class"):
        incur.dump(object())


def test_renames_like_serde() -> None:
    rules: list[incur.RenameRule] = [
        "camelCase",
        "kebab-case",
        "lowercase",
        "PascalCase",
        "SCREAMING-KEBAB-CASE",
        "SCREAMING_SNAKE_CASE",
        "snake_case",
        "UPPERCASE",
    ]
    names: list[str] = []
    for rule in rules:

        @incur.schema(rename_all=rule)
        class Fields:
            first_field: int

        names.append(next(iter(schema_json(Fields)["properties"])))
    assert names == snapshot(
        [
            "firstField",
            "first-field",
            "first_field",
            "FirstField",
            "FIRST-FIELD",
            "FIRST_FIELD",
            "first_field",
            "FIRST_FIELD",
        ]
    )


def test_pads_context_parameters() -> None:
    assert typing.get_args(Context[Options]) == (Options, type(None), type(None), Any, Any)


def rejects(match: str) -> pytest.RaisesExc[incur.SchemaError]:
    return pytest.raises(incur.SchemaError, match=match)


def test_rejects_declarations() -> None:
    with rejects("unknown rename_all rule 'Title Case'"):
        incur.schema(rename_all="Title Case")(type("Rule", (), {}))  # pyright: ignore[reportArgumentType]
    with rejects("duplicate field name 'value'"):

        @incur.schema
        class Duplicate:
            value: int
            other: Annotated[int, field(name="value")]

    with rejects("duplicate alias 'v'"):

        @incur.schema
        class DuplicateAlias:
            a: Annotated[bool, field(alias="v")]
            b: Annotated[bool, field(alias="v")]

    with rejects("more than one incur.field"):

        @incur.schema
        class Twice:
            value: Annotated[int, field("a"), field("b")]

    with rejects(r"unions other than `T \| None`"):

        @incur.schema
        class Union:
            value: int | str

    with rejects("Literal values must be strings"):

        @incur.schema
        class NumberLiteral:
            value: Literal[1, 2]

    class Numbers(enum.Enum):
        ONE = 1

    with rejects("Enum values must be strings"):

        @incur.schema
        class NumberEnum:
            value: Numbers

    with rejects("Mapping.value: unsupported type dict"):

        @incur.schema
        class Mapping:
            value: dict[str, int]

    with rejects("alias must be one character, got 'ab'"):

        @incur.schema
        class LongAlias:
            value: Annotated[int, field(alias="ab")]

    with rejects("min and max apply to numbers, strings, and lists"):

        @incur.schema
        class BoolBound:
            value: Annotated[bool, field(min=1)]

    with rejects("count applies to int and float fields"):

        @incur.schema
        class TextCount:
            value: Annotated[str, field(count=True)]

    with rejects("Opaque.value: default object is not JSON serializable"):

        @incur.schema
        class Opaque:
            value: Any = object()


def test_rejects_handlers() -> None:
    cli = incur.Cli("tool")
    with rejects("exactly one parameter"):

        @cli.command("two")
        def two(c: Context, extra: int) -> None: ...

    with rejects(r"annotate the parameter as incur.Context\[...\]"):

        @cli.command("plain")
        def plain(c: int) -> None: ...

    with rejects("Context parameters must be @incur.schema classes or None"):

        @cli.command("raw")
        def raw(c: Context[int]) -> None: ...


def test_returns_schema_instances_inside_data() -> None:
    cli = incur.Cli("tool")

    @cli.command("nested")
    def nested(c: Context) -> dict[str, object]:
        return {"items": (Inner(a="x"),), "level": Level.HIGH, "ratio": float("nan")}

    out = io.StringIO()
    cli.serve_with(["nested", "--json"], stdout=out)
    assert json.loads(out.getvalue()) == {"items": [{"a": "x"}], "level": "high", "ratio": None}
