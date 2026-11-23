"""Commands, their run context, results, and middleware."""

from __future__ import annotations

import dataclasses
import inspect
import typing
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Generic, Literal

from ._errors import CtaBlock
from ._formatter import Format
from ._help import Example, Usage
from ._js import Json
from ._model import SchemaError, schema_of
from ._schema import Type

if TYPE_CHECKING:
    from typing_extensions import TypeVar
else:
    from typing import TypeVar as _TypeVar

    def TypeVar(name: str, default: object = None) -> object:  # noqa: N802
        """Creates a type variable; defaults only matter to type checkers."""
        return _TypeVar(name)


A = TypeVar("A", default=None)
O = TypeVar("O", default=None)  # noqa: E741
E = TypeVar("E", default=None)

#: Where a command's output may appear: everywhere, or only to agents.
OutputPolicy = Literal["all", "agent-only"]


@dataclass
class Context(Generic[A, O, E]):
    """The context a command handler receives.

    Parameterize the handler's annotation with the schema classes it reads:
    `Context[Args, Options, Env]`, where omitted parameters default to `None` (no input).
    """

    agent: bool
    """Whether the consumer is an agent (stdout is not a terminal)."""
    args: A
    """Positional arguments."""
    display_name: str
    """The binary name the user invoked."""
    env: E
    """Environment variables declared by the command."""
    format: Format
    """The resolved output format."""
    format_explicit: bool
    """Whether the user passed `--format` or `--json`."""
    globals: dict[str, Json]
    """Global options, as parsed JSON data."""
    name: str
    """The CLI name."""
    options: O
    """Named options."""
    var: dict[str, Any]
    """Variables set by middleware or as CLI defaults."""
    version: str | None
    """The CLI version."""

    def __class_getitem__(cls, params: object) -> Any:
        """Fills omitted type parameters with `None`."""
        items = typing.cast(
            "tuple[object, ...]", params if isinstance(params, tuple) else (params,)
        )
        padded = (*items, *(None,) * (3 - len(items)))
        # `Generic` implements `__class_getitem__` at runtime only.
        return super().__class_getitem__(padded)  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]


@dataclass
class MiddlewareContext:
    """The context middleware receives."""

    agent: bool
    """Whether the consumer is an agent."""
    command: str
    """The resolved command path."""
    display_name: str
    """The binary name the user invoked."""
    env: dict[str, Json]
    """CLI-level environment variables, as parsed JSON data."""
    format: Format
    """The resolved output format."""
    format_explicit: bool
    """Whether the user passed `--format` or `--json`."""
    globals: dict[str, Json]
    """Global options, as parsed JSON data."""
    name: str
    """The CLI name."""
    var: dict[str, Any]
    """Variables for downstream middleware and handlers."""
    version: str | None
    """The CLI version."""

    def set(self, key: str, value: object) -> None:
        """Sets a variable for downstream middleware and handlers."""
        self.var[key] = value


#: Runs the rest of the middleware chain and the command.
Next = Callable[[], None]

#: Middleware: runs around command handlers in registration order. Raise `incur.Error` to fail.
Middleware = Callable[[MiddlewareContext, Next], None]


@dataclass
class Outcome:
    """Handler data with suggested next commands. Create it with `incur.ok`."""

    data: object
    """The data, or `None` for no data."""
    cta: CtaBlock | None
    """Suggested next commands."""


def ok(data: object = None, *, cta: CtaBlock | None = None) -> Outcome:
    """Returns data with suggested next commands.

    Return it from a handler, or from a streaming handler (a generator) to attach suggestions
    after the stream.
    """
    return Outcome(data, cta)


#: A command handler. Generators stream their yielded chunks.
Handler = Callable[[Context[Any, Any, Any]], object]


@dataclass
class Command:
    """A registered command."""

    handler: Callable[..., object] | None = None
    aliases: list[str] = field(default_factory=list[str])
    args: Type | None = None
    destructive: bool = False
    description: str | None = None
    env: Type | None = None
    examples: list[Example] = field(default_factory=list[Example])
    format: Format | None = None
    hint: str | None = None
    middleware: list[Middleware] = field(default_factory=list[Middleware])
    options: Type | None = None
    output: Type | None = None
    output_policy: OutputPolicy | None = None
    usage: list[Usage] = field(default_factory=list[Usage])


def inputs(
    fn: Callable[..., object], scope: dict[str, Any]
) -> tuple[Type | None, Type | None, Type | None]:
    """Reads the args, options, and env schemas from a handler's `Context[...]` annotation."""
    label = getattr(fn, "__qualname__", repr(fn))
    params = list(inspect.signature(fn).parameters.values())
    if len(params) != 1:
        raise SchemaError(f"{label}: a handler takes exactly one parameter, the context")
    hint = typing.get_type_hints(fn, localns=scope).get(params[0].name, Context)
    if hint is Context:
        return None, None, None
    if typing.get_origin(hint) is not Context:
        raise SchemaError(f"{label}: annotate the parameter as incur.Context[...]")
    found: list[Type | None] = []
    for arg in typing.get_args(hint):
        if arg is type(None):
            found.append(None)
            continue
        ty = schema_of(arg) if isinstance(arg, type) else None
        if ty is None:
            raise SchemaError(f"{label}: Context parameters must be @incur.schema classes or None")
        found.append(dataclasses.replace(ty, py=arg))
    return found[0], found[1], found[2]
