"""Commands, their run context, results, middleware, and the transport-independent executor."""

from __future__ import annotations

import asyncio
import contextvars
import dataclasses
import inspect
import threading
import typing
from collections.abc import AsyncGenerator, Awaitable, Callable, Generator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Generic, Literal

from ._elicit import Elicit
from ._errors import CtaBlock, Error, unknown
from ._formatter import Format
from ._help import Example, Usage
from ._http import Request
from ._js import Json
from ._model import SchemaError, build, schema_of, to_json
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
V = TypeVar("V", default=Any)
G = TypeVar("G", default=Any)
CE = TypeVar("CE", default=Any)

#: Where a command's output may appear: everywhere, or only to agents.
OutputPolicy = Literal["all", "agent-only"]


@dataclass
class Context(Generic[A, O, E, V, G]):
    """The context a command handler receives.

    Parameterize the handler's annotation with the schema classes it reads:
    `Context[Args, Options, Env, Vars, Globals]`. Omitted input parameters default to `None` (no
    input); omitted `Vars` and `Globals` are untyped.
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
    globals: G
    """Global options: an instance of the CLI's `globals` class, or `None` without one."""
    name: str
    """The CLI name."""
    options: O
    """Named options."""
    var: V
    """Variables set by middleware: an instance of the CLI's `vars` class, or a `dict`."""
    version: str | None
    """The CLI version."""
    request: Request | None = None
    """The HTTP request, when the command runs over HTTP or HTTP MCP."""
    elicit: Elicit = field(default_factory=Elicit)
    """Asks the MCP client's user for input while the command runs as a 2026-07-28 tool."""

    def __class_getitem__(cls, params: object) -> Any:
        """Fills omitted input parameters with `None`, and omitted state parameters with `Any`."""
        padded = _pad(params, (None, None, None, Any, Any))
        # `Generic` implements `__class_getitem__` at runtime only.
        return super().__class_getitem__(padded)  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]


def _pad(params: object, fill: tuple[object, ...]) -> tuple[object, ...]:
    """Fills omitted type parameters, which runtime `Generic` subscription requires."""
    items = typing.cast("tuple[object, ...]", params if isinstance(params, tuple) else (params,))
    return (*items, *fill[len(items) :])


@dataclass
class MiddlewareContext(Generic[V, CE, G]):
    """The context middleware receives.

    Parameterize the annotation with the CLI's classes: `MiddlewareContext[Vars, Env, Globals]`.
    """

    agent: bool
    """Whether the consumer is an agent."""
    command: str
    """The resolved command path."""
    display_name: str
    """The binary name the user invoked."""
    env: CE
    """CLI-level environment variables: an instance of the CLI's `env` class, or `None`."""
    format: Format
    """The resolved output format."""
    format_explicit: bool
    """Whether the user passed `--format` or `--json`."""
    globals: G
    """Global options: an instance of the CLI's `globals` class, or `None` without one."""
    name: str
    """The CLI name."""
    var: V
    """Variables for downstream middleware and handlers: assign attributes, or keys of a `dict`."""
    version: str | None
    """The CLI version."""
    request: Request | None = None
    """The HTTP request, when the command runs over HTTP or HTTP MCP."""

    def __class_getitem__(cls, params: object) -> Any:
        """Fills omitted parameters with `Any`."""
        padded = _pad(params, (Any, Any, Any))
        return super().__class_getitem__(padded)  # pyright: ignore[reportAttributeAccessIssue, reportUnknownMemberType, reportUnknownVariableType]

    def set(self, key: str, value: object) -> None:
        """Sets a variable for downstream middleware and handlers, as `c.var.<key> = value` does."""
        var: object = self.var
        if isinstance(var, dict):
            typing.cast("dict[str, object]", var)[key] = value
        else:
            setattr(var, key, value)


#: Runs the rest of the middleware chain and the command. `async def` middleware awaits it;
#: plain functions call it, and it returns once the rest of the chain has finished.
Next = Callable[[], Awaitable[None]]

#: Middleware: runs around command handlers in registration order. Raise `incur.Error` to fail.
#: Plain functions run in a worker thread, so their blocking `next()` cannot stall the event loop.
Middleware = Callable[[MiddlewareContext[Any, Any, Any], Next], Awaitable[None] | None]


@dataclass
class Outcome:
    """Handler data with suggested next commands. Create it with `incur.ok`."""

    data: object
    """The data, or `None` for no data."""
    cta: CtaBlock | None
    """Suggested next commands."""


def ok(data: object = None, *, cta: CtaBlock | None = None) -> Outcome:
    """Returns data with suggested next commands.

    Return it from a handler. A streaming handler yields it last, or a generator returns it, to
    attach suggestions after the stream; its data is ignored.
    """
    return Outcome(data, cta)


@dataclass
class ToolMeta:
    """How a command appears as an MCP tool."""

    name: str | None = None
    description: str | None = None
    annotations: dict[str, Json] | None = None
    instructions: str | None = None
    title: str | None = None
    icons: list[Json] | None = None
    headers: dict[str, str] | None = None
    app: str | None = None


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
    mcp: ToolMeta | None = None
    mcp_enabled: bool = True


def inputs(
    fn: Callable[..., object], scope: dict[str, Any], state: tuple[type | None, type | None]
) -> tuple[Type | None, Type | None, Type | None]:
    """Reads the args, options, and env schemas from a handler's `Context[...]` annotation.

    `state` holds the vars and globals classes of the registering CLI, which the annotation's
    `Vars` and `Globals` must match when both name a class.
    """
    label = getattr(fn, "__qualname__", repr(fn))
    params = list(inspect.signature(fn).parameters.values())
    if len(params) != 1:
        raise SchemaError(f"{label}: a handler takes exactly one parameter, the context")
    hint = typing.get_type_hints(fn, localns=scope).get(params[0].name, Context)
    if hint is Context:
        return None, None, None
    if typing.get_origin(hint) is not Context:
        raise SchemaError(f"{label}: annotate the parameter as incur.Context[...]")
    *schemas, vars_, globals_ = typing.get_args(hint)
    for name, declared, expected in (("vars", vars_, state[0]), ("globals", globals_, state[1])):
        # `Any` is a class too, from Python 3.11.
        typed = isinstance(declared, type) and declared is not Any
        if typed and expected is not None and declared is not expected:
            raise SchemaError(
                f"{label}: Context {name} must be {expected.__qualname__}, the CLI's {name} class"
            )
    found: list[Type | None] = []
    for arg in schemas:
        if arg is type(None):
            found.append(None)
            continue
        ty = schema_of(arg) if isinstance(arg, type) else None
        if ty is None:
            raise SchemaError(f"{label}: Context parameters must be @incur.schema classes or None")
        found.append(dataclasses.replace(ty, py=arg))
    return found[0], found[1], found[2]


class Stream:
    """The chunks a streaming handler yields, from a generator or an async generator.

    Iteration ends at the first yielded `incur.ok(...)`, which becomes `final`, as does the
    value a generator returns.
    """

    def __init__(
        self, source: Generator[object, None, object] | AsyncGenerator[object, None]
    ) -> None:
        self.source = source
        self.final: object = None
        """The stream's result: an `Outcome` with suggestions, or `None`."""

    def __aiter__(self) -> Stream:
        return self

    async def __anext__(self) -> object:
        source = self.source
        if isinstance(source, Generator):
            try:
                value = next(source)
            except StopIteration as stop:
                self.final = stop.value
                raise StopAsyncIteration from None
        else:
            value = await anext(source)
        if isinstance(value, Outcome):
            self.final = value
            if isinstance(source, Generator):
                source.close()
            else:
                await source.aclose()
            raise StopAsyncIteration
        return value


@dataclass
class Success:
    """The data of a command that succeeded, with its suggestions."""

    data: Json
    """The data as JSON, `None` for no data."""
    cta: CtaBlock | None
    """Suggested next commands."""


#: Parses a command's args, options, and env as JSON data. Raises `incur.Error` on bad input.
Parse = Callable[[], tuple[dict[str, Json], dict[str, Json], dict[str, Json]]]

#: Consumes a handler's stream: writes chunks to a terminal, a response, or a protocol message.
Sink = Callable[[Stream], Awaitable[None]]


async def execute(
    command: Command,
    context: MiddlewareContext[Any, Any, Any],
    chain: list[Middleware],
    parse: Parse,
    sink: Sink,
    elicit: Elicit | None = None,
) -> Success | Error | None:
    """Runs the middleware chain around a command, as every transport does.

    Input parses inside the chain, after middleware has run. A stream goes to `sink` while
    middleware waits in `next()`, and the result is then `None`. The outermost error wins.
    """
    result: Success | Error | None = Success(None, None)

    async def last() -> None:
        nonlocal result
        try:
            args, options, env = parse()
        except Error as error:
            result = error
            return
        result = await _invoke(command, context, args, options, env, sink, elicit or Elicit())

    failure = await run_chain(chain, context, last)
    return result if failure is None else failure


async def _invoke(
    command: Command,
    c: MiddlewareContext[Any, Any, Any],
    args: dict[str, Json],
    options: dict[str, Json],
    env: dict[str, Json],
    sink: Sink,
    elicit: Elicit,
) -> Success | Error | None:
    """Runs a handler, awaiting coroutines and passing streams to `sink`."""
    handler = command.handler
    assert handler is not None
    cta: CtaBlock | None = None
    try:
        context = Context(
            agent=c.agent,
            args=build(command.args, args) if command.args else None,
            display_name=c.display_name,
            env=build(command.env, env) if command.env else None,
            format=c.format,
            format_explicit=c.format_explicit,
            globals=c.globals,
            name=c.name,
            options=build(command.options, options) if command.options else None,
            var=c.var,
            version=c.version,
            request=c.request,
            elicit=elicit,
        )
        result = handler(context)
        if inspect.isawaitable(result):
            result = await result
        if inspect.isgenerator(result) or inspect.isasyncgen(result):
            source = typing.cast(
                "Generator[object, None, object] | AsyncGenerator[object, None]", result
            )
            await sink(Stream(source))
            return None
        if isinstance(result, Outcome):
            cta = result.cta
            result = result.data
        return Success(to_json(result), cta)
    except Error as error:
        if error.cta is None and cta is not None:
            error.cta = cta
        return error
    except Exception as error:
        return unknown(str(error))


class _Done:
    """The finished awaitable a plain-function middleware's `next()` returns."""

    def __await__(self) -> Generator[None, None, None]:
        yield from ()


async def run_chain(
    chain: list[Middleware],
    context: MiddlewareContext[Any, Any, Any],
    last: Callable[[], Awaitable[None]],
) -> Error | None:
    """Runs a middleware chain around `last`. The outermost error wins."""
    if not chain:
        await last()
        return None
    first, rest = chain[0], chain[1:]
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    inner: Error | None = None

    async def run_rest() -> None:
        nonlocal inner
        inner = await run_chain(rest, context, last)

    def call_next() -> Awaitable[None]:
        if threading.get_ident() == loop_thread:
            return run_rest()
        # A plain function's `next()` blocks its worker thread until the chain has finished.
        asyncio.run_coroutine_threadsafe(run_rest(), loop).result()
        return _Done()

    try:
        if inspect.iscoroutinefunction(first):
            returned = first(context, call_next)
        else:
            returned = await _in_thread(lambda: first(context, call_next))
        if inspect.isawaitable(returned):
            await returned
    except Error as error:
        return error
    except Exception as error:
        return unknown(str(error))
    return inner


async def _in_thread(fn: Callable[[], object]) -> object:
    """Runs a blocking function in a new thread and returns its result.

    Each call gets its own thread: nested middleware blocks one thread per level, which could
    exhaust a fixed pool.
    """
    loop = asyncio.get_running_loop()
    done: asyncio.Future[object] = loop.create_future()
    context = contextvars.copy_context()

    def target() -> None:
        try:
            value = context.run(fn)
        except BaseException as error:
            loop.call_soon_threadsafe(done.set_exception, error)
        else:
            loop.call_soon_threadsafe(done.set_result, value)

    threading.Thread(target=target, daemon=True).start()
    return await done
