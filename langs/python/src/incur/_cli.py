"""CLI definition, command routing, and the `serve` loop."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import inspect
import io
import math
import os
import sys
import time
import typing
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import (
    TYPE_CHECKING,
    Any,
    Generic,
    Literal,
    NoReturn,
    Protocol,
    Self,
    TextIO,
    TypedDict,
    TypeVar,
    Unpack,
    overload,
)

from . import (
    _completions,
    _filter,
    _gateway,
    _js,
    _mcpsource,
    _parser,
    _pm,
    _serve_http,
    _skill,
    _syncmcp,
    _tokens,
)
from ._command import (
    Command,
    Context,
    Middleware,
    MiddlewareContext,
    Outcome,
    OutputPolicy,
    Stream,
    Success,
    execute,
    inputs,
    run_chain,
)
from ._derive import Command as Declared
from ._derive import Group as DeclaredGroup
from ._derive import attach, meta_of
from ._errors import (
    Error,
    FormattedCta,
    FormattedCtaBlock,
    format_cta,
    human_error,
    unknown,
)
from ._filter import MISSING, Missing
from ._formatter import FORMATS, Format, format_value
from ._help import Entry as HelpEntry
from ._help import Example, Usage, format_command, format_root, global_flags
from ._help import Options as HelpOptions
from ._http import FetchHandler, Request, RequestSource, Response, asgi, call
from ._js import Json
from ._mcp import HttpHandler, McpOptions, McpTool, serve_stdio
from ._mcp import Server as McpServer
from ._model import SchemaError, build, caller_locals, to_json, type_of
from ._openapi import OpenapiConfig, OpenapiSource
from ._openapi import commands as openapi_commands
from ._openapi import resolve as openapi_resolve
from ._schema import Field, Type, json_schema, object_type
from ._sync import Options as SyncOptions
from ._sync import Sync, has_installed_skills, list_skills, read_hash
from ._sync import sync as sync_skills
from ._tree import (
    Alias,
    BannerMode,
    Entry,
    Gateway,
    GatewayHit,
    Group,
    GroupHelp,
    NotFound,
    Resolution,
    Resolved,
    Spec,
    help_entries,
    once,
    resolve,
    suggest,
    target,
)
from ._update import Options as UpdateOptions
from ._update import Update
from ._update import check as check_update
from ._update import install as install_update
from ._update import refresh as refresh_update

_F = TypeVar("_F", bound=Callable[..., object])
_T = TypeVar("_T")
_C = TypeVar("_C", bound=Declared)

if TYPE_CHECKING:
    from typing_extensions import TypeVar as _DefaultTypeVar

    _T_co = _DefaultTypeVar("_T_co", covariant=True, default=Any)
else:
    _T_co = TypeVar("_T_co", covariant=True)


class Writer(Protocol):
    """A text stream, such as `sys.stdout` or `io.StringIO`."""

    def write(self, text: str, /) -> int:
        """Writes text."""
        ...


@dataclass
class Config:
    """Config-file option defaults.

    A config file is a JSON object: `{"commands": {"<name>": {"options": {...}}}}`, nested by
    command path, with root command options at the top level.
    """

    flag: str | None = None
    """Global flag that names a config file, such as `config` for `--config <path>`."""
    files: list[str] = field(default_factory=list[str])
    """Ordered search paths. The first existing file wins. Defaults to `<cli>.json`."""
    loader: Callable[[str | None], object | Awaitable[object]] | None = None
    """Custom loader, called with the resolved path or `None`. Returns an object or `None`.

    It may be an `async def` function."""


class CliOptions(TypedDict, total=False):
    """The keyword arguments of `Cli`, documented there."""

    description: str | None
    version: str | None
    aliases: Sequence[str]
    banner: Callable[[], str | Awaitable[str | None] | None] | None
    banner_mode: BannerMode
    config: Config | None
    env: type | None
    fetch: FetchHandler | None
    format: Format | None
    globals: type | None
    mcp: McpOptions | Literal[False] | None
    openapi: OpenapiSource | None
    openapi_config: OpenapiConfig | None
    output_policy: OutputPolicy | None
    package: str | None
    sync: Sync | bool
    update: Update | bool
    vars: type | Mapping[str, Any] | None


class Cli(Generic[_T_co]):
    """A CLI: a router of commands, optionally with its own root command.

    >>> import incur
    >>> cli = incur.Cli("my-cli", description="My CLI", update=False)
    >>> @cli.command("status", description="Show repo status")
    ... def status(c: incur.Context) -> dict[str, bool]:
    ...     return {"clean": True}
    >>> cli.serve_with(["status"], stdout=sys.stdout)
    clean: true
    0

    Handlers and middleware may be `async def` functions, and streaming handlers async
    generators. `serve()` runs the event loop; `await cli.serve_async()` and `await cli.run(...)`
    run inside one that is already running. `await cli.fetch(request)` and the ASGI application
    `cli.asgi` serve the same commands over HTTP.

    A CLI of a declared `incur.Command` or `incur.Group` class is typed by the value it parses:
    `Cli(Ops).parse()` returns a command of `Ops`, and `Cli(Ops).handle(fn)` runs it.
    """

    @overload
    def __init__(self: Cli[Any], name: str, **options: Unpack[CliOptions]) -> None: ...
    @overload
    def __init__(self: Cli[_C], name: type[_C], **options: Unpack[CliOptions]) -> None: ...
    @overload
    def __init__(
        self: Cli[_T], name: type[DeclaredGroup[_T]], **options: Unpack[CliOptions]
    ) -> None: ...
    def __init__(
        self,
        name: str | type,
        *,
        description: str | None = None,
        version: str | None = None,
        aliases: Sequence[str] = (),
        banner: Callable[[], str | Awaitable[str | None] | None] | None = None,
        banner_mode: BannerMode = "all",
        config: Config | None = None,
        env: type | None = None,
        fetch: FetchHandler | None = None,
        format: Format | None = None,
        globals: type | None = None,
        mcp: McpOptions | Literal[False] | None = None,
        openapi: OpenapiSource | None = None,
        openapi_config: OpenapiConfig | None = None,
        output_policy: OutputPolicy | None = None,
        package: str | None = None,
        sync: Sync | bool = True,
        update: Update | bool = True,
        vars: type | Mapping[str, Any] | None = None,
    ) -> None:
        """Creates a CLI.

        Args:
            name: The CLI name, shown in help and used as the default binary name. Or a declared
                `incur.Command` or `incur.Group` class, whose name, description, version, and
                aliases are the defaults, and whose group middleware runs around every command.
            description: What the CLI does.
            version: Version printed by `--version`.
            aliases: Alternative binary names. Completions register every name.
            banner: Renders text shown above root help. It may be an `async def` function.
            banner_mode: Who sees the banner.
            config: Enables config-file option defaults.
            env: A schema class of CLI-level environment variables, parsed before middleware.
                Middleware reads an instance as `c.env`.
            fetch: A fetch handler, or a hosted source from `incur.from_request`, that runs when
                no command matches: arguments become a curl-style HTTP request.
            format: The default output format.
            globals: A schema class of global options available to every command. Middleware and
                handlers read an instance as `c.globals`.
            mcp: MCP server and registration settings. `False` hides the CLI's commands from MCP
                clients when it is mounted as a group.
            openapi: An OpenAPI document, or its URL, that generates root commands calling
                `fetch`.
            openapi_config: How OpenAPI commands are generated.
            output_policy: The default output policy, inherited by every command.
            package: The npm package that runs the CLI, when it differs from the name.
            sync: Settings of the built-in `skills add` command, or `False` to disable skills.
            update: Settings of update checks and `--update`, or `False` to disable both.
            vars: Variables that middleware sets for handlers: a class whose fields all have
                defaults, such as an `@incur.schema` class, instantiated for every run as
                `c.var`; or a mapping of defaults, copied into a `dict`.

        Raises:
            SchemaError: When a global option collides with a built-in flag, or `name` is a class
                that is not declared.
        """
        declared = name if isinstance(name, type) else None
        middleware: list[Middleware] = []
        if isinstance(name, type):
            meta = meta_of(name)
            name = meta.name
            description = meta.description if description is None else description
            version = meta.version if version is None else version
            aliases = aliases or meta.aliases
            if meta.members is not None:
                middleware = meta.middleware
        self._declared = declared
        self.name = name
        """The CLI name."""
        spec = Spec(name)
        spec.middleware = list(middleware)
        self._spec = spec
        spec.description = description
        spec.version = version
        spec.aliases = list(aliases)
        spec.banner = banner
        spec.banner_mode = banner_mode
        spec.config = config
        spec.env = type_of(env, f"{name} env") if env is not None else None
        spec.format = format
        spec.update = None if update is False else Update() if update is True else update
        spec.globals = self._check_globals(type_of(globals, f"{name} globals")) if globals else None
        spec.output_policy = output_policy
        spec.sync = None if sync is False else Sync() if sync is True else sync
        spec.vars = vars if isinstance(vars, type) else dict(vars or {})
        spec.mcp = mcp or None
        spec.mcp_enabled = mcp is not False
        spec.package = package
        spec.root_fetch = fetch
        if fetch is not None and openapi is not None:
            spec.pending.append(self._openapi(fetch, openapi, openapi_config, None, spec.commands))
        self._mcp_http = HttpHandler(spec)

    def _check_globals(self, schema: Type) -> Type:
        """Rejects global options that collide with built-in flags."""
        builtins = [
            "fullOutput",
            "format",
            "json",
            "llms",
            "llmsFull",
            "mcp",
            "help",
            "incurBinaryApply",
            "incurUpdateCheck",
            *(["update"] if self._spec.update is not None else []),
            "version",
            "schema",
            "filterOutput",
            "tokenLimit",
            "tokenOffset",
            "tokenCount",
        ]
        flag = self._spec.config.flag if self._spec.config else None
        if flag:
            builtins += [flag, f"no{flag[0].upper()}{flag[1:]}"]
        for f in schema.fields:
            if f.name in builtins:
                raise SchemaError(
                    f"Global option '{f.name}' conflicts with a built-in flag. "
                    "Choose a different name."
                )
            if f.alias == "h":
                raise SchemaError(
                    f"Global alias '-h' for '{f.name}' conflicts with a built-in short flag. "
                    "Choose a different alias."
                )
        return schema

    def command(
        self,
        name: str,
        *,
        description: str | None = None,
        aliases: Sequence[str] = (),
        destructive: bool = False,
        examples: Sequence[Example] = (),
        format: Format | None = None,
        hint: str | None = None,
        mcp: McpTool | Literal[False] | None = None,
        middleware: Sequence[Middleware] = (),
        output: object = None,
        output_policy: OutputPolicy | None = None,
        usage: Sequence[Usage] = (),
    ) -> Callable[[_F], _F]:
        """Registers the decorated function as a command handler.

        The handler, a plain or `async def` function, takes one parameter annotated
        `incur.Context[Args, Options, Env, Vars, Globals]`, whose schema classes declare the
        command's input. It returns data or `incur.ok(...)`, or is a generator or async generator
        that streams chunks, and raises `incur.Error` to fail.

        Args:
            name: The command name.
            description: What the command does.
            aliases: Alternative names, such as `ext` for `extension`.
            destructive: Marks the command as destructive in generated agent skills.
            examples: Usage examples shown in help and manifests.
            format: The default output format.
            hint: Guidance shown after examples.
            mcp: How the command appears as an MCP tool, or `False` to hide it from MCP.
            middleware: Middleware that runs after CLI and group middleware.
            output: The output type: a schema class, `str`, `Any`, and so on.
            output_policy: Where the output may appear.
            usage: Alternative usage lines.
        """
        # Annotations may name classes local to the declaring function.
        scope = caller_locals()

        def register(fn: _F) -> _F:
            command = self._make_command(
                fn,
                scope,
                description=description,
                aliases=list(aliases),
                destructive=destructive,
                examples=list(examples),
                format=format,
                hint=hint,
                middleware=list(middleware),
                output=type_of(output, f"{name} output") if output is not None else None,
                output_policy=output_policy,
                usage=list(usage),
                mcp=mcp.meta() if mcp else None,
                mcp_enabled=mcp is not False,
            )
            for alias in command.aliases:
                self._spec.commands[alias] = Alias(command)
            self._spec.commands[name] = command
            return fn

        return register

    def gateway(
        self,
        name: str,
        fetch: FetchHandler,
        *,
        description: str | None = None,
        base_path: str | None = None,
        openapi: OpenapiSource | None = None,
        openapi_config: OpenapiConfig | None = None,
        output_policy: OutputPolicy | None = None,
        mcp: bool = True,
    ) -> Self:
        """Adds a command that forwards to a fetch handler. Returns this CLI.

        Arguments after the command become a curl-style HTTP request: path segments, `--key value`
        query parameters, `-X` for the method, `-H "Name: value"` headers, and `-d` for a body.
        With `openapi`, the command is instead a group of typed commands, one per operation.

        Args:
            name: The command name.
            fetch: An `async def` fetch handler, such as an ASGI-free in-process app, or a hosted
                source from `incur.from_request`.
            description: What the command does.
            base_path: A path prepended to every request path.
            openapi: An OpenAPI document, or its URL, relative to a hosted source's URL.
            openapi_config: How OpenAPI commands are generated.
            output_policy: Where the output may appear.
            mcp: Whether generated OpenAPI commands are MCP tools.
        """
        if openapi is None:
            self._spec.commands[name] = Gateway(fetch, description, base_path, output_policy)
            return self
        group = Group({}, description, output_policy=output_policy, mcp=mcp)
        load = self._openapi(fetch, openapi, openapi_config, base_path, group.commands)

        async def mount() -> None:
            await load()
            self._spec.commands[name] = group

        self._spec.pending.append(mount)
        return self

    def mcp_source(
        self,
        name: str,
        url: str,
        *,
        fetch: FetchHandler | None = None,
        headers: Mapping[str, str] | None = None,
        description: str | None = None,
        output_policy: OutputPolicy | None = None,
    ) -> Self:
        """Adds a group of commands that call the tools of a remote MCP server. Returns this CLI.

        The server is reached over streamable HTTP when the group is first used, and its tools
        become commands, whether it lists them directly or through progressive discovery.

        Args:
            name: The group name.
            url: The server's streamable-HTTP endpoint.
            fetch: Sends the MCP requests, such as another CLI's `fetch`. Defaults to the
                network.
            headers: Headers sent with every MCP request.
            description: What the group does.
            output_policy: Where the output may appear.
        """
        group = Group({}, description, output_policy=output_policy)
        self._spec.commands[name] = group

        async def load() -> None:
            source = _mcpsource.Source(url, fetch, dict(headers or {}))
            group.commands.update(await _mcpsource.commands(source))

        self._spec.lazy[name] = once(load)
        return self

    def _openapi(
        self,
        fetch: FetchHandler,
        source: OpenapiSource,
        config: OpenapiConfig | None,
        base_path: str | None,
        into: dict[str, Entry],
    ) -> Callable[[], Awaitable[None]]:
        async def load() -> None:
            base = fetch.url if isinstance(fetch, RequestSource) else None
            spec = await openapi_resolve(source, base)
            into.update(openapi_commands(spec, fetch, config, base_path))

        return load

    def root(
        self,
        *,
        description: str | None = None,
        examples: Sequence[Example] = (),
        format: Format | None = None,
        hint: str | None = None,
        output: object = None,
        usage: Sequence[Usage] = (),
    ) -> Callable[[_F], _F]:
        """Registers the decorated function as the root command, run when no subcommand matches.

        Takes the same handler and options as `command`. The description defaults to the CLI's.
        """
        scope = caller_locals()

        def register(fn: _F) -> _F:
            self._spec.root = self._make_command(
                fn,
                scope,
                description=description,
                examples=list(examples),
                format=format,
                hint=hint,
                output=type_of(output, f"{self.name} output") if output is not None else None,
                usage=list(usage),
            )
            return fn

        return register

    def group(self, cli: Cli[Any]) -> Self:
        """Mounts another CLI as a command group. Returns this CLI."""
        sub = cli._spec
        root = sub.root_command()
        entry: Entry
        if root is not None and not sub.commands:
            # A CLI without subcommands mounts as a command, keeping its aliases.
            entry = replace(root, aliases=list(sub.aliases))
            for alias in entry.aliases:
                self._spec.commands[alias] = Alias(entry)
        else:
            entry = Group(
                sub.commands,
                sub.description,
                sub.middleware,
                sub.output_policy,
                root,
                sub.mcp_enabled,
            )
            # Mounted CLIs resolve their deferred groups up front.
            if sub.pending or sub.lazy:
                self._spec.pending.append(sub.load)
        self._spec.commands[cli.name] = entry
        return self

    def _make_command(
        self, fn: Callable[..., object], scope: dict[str, Any], **settings: Any
    ) -> Command:
        spec = self._spec
        state = (
            spec.vars if isinstance(spec.vars, type) else None,
            spec.globals.py if spec.globals else None,
        )
        args, options, env = inputs(fn, scope, state)
        return Command(handler=fn, args=args, options=options, env=env, **settings)

    def use(self, middleware: Middleware) -> Middleware:
        """Adds middleware, which runs around every command in registration order.

        Usable as a decorator. Middleware takes the context and `next`, and calls `next()` to
        run the rest of the chain: `async def` middleware awaits it, and a plain function, which
        runs in a worker thread, calls it.
        """
        self._spec.middleware.append(middleware)
        return middleware

    async def fetch(self, request: Request) -> Response:
        """Serves an HTTP request: runs the command its path names, or speaks MCP at `/mcp`.

        `GET /users/list?limit=5` runs `users list` with options from the query; other methods
        read options from a JSON body. `/openapi.json` describes the commands as an OpenAPI
        document, and `/.well-known/agent-skills/index.json` lists their agent skills.
        """
        await self._spec.load()
        return await _serve_http.handle(self._spec, request, self._mcp_http)

    @property
    def asgi(self) -> Any:
        """The CLI as an ASGI 3 application, serving the same routes as `fetch`.

        Run it with any ASGI server, such as `uvicorn module:cli.asgi`.
        """
        return asgi(self.fetch)

    def serve(self) -> NoReturn:
        """Runs the CLI with the process arguments, environment, and streams, then exits.

        Runs the event loop with `asyncio.run`. Inside a running loop, await `serve_async`.
        """
        raise SystemExit(asyncio.run(self.serve_async()))

    async def serve_async(self) -> int:
        """Runs the CLI with the process arguments, environment, and streams.

        Returns the exit code.
        """
        display = os.path.basename(sys.argv[0]) if sys.argv else None
        code = await self._serve(
            sys.argv[1:],
            dict(os.environ),
            sys.stdout,
            sys.stderr,
            sys.stdin,
            sys.stdout.isatty(),
            display,
        )
        sys.stdout.flush()
        return code

    async def run(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        stdout: Writer | None = None,
        stderr: Writer | None = None,
        stdin: TextIO | None = None,
        tty: bool = False,
    ) -> int:
        """Runs the CLI with explicit arguments and I/O inside a running event loop.

        Returns the exit code. Takes the same arguments as `serve_with`.
        """
        return await self._serve(
            list(argv),
            dict(env or {}),
            stdout or _Null(),
            stderr or _Null(),
            stdin or io.StringIO(),
            tty,
            None,
        )

    def serve_with(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        stdout: Writer | None = None,
        stderr: Writer | None = None,
        stdin: TextIO | None = None,
        tty: bool = False,
    ) -> int:
        """Runs the CLI with explicit arguments and I/O. Returns the exit code.

        Runs the event loop with `asyncio.run`. Inside a running loop, await `run`.

        Args:
            argv: Arguments after the binary name.
            env: Environment variables. Defaults to none. Agent, skill, and update paths
                resolve from its `HOME` and `XDG_*` variables.
            stdout: Receives output. Defaults to discarding it.
            stderr: Receives warnings. Defaults to discarding them.
            stdin: Input of `--mcp`. Defaults to empty input.
            tty: Whether stdout is a terminal, which selects human output.
        """
        return asyncio.run(
            self.run(argv, env=env, stdout=stdout, stderr=stderr, stdin=stdin, tty=tty)
        )

    def _declared_class(self, method: str) -> type:
        if self._declared is None:
            raise SchemaError(
                f"{method}() needs a Cli of an incur.Command or incur.Group class, "
                f"such as incur.Cli(MyCommand)"
            )
        return self._declared

    def handle(
        self, handler: Callable[[_T_co, Context[None, None, None, Any, Any]], object]
    ) -> Self:
        """Runs the declared commands with `handler`. Returns this CLI.

        The handler takes the parsed command and the context, whose `args`, `options`, and `env`
        are `None`, as the command holds them. It returns data, as a command handler does: it may
        be an `async def` function, stream from a generator, or raise `incur.Error`.

        Raises:
            SchemaError: When the CLI was not created from a declared class.
        """
        root = attach(self._spec.commands, self._declared_class("handle"), handler)
        if root is not None:
            self._spec.root = root
        return self

    def parse(self) -> _T_co:
        """Parses the process arguments into the declared command, or exits.

        Middleware runs before it returns. Help, `--version`, `--llms`, completions, skills, and
        errors print and exit with their code, as `serve` does. `--mcp` and `mcp add`, which need
        a handler, are not commands. Runs the event loop with `asyncio.run`; inside a running
        loop, await `parse_async`.
        """
        return asyncio.run(self.parse_async())

    async def parse_async(self) -> _T_co:
        """Parses the process arguments inside a running event loop, as `parse` does."""
        display = os.path.basename(sys.argv[0]) if sys.argv else None
        parsed = await self._parse(
            sys.argv[1:],
            dict(os.environ),
            sys.stdout,
            sys.stderr,
            sys.stdin,
            sys.stdout.isatty(),
            display,
        )
        sys.stdout.flush()
        if isinstance(parsed, int):
            raise SystemExit(parsed)
        return parsed

    def parse_with(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        stdout: Writer | None = None,
        stderr: Writer | None = None,
        stdin: TextIO | None = None,
        tty: bool = False,
    ) -> _T_co | int:
        """Parses explicit arguments into the declared command, or returns the exit code.

        Takes the same arguments as `serve_with`. Returns the exit code when no command was
        parsed, such as for help, or when it failed, such as middleware raising after `next()`.
        Output after the command, such as the envelope of `--full-output`, is dropped.
        """
        return asyncio.run(
            self._parse(
                list(argv),
                dict(env or {}),
                stdout or _Null(),
                stderr or _Null(),
                stdin or io.StringIO(),
                tty,
                None,
            )
        )

    async def _parse(
        self,
        argv: list[str],
        env: dict[str, str],
        stdout: Writer,
        stderr: Writer,
        stdin: TextIO,
        tty: bool,
        bin_name: str | None,
    ) -> _T_co | int:
        declared = self._declared_class("parse")
        # Commands load into this CLI before the copy that parses shares them.
        await self._spec.load_pending()
        parsed: list[Any] = []
        spec = replace(self._spec, commands=dict(self._spec.commands), parse_only=True)
        root = attach(spec.commands, declared, lambda value, _: parsed.append(value))
        if root is not None:
            spec.root = root
        clone = copy.copy(self)
        clone._spec = spec
        gate = _Gate(stdout, parsed)
        code = await clone._serve(argv, env, gate, stderr, stdin, tty, bin_name)
        if parsed and code == 0:
            return parsed[0]
        gate.release()
        return code

    async def _serve(
        self,
        argv: list[str],
        env: dict[str, str],
        stdout: Writer,
        stderr: Writer,
        stdin: TextIO,
        tty: bool,
        bin_name: str | None,
    ) -> int:
        spec = self._spec
        await spec.load_pending()
        display = bin_name if bin_name in (self.name, *spec.aliases) else self.name
        run = _Run(spec, display or self.name, env, stdout, stderr, stdin, tty)
        await run.serve(argv)
        return run.exit


class _Null:
    """A writer that discards text."""

    def write(self, text: str, /) -> int:
        return len(text)


class _Gate:
    """Holds output written after a command was parsed.

    The output belongs to the caller, unless the run then fails.
    """

    def __init__(self, out: Writer, parsed: list[Any]) -> None:
        self.out = out
        self.parsed = parsed
        self.held: list[str] = []

    def write(self, text: str, /) -> int:
        if self.parsed:
            self.held.append(text)
            return len(text)
        return self.out.write(text)

    def release(self) -> None:
        """Writes the held output."""
        for text in self.held:
            self.out.write(text)


@dataclass
class _Flags:
    """Built-in flags extracted from argv."""

    config_disabled: bool = False
    config_path: str | None = None
    filter_output: list[list[_filter.Segment]] | None = None
    format: Format = "toon"
    format_explicit: bool = False
    full_output: bool = False
    help: bool = False
    llms: bool = False
    llms_full: bool = False
    mcp: bool = False
    rest: list[str] = field(default_factory=list[str])
    schema: bool = False
    token_count: bool = False
    token_limit: float | None = None
    token_offset: float | None = None
    update: bool = False
    update_check: bool = False
    version: bool = False


#: The hidden flag of detached update checks.
UPDATE_CHECK_FLAG = "--incur-update-check"


def _extract_flags(
    argv: list[str], config_flag: str | None, update: bool = True, mcp: bool = True
) -> _Flags:
    """Extracts built-in flags from argv."""
    flags = _Flags()
    i = 0
    while i < len(argv):
        token = argv[i]
        nxt = argv[i + 1] if i + 1 < len(argv) and argv[i + 1] else None
        if token == "--full-output":
            flags.full_output = True
        elif token == "--llms":
            flags.llms = True
        elif token == "--llms-full":
            flags.llms_full = True
        elif token == "--mcp" and mcp:
            flags.mcp = True
        elif token in ("--help", "-h"):
            flags.help = True
        elif token == "--update" and update:
            flags.update = True
        elif token == UPDATE_CHECK_FLAG:
            flags.update_check = True
        elif token == "--version" and (nxt is None or nxt.startswith("-")):
            # A following value belongs to a command-local `--version` option.
            flags.version = True
        elif token == "--schema":
            flags.schema = True
        elif token == "--json":
            flags.format = "json"
            flags.format_explicit = True
        elif token == "--format" and nxt is not None:
            if nxt not in FORMATS:
                raise unknown(
                    f'Invalid format: "{nxt}". Expected one of: toon, json, yaml, md, jsonl'
                )
            flags.format = nxt
            flags.format_explicit = True
            i += 1
        elif token == "--filter-output" and nxt is not None:
            flags.filter_output = _filter.parse(nxt)
            i += 1
        elif token in ("--token-limit", "--token-offset") and nxt is not None:
            value = _js.to_number(nxt)
            if not math.isfinite(value) or value < 0 or not _js.trim(nxt):
                raise unknown(f'Invalid value for {token}: "{nxt}"')
            if token == "--token-limit":
                flags.token_limit = value
            else:
                flags.token_offset = value
            i += 1
        elif token == "--token-count":
            flags.token_count = True
        elif config_flag is not None and token == f"--{config_flag}":
            if i + 1 >= len(argv):
                raise unknown(f"Missing value for flag: --{config_flag}")
            flags.config_path = argv[i + 1]
            flags.config_disabled = False
            i += 1
        elif config_flag is not None and token.startswith(f"--{config_flag}="):
            value = token[len(config_flag) + 3 :]
            if not value:
                raise unknown(f"Missing value for flag: --{config_flag}")
            flags.config_path = value
            flags.config_disabled = False
        elif config_flag is not None and token == f"--no-{config_flag}":
            flags.config_path = None
            flags.config_disabled = True
        else:
            flags.rest.append(token)
        i += 1
    return flags


def _manifest_entry(path: str, command: Command, full: bool) -> dict[str, Json]:
    out: dict[str, Json] = {"name": path}
    if command.description:
        out["description"] = command.description
    if not full:
        return out
    schema: dict[str, Json] = {}
    for key, ty in (
        ("args", command.args),
        ("env", command.env),
        ("options", command.options),
        ("output", command.output),
    ):
        if ty is not None:
            schema[key] = json_schema(ty)
    if schema:
        out["schema"] = schema
    if command.examples:
        examples: list[Json] = []
        for example in _skill.prefixed_examples(command.examples, path):
            item: dict[str, Json] = {"command": example.command}
            if example.description is not None:
                item["description"] = example.description
            examples.append(item)
        out["examples"] = examples
    return out


def _manifest_commands(
    commands: dict[str, Entry], prefix: list[str], full: bool
) -> list[dict[str, Json]]:
    out: list[dict[str, Json]] = []
    for name, entry in commands.items():
        path = [*prefix, name]
        joined = " ".join(path)
        if isinstance(entry, Command):
            out.append(_manifest_entry(joined, entry, full))
        elif isinstance(entry, Gateway):
            item: dict[str, Json] = {"name": joined}
            if entry.description:
                item["description"] = entry.description
            out.append(item)
        elif isinstance(entry, Group):
            if entry.root is not None:
                out.append(_manifest_entry(joined, entry.root, full))
            out += _manifest_commands(entry.commands, path, full)
    return out


#: Built-in subcommands: built-in name, subcommand name, description, aliases.
_BUILTIN_SUBCOMMANDS: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    ("mcp", "add", "Register as MCP server", ()),
    ("mcp", "doctor", "Validate MCP server startup and tool listing", ()),
    ("skills", "add", "Sync skill files to agents", ()),
    ("skills", "list", "List skills", ("ls",)),
)

#: Built-in command descriptions.
_BUILTINS = (
    ("completions", "Generate shell completion script"),
    ("mcp", "Register as MCP server"),
    ("skills", "Sync skill files to agents"),
)


def _find_builtin(token: str) -> str | None:
    """Resolves a token to a built-in command name."""
    return {"completions": "completions", "mcp": "mcp", "skills": "skills", "skill": "skills"}.get(
        token
    )


def _string_type(description: str) -> Type:
    return Type("string", optional=True, description=description)


@dataclass
class _Output:
    """Output settings resolved for a command."""

    flags: _Flags
    format: Format
    human: bool
    filter: list[list[_filter.Segment]] | None
    render: bool


class _Run:
    """The per-invocation serve state."""

    def __init__(
        self,
        cli: Spec,
        display_name: str,
        env: dict[str, str],
        stdout: Writer,
        stderr: Writer,
        stdin: TextIO,
        tty: bool,
    ) -> None:
        self.cli = cli
        self.display_name = display_name
        self.env_map = env
        self.stdout = stdout
        self.stderr = stderr
        self.stdin = stdin
        self.tty = tty
        self.root = cli.root_command()
        self.exit = 0
        self.start = time.monotonic()
        self.notice: FormattedCtaBlock | None = None

    def write(self, text: str) -> None:
        self.stdout.write(text)

    def writeln(self, text: str) -> None:
        self.write(text if text.endswith("\n") else text + "\n")

    def env(self, key: str) -> str | None:
        return self.env_map.get(key)

    def duration(self) -> str:
        return f"{int((time.monotonic() - self.start) * 1000)}ms"

    def config_flag(self) -> str | None:
        config = self.cli.config
        return config.flag if config else None

    def help_options(self, **overrides: Any) -> HelpOptions:
        base = HelpOptions(
            config_flag=self.config_flag(),
            globals=self.cli.globals,
            hide_mcp=self.cli.parse_only,
            hide_skills=not self.cli.sync,
            hide_update=self.cli.update is None,
        )
        return replace(base, **overrides)

    def early_error(self, error: Error, human: bool, fmt: Format) -> None:
        """Reports an error before a command resolves."""
        self.writeln(human_error(error) if human else format_value(error.to_json(), fmt))
        self.exit = 1

    async def banner(self, human: bool, show_help: bool) -> None:
        render = self.cli.banner
        if render is None or show_help:
            return
        mode = self.cli.banner_mode
        if mode == "all" or (mode == "human") == human:
            text = render()
            if inspect.isawaitable(text):
                text = await text
            if text:
                self.writeln(text)

    def root_help(self, globals_: bool = True) -> str:
        cli = self.cli
        return format_root(
            cli.name,
            self.help_options(
                aliases=cli.aliases,
                commands=help_entries(cli.commands),
                description=cli.description,
                globals=cli.globals if globals_ else None,
                root=True,
                version=cli.version,
            ),
        )

    def group_help(self, group: GroupHelp, **overrides: Any) -> str:
        return format_root(
            f"{self.cli.name} {group.path}",
            self.help_options(
                commands=help_entries(group.commands), description=group.description, **overrides
            ),
        )

    async def serve(self, argv: list[str]) -> None:
        cli = self.cli
        shell = self.env("COMPLETE")
        if shell is not None:
            await self.complete(shell, argv)
            return
        try:
            flags = _extract_flags(
                argv, self.config_flag(), cli.update is not None, not cli.parse_only
            )
        except Error as error:
            self.early_error(error, self.tty, "toon")
            return
        human = self.tty and not flags.format_explicit

        filtered = flags.rest
        globals_schema = cli.globals
        if globals_schema is not None:
            try:
                filtered = _parser.parse_globals(flags.rest, globals_schema, None, known=True)[1]
            except Error as error:
                self.early_error(error, human, flags.format)
                return

        # Deferred groups load only when this invocation can reach them.
        first = filtered[0] if filtered else None
        reaches_all = (
            flags.mcp
            or ((flags.llms or flags.llms_full) and first is None)
            or first == cli.name
            or (first is not None and self.find_builtin(first) is not None)
        )
        if reaches_all:
            await cli.load()
        elif first is not None:
            await cli.load(first)

        if flags.update_check:
            if cli.update is not None:
                with contextlib.suppress(Exception):
                    await refresh_update(cli.name, self.update_options(), self.env_map)
            return
        # --help takes precedence over --update.
        if flags.update and not flags.help:
            await self.install_update(human, flags)
            return

        if flags.mcp:
            await serve_stdio(cli, self.env_map, self.stdin, typing.cast("TextIO", self.stdout))
            return

        skills_cta = await self.skills_notice(flags, filtered)

        if flags.llms or flags.llms_full:
            self.llms(flags, filtered)
            return

        def builtin_index(builtin: str) -> int | None:
            if filtered and self.find_unshadowed_builtin(filtered[0]) == builtin:
                return 0
            if (
                len(filtered) > 1
                and filtered[0] == cli.name
                and self.find_unshadowed_builtin(filtered[1]) == builtin
            ):
                return 1
            return None

        index = builtin_index("completions")
        if index is not None:
            shell_name = filtered[index + 1] if index + 1 < len(filtered) else None
            if shell_name is None or flags.help:
                self.completions_help()
            elif shell_name in _completions.SHELLS:
                self.writeln(self.register_scripts(shell_name))
            else:
                error = Error(
                    "INVALID_SHELL",
                    f"Unknown shell '{shell_name}'. Supported: bash, fish, nushell, zsh",
                )
                self.writeln(human_error(error))
                self.exit = 1
            return

        for builtin in ("skills", "mcp"):
            index = builtin_index(builtin)
            if index is not None:
                await self.builtin(builtin, filtered, index, argv, flags, human)
                return

        version = cli.version
        if flags.version and not flags.help and version is not None:
            self.writeln(version)
            return

        root = self.root
        if not filtered:
            required = (
                root is not None
                and root.args is not None
                and any(not f.ty.is_optional() for f in root.args.fields)
            )
            if root is not None and human and required:
                await self.banner(human, flags.help)
                commands = help_entries(cli.commands)
                options = self.command_help(root, cli.aliases, version, commands, True)
                self.writeln(format_command(cli.name, options))
                return
            if root is None and cli.root_fetch is None:
                await self.banner(human, flags.help)
                self.writeln(self.root_help())
                return

        resolved: Resolution
        if root is not None and not filtered:
            resolved = Resolved(root, None, [], None, cli.name, [])
        elif cli.root_fetch is not None and not filtered:
            resolved = GatewayHit(Gateway(cli.root_fetch, cli.description), [], None, cli.name, [])
        else:
            resolved = resolve(cli.commands, filtered)

        if flags.help and isinstance(resolved, GatewayHit):
            if resolved.path == cli.name and cli.commands:
                self.writeln(self.root_help(globals_=False))
            else:
                name = cli.name if resolved.path == cli.name else f"{cli.name} {resolved.path}"
                self.writeln(_gateway.help_text(name, resolved.gateway.description))
            return
        if flags.help:
            self.help(resolved)
            return
        if flags.schema:
            self.schema(resolved, flags)
            return
        if isinstance(resolved, GroupHelp):
            self.writeln(self.group_help(resolved, hide_skills=False, hide_update=False))
            return

        update_cta: FormattedCtaBlock | None = None
        if human and cli.update is not None:
            available = check_update(cli.name, self.update_options(), self.env_map)
            if available is not None:
                update_cta = FormattedCtaBlock(
                    [
                        FormattedCta(
                            f"{self.display_name} --update",
                            f"upgrade from {available.current} to {available.latest}",
                        )
                    ],
                    f"Update available for {available.name}:",
                )
        notices = [block for block in (skills_cta, update_cta) if block is not None]
        if notices:
            self.notice = FormattedCtaBlock(
                [c for block in notices for c in block.commands], notices[0].description
            )

        command_format = resolved.command.format if isinstance(resolved, Resolved) else None
        fmt = flags.format if flags.format_explicit else command_format or cli.format or "toon"

        # A token that is not a typo of a known command falls back to the root fetch or command.
        # A token starting with `/` is a request path, never a mistyped command.
        if (
            isinstance(resolved, NotFound)
            and not resolved.path
            and (root is not None or cli.root_fetch is not None)
        ):
            candidates = [*resolved.commands, *self.builtin_names()]
            if resolved.error.startswith("/") or suggest(resolved.error, candidates) is None:
                if cli.root_fetch is not None:
                    gateway = Gateway(cli.root_fetch, cli.description)
                    resolved = GatewayHit(gateway, [], None, cli.name, list(filtered))
                else:
                    assert root is not None
                    resolved = Resolved(root, None, [], None, cli.name, list(filtered))

        if isinstance(resolved, (Resolved, GatewayHit)):
            policy = resolved.output_policy or cli.output_policy
        else:
            policy = cli.output_policy
        output = _Output(
            flags=flags,
            format=fmt,
            human=human,
            filter=flags.filter_output,
            render=not (human and policy == "agent-only"),
        )

        if isinstance(resolved, NotFound):
            self.not_found(resolved.error, resolved.path, resolved.commands, argv, output)
        elif isinstance(resolved, GatewayHit):
            await self.forward(resolved, filtered, output)
        else:
            await self.execute(resolved, filtered, output)

    def update_options(self) -> UpdateOptions:
        """The update settings of this run."""
        update = self.cli.update
        assert update is not None
        return UpdateOptions(update, self.cli.version)

    async def install_update(self, human: bool, flags: _Flags) -> None:
        """Handles `--update`, which is only a flag when updates are enabled."""
        cli = self.cli
        try:
            result = await install_update(cli.name, self.update_options(), self.env_map)
        except Exception as error:
            failure = Error("UPDATE_FAILED", str(error))
            if human:
                self.writeln(human_error(failure))
            else:
                self.writeln(format_value(failure.to_json(), flags.format))
            self.exit = 1
            return
        if human:
            deferred = result.get("deferred") is True
            lines = [
                f"\u2713 Update staged for {result['name']}"
                if deferred
                else f"\u2713 Updated {result['name']}"
            ]
            if "command" in result:
                lines.append(f"  {result['command']}")
            if deferred:
                lines.append("  Installation will finish after this process exits.")
            self.writeln("\n".join(lines))
        else:
            self.writeln(format_value(result, flags.format))

    async def skills_notice(self, flags: _Flags, filtered: list[str]) -> FormattedCtaBlock | None:
        """Suggests `skills add` when installed skills are out of date."""
        cli = self.cli
        if (
            cli.sync is None
            or flags.llms
            or flags.llms_full
            or flags.schema
            or flags.help
            or flags.update
            or flags.update_check
            or flags.version
        ):
            return None
        for index in (0, 1):
            if index == 1 and (not filtered or filtered[0] != cli.name):
                break
            if len(filtered) > index and self.find_unshadowed_builtin(filtered[index]) in (
                "skills",
                "mcp",
            ):
                return None
        env = self.env_map
        stored = read_hash(cli.name, env)
        if stored is None or not has_installed_skills(cli.name, env, cli.sync.cwd):
            return None
        # The stored hash covers every command, deferred groups included.
        await cli.load()
        infos, _ = self.skill_infos()
        if _skill.hash_commands(infos) == stored:
            return None
        runner = (env.get("npm_config_user_agent") or env.get("npm_execpath")) and (
            cli.package is not None or _syncmcp.is_package_name(cli.name)
        )
        if runner:
            specifier = _syncmcp.package_specifier(cli.name, cli.package, cli.version)
            command = f"{_pm.runner(env)} {specifier} skills add"
        else:
            command = f"{self.display_name} skills add"
        return FormattedCtaBlock(
            [FormattedCta(command, "sync outdated skills")], "Skills are out of date:"
        )

    def builtin_names(self) -> list[str]:
        """Names of enabled built-in commands."""
        return [n for n, _ in _BUILTINS if self.find_builtin(n) is not None]

    def find_builtin(self, token: str) -> str | None:
        """Resolves a token to an enabled built-in command name."""
        found = _find_builtin(token)
        hidden = (found == "skills" and not self.cli.sync) or (
            found == "mcp" and self.cli.parse_only
        )
        return None if hidden else found

    def find_unshadowed_builtin(self, token: str) -> str | None:
        """Resolves a token to an enabled built-in unless a command or alias shadows it."""
        return None if token in self.cli.commands else self.find_builtin(token)

    def register_scripts(self, shell: str) -> str:
        names = [self.cli.name, *self.cli.aliases]
        return "\n".join(_completions.register(shell, name) for name in names)

    def command_help(
        self,
        command: Command,
        aliases: list[str],
        version: str | None,
        commands: list[HelpEntry] | None,
        root: bool,
    ) -> HelpOptions:
        return self.help_options(
            aliases=aliases,
            args=command.args,
            commands=commands or None,
            description=command.description,
            env=command.env,
            env_source=self.env,
            examples=command.examples or None,
            hint=command.hint,
            options=command.options,
            root=root,
            usage=command.usage,
            version=version,
        )

    def help(self, resolved: Resolution) -> None:
        cli = self.cli
        assert not isinstance(resolved, GatewayHit)
        if isinstance(resolved, GroupHelp):
            text = self.group_help(resolved)
        elif isinstance(resolved, NotFound):
            entries = help_entries(cli.commands)
            if self.root is not None and entries:
                options = self.command_help(
                    self.root,
                    cli.aliases,
                    cli.version,
                    entries,
                    True,
                )
                text = format_command(cli.name, options)
            else:
                text = self.root_help()
        else:
            command = resolved.command
            is_root = resolved.path == cli.name
            name = cli.name if is_root else f"{cli.name} {resolved.path}"
            if resolved.commands:
                entries = help_entries(resolved.commands)
            elif is_root:
                entries = help_entries(cli.commands)
            else:
                entries = []
            aliases = cli.aliases if is_root else command.aliases
            version = cli.version if is_root else None
            text = format_command(
                name, self.command_help(command, aliases, version, entries, is_root)
            )
        self.writeln(text)

    def schema(self, resolved: Resolution, flags: _Flags) -> None:
        cli = self.cli
        if isinstance(resolved, GroupHelp):
            self.writeln(self.group_help(resolved, hide_skills=False))
        elif isinstance(resolved, GatewayHit):
            self.writeln("--schema is not supported for fetch commands.")
            self.exit = 1
        elif isinstance(resolved, NotFound):
            parent = f"{cli.name} {resolved.path}" if resolved.path else cli.name
            suggestion = suggest(resolved.error, resolved.commands)
            did_you_mean = f" Did you mean '{suggestion}'?" if suggestion else ""
            self.writeln(
                f"Error: '{resolved.error}' is not a command for '{parent}'.{did_you_mean}"
            )
            self.exit = 1
        else:
            command = resolved.command
            fmt: Format = flags.format if flags.format_explicit else "toon"
            out: dict[str, Json] = {}
            for key, ty in (
                ("args", command.args),
                ("env", command.env),
                ("options", command.options),
                ("output", command.output),
                ("globals", cli.globals),
            ):
                if ty is not None:
                    out[key] = json_schema(ty)
            self.writeln(format_value(out, fmt))

    def llms(self, flags: _Flags, filtered: list[str]) -> None:
        cli = self.cli
        commands: dict[str, Entry] = cli.commands
        prefix: list[str] = []
        description = cli.description
        root = self.root
        for token in filtered:
            entry = commands.get(token)
            if entry is None:
                break
            if isinstance(entry, Group):
                commands = entry.commands
                description = entry.description
                root = entry.root
                prefix.append(token)
            else:
                commands = {token: target(entry) or entry}
                root = None
                break
        if not prefix:
            root = self.root
        scoped = " ".join([cli.name, *prefix])
        if not flags.format_explicit or flags.format == "md":
            groups: dict[str, str] = {}
            infos = _skill.collect(commands, [], groups, root)
            if flags.llms_full:
                text = _skill.generate(scoped, infos, groups)
            else:
                text = _skill.index(scoped, infos, description)
            self.writeln(text)
            return
        full = flags.llms_full
        entries = _manifest_commands(commands, prefix, full)
        if root is not None and prefix:
            entries.append(_manifest_entry(" ".join(prefix), root, full))
        entries.sort(key=lambda e: _js.locale_key(str(e["name"])))
        manifest: dict[str, Json] = {"version": "incur.v1", "commands": [*entries]}
        if cli.globals is not None:
            manifest["globals"] = json_schema(cli.globals)
        self.writeln(format_value(manifest, flags.format))

    def completions_help(self) -> None:
        name = self.cli.name
        rows = [
            ("bash", f'eval "$({name} completions bash)"', "# add to ~/.bashrc"),
            ("fish", f"{name} completions fish | source", "# add to ~/.config/fish/config.fish"),
            ("nushell", f"see `{name} completions nushell`", "# add to config.nu"),
            ("zsh", f'eval "$({name} completions zsh)"', "# add to ~/.zshrc"),
        ]
        width = max(_js.utf16_len(r[1]) for r in rows)
        hint = "\n".join(
            [
                "Setup:",
                *(
                    f"  {shell:<7}  {command}{' ' * (width - _js.utf16_len(command))}  {comment}"
                    for shell, command, comment in rows
                ),
            ]
        )
        args = object_type(
            [
                Field(
                    "shell",
                    Type(
                        "enum",
                        values=list(_completions.SHELLS),
                        description="Shell to generate completions for",
                    ),
                )
            ]
        )
        text = format_command(
            f"{name} completions",
            HelpOptions(
                args=args,
                description="Generate shell completion script",
                hide_global_options=True,
                hint=hint,
            ),
        )
        self.writeln(text)

    async def builtin(
        self,
        builtin: str,
        filtered: list[str],
        index: int,
        argv: list[str],
        flags: _Flags,
        human: bool,
    ) -> None:
        """Handles `skills` and `mcp`."""
        name = self.cli.name
        subs = [s for s in _BUILTIN_SUBCOMMANDS if s[0] == builtin]
        if index + 1 >= len(filtered):
            entries = [HelpEntry(s[1], s[2]) for s in subs]
            description = next(d for n, d in _BUILTINS if n == builtin)
            text = format_root(
                f"{name} {builtin}",
                HelpOptions(
                    aliases=["skill"] if builtin == "skills" else [],
                    commands=entries,
                    description=description,
                ),
            )
            self.writeln(text)
            return
        sub = filtered[index + 1]
        found = next((s for s in subs if s[1] == sub or sub in s[3]), None)
        if found is None:
            candidates = [value for s in subs for value in (s[1], *s[3])]
            suggestion = suggest(sub, candidates)
            did_you_mean = f" Did you mean '{suggestion}'?" if suggestion else ""
            message = f"'{sub}' is not a command for '{name} {builtin}'.{did_you_mean}"
            commands: list[FormattedCta] = []
            if suggestion is not None:
                corrected = " ".join(suggestion if t == sub else t for t in argv)
                commands.append(FormattedCta(f"{name} {corrected}"))
            commands.append(FormattedCta(f"{name} {builtin} --help", "see all available commands"))
            cta = FormattedCtaBlock.of(commands)
            error = Error("COMMAND_NOT_FOUND", message)
            if human:
                self.writeln(human_error(error))
                self.writeln(cta.human())
            else:
                value: dict[str, Json] = {
                    "code": error.code,
                    "message": error.message,
                    "cta": cta.to_json(),
                }
                self.writeln(format_value(value, "toon"))
            self.exit = 1
            return
        if flags.help:
            options: Type | None = None
            if found[:2] == ("mcp", "add"):
                options = object_type(
                    [
                        Field(
                            "agent",
                            _string_type("Target a specific agent (e.g. claude-code, cursor)"),
                        ),
                        Field(
                            "command",
                            _string_type(
                                'Override the command agents will run (e.g. "pnpm my-cli --mcp")'
                            ),
                            alias="c",
                        ),
                        Field(
                            "noGlobal",
                            Type(
                                "boolean",
                                optional=True,
                                description="Install to project instead of globally",
                            ),
                        ),
                    ]
                )
            elif found[:2] == ("skills", "add"):
                options = object_type(
                    [
                        Field(
                            "depth",
                            Type(
                                "number",
                                optional=True,
                                description="Grouping depth for skill files (default: 1)",
                            ),
                        ),
                        Field(
                            "noGlobal",
                            Type(
                                "boolean",
                                optional=True,
                                description="Install to project instead of globally",
                            ),
                        ),
                    ]
                )
            text = format_command(
                f"{name} {builtin} {found[1]}",
                HelpOptions(
                    aliases=list(found[3]),
                    description=found[2],
                    hide_global_options=True,
                    options=options,
                ),
            )
            self.writeln(text)
            return
        rest = filtered[index + 2 :]
        fmt: Format = flags.format if flags.format_explicit else "toon"
        if found[:2] == ("skills", "list"):
            await self.skills_list(fmt)
        elif found[:2] == ("skills", "add"):
            await self.skills_add(rest, flags, fmt)
        elif found[:2] == ("mcp", "doctor"):
            report = await self.mcp_doctor()
            self.writeln(format_value(report, fmt))
            if report["ok"] is not True:
                self.exit = 1
        else:
            await self.mcp_add(rest, flags, fmt, human)

    def sync_options(self) -> SyncOptions:
        cli = self.cli
        sync = cli.sync
        assert sync is not None
        return SyncOptions(
            env=self.env_map,
            cwd=sync.cwd,
            depth=sync.depth,
            description=cli.description,
            include=list(sync.include),
        )

    def skill_infos(self) -> tuple[list[_skill.CommandInfo], dict[str, str]]:
        """The commands that skill files describe, and group descriptions."""
        cli = self.cli
        groups: dict[str, str] = {cli.name: cli.description} if cli.description else {}
        return _skill.collect(cli.commands, [], groups, self.root), groups

    async def skills_list(self, fmt: Format) -> None:
        """Handles `skills list`."""
        cli = self.cli
        try:
            infos, groups = self.skill_infos()
            skills = await list_skills(cli.name, infos, groups, self.sync_options())
        except Exception as error:
            failure: dict[str, Json] = {"code": "LIST_SKILLS_FAILED", "message": str(error)}
            self.writeln(format_value(failure, fmt))
            self.exit = 1
            return
        if not skills:
            self.writeln("No skills found.")
            return
        width = max(_js.utf16_len(s.name) for s in skills)
        lines: list[str] = []
        for s in skills:
            icon = "\u2713" if s.installed else "\u2717"
            pad = " " * (width - _js.utf16_len(s.name))
            lines.append(
                f"  {icon} {s.name}" + (f"{pad}  {s.description}" if s.description else "")
            )
        installed = sum(1 for s in skills if s.installed)
        plural = "" if len(skills) == 1 else "s"
        lines += ["", f"{len(skills)} skill{plural} ({installed} installed)"]
        self.writeln("\n".join(lines))

    async def skills_add(self, rest: list[str], flags: _Flags, fmt: Format) -> None:
        """Handles `skills add`."""
        cli = self.cli
        sync = cli.sync
        assert sync is not None
        options = self.sync_options()
        if "--depth" in rest:
            at = rest.index("--depth") + 1
            options.depth = _js.to_number(rest[at]) if at < len(rest) else math.nan
        else:
            eq = next((t for t in rest if t.startswith("--depth=")), None)
            if eq is not None:
                options.depth = _js.to_number(eq.split("=")[1])
        options.global_ = False if "--no-global" in rest else None
        self.write("Syncing...")
        try:
            infos, groups = self.skill_infos()
            result = await sync_skills(cli.name, infos, groups, options)
        except Exception as error:
            failure: dict[str, Json] = {"code": "SYNC_SKILLS_FAILED", "message": str(error)}
            self.writeln(format_value(failure, fmt))
            self.exit = 1
            return
        self.write("\r\x1b[K")
        width = max((_js.utf16_len(s.name) for s in result.skills), default=0)
        lines: list[str] = []
        for s in result.skills:
            pad = " " * (width - _js.utf16_len(s.name))
            lines.append(
                f"  \u2713 {s.name}" + (f"{pad}  {s.description}" if s.description else "")
            )
        plural = "" if len(result.skills) == 1 else "s"
        lines += ["", f"{len(result.skills)} skill{plural} synced"]
        if sync.body:
            lines += ["", sync.body]
        if sync.suggestions:
            lines += ["", f"Your agent can now use {cli.name}. Try asking:"]
            lines += [f'  "{s}"' for s in sync.suggestions]
        lines += ["", f"Run `{cli.name} --help` to see the full command reference."]
        self.writeln("\n".join(lines))
        if flags.full_output or flags.format_explicit:
            out: dict[str, Json] = {"skills": list(result.paths)}
            if sync.body:
                out["body"] = sync.body
            if flags.full_output and result.agents:
                out["agents"] = list(result.agents)
            self.writeln(format_value(out, fmt))

    async def mcp_doctor(self) -> dict[str, Json]:
        """Handles `mcp doctor`: lists the tools a direct MCP server exposes."""
        report: dict[str, Json] = {"ok": False, "toolCount": 0, "tools": [], "warnings": []}
        try:
            server = McpServer(self.cli, self.env_map, direct=True)
        except Exception as error:
            report["errors"] = [{"code": "MCP_SERVER_FAILED", "message": str(error)}]
            return report
        listed = _js.as_list(server.list_tools()["tools"])
        tools: list[Json] = []
        for tool in listed:
            item = _js.as_object(tool)
            entry: dict[str, Json] = {"name": item["name"]}
            if "description" in item:
                entry["description"] = item["description"]
            tools.append(entry)
        report.update(ok=True, toolCount=len(tools), tools=tools, errors=[])
        if not tools:
            report["warnings"] = ["No MCP tools exposed."]
        return report

    async def mcp_add(self, rest: list[str], flags: _Flags, fmt: Format, human: bool) -> None:
        """Handles `mcp add`."""
        cli = self.cli
        options = cli.mcp or McpOptions()
        command = options.command
        agents = list(options.agents)
        i = 0
        while i < len(rest):
            # `--command` / `-c` and `--agent`, spaced or with `=`. A blank or option-shaped
            # value is missing, so it cannot swallow the next flag.
            flag, eq, value = rest[i].partition("=")
            if flag in ("--command", "-c", "--agent"):
                if not eq:
                    i += 1
                    value = rest[i] if i < len(rest) else ""
                if not _js.trim(value) or (value.startswith("-") and len(value) > 1):
                    self.early_error(unknown(f"Missing value for flag: {flag}"), human, fmt)
                    return
                if flag == "--agent":
                    agents.append(value)
                else:
                    command = value
            i += 1
        name = options.name or cli.name
        self.write("Registering MCP server...")
        try:
            result = await _syncmcp.register(
                name,
                _syncmcp.Options(
                    env=self.env_map,
                    cli=None if name == cli.name else cli.name,
                    command=command,
                    global_="--no-global" not in rest,
                    agents=agents,
                    package=cli.package,
                    version=cli.version if cli.package is not None else None,
                ),
            )
        except Exception as error:
            failure: dict[str, Json] = {"code": "MCP_ADD_FAILED", "message": str(error)}
            self.writeln(format_value(failure, fmt))
            self.exit = 1
            return
        self.write("\r\x1b[K")
        lines = [f"\u2713 Registered {name} as MCP server"]
        if result.agents:
            lines.append(f"  Agents: {', '.join(result.agents)}")
        lines += ["", f"Agents can now use {name} tools."]
        suggestions = cli.sync.suggestions if cli.sync else []
        if suggestions:
            lines += ["", "Try asking:", *(f'  "{s}"' for s in suggestions)]
        self.writeln("\n".join(lines))
        if flags.full_output or flags.format_explicit:
            out: dict[str, Json] = {
                "name": name,
                "command": result.command,
                "agents": list(result.agents),
            }
            self.writeln(format_value(out, fmt))

    async def complete(self, shell: str, argv: list[str]) -> None:
        """Answers a shell completion request."""
        cli = self.cli
        if shell not in _completions.SHELLS:
            return
        words = argv[argv.index("--") + 1 :] if "--" in argv else argv
        if not words:
            self.write(self.register_scripts(shell))
            return
        # The index is a JavaScript number: shells may send anything, and `slice` and element
        # reads interpret it as JavaScript does.
        raw_index = self.env("_COMPLETE_INDEX")
        index = float(len(words) - 1) if raw_index is None else _js.to_number(raw_index)
        cut = _js.relative_index(index, len(words))
        before: list[str] | None
        try:
            before = _extract_flags(words[:cut], self.config_flag()).rest
            if _js.element(words, index - 1) == "--version":
                before.append("--version")
            globals_schema = cli.globals
            if globals_schema is not None:
                before = _parser.parse_globals(before, globals_schema)[1]
        except Error:
            before = None
        # Groups named before the cursor load so their commands complete.
        for word in before if before is not None else words[:cut]:
            await cli.load(word)
        if before is not None:
            words_in = [*before, *words[cut:]]
            at = len(before)
        else:
            words_in = list(words)
            at = cut
        tree = _tree(cli.commands, self.root, None)
        candidates = _completions.complete(tree, words_in, at, cli.globals)
        current = _js.element(words, index) or ""
        non_flags = [w for w in before if not w.startswith("-")] if before is not None else None
        if non_flags is not None and len(non_flags) <= 1:
            for name, description in _BUILTINS:
                if name not in self.builtin_names():
                    continue
                if name.startswith(current) and not any(c.value == name for c in candidates):
                    candidates.append(
                        _completions.Candidate(name, description, name != "completions")
                    )
        elif non_flags is not None and len(non_flags) == 2:
            builtin = self.find_unshadowed_builtin(non_flags[1])
            # A built-in group completes its own subcommands in place of root commands
            if builtin is not None and builtin != "completions" and not current.startswith("-"):
                candidates.clear()
                for sub in _BUILTIN_SUBCOMMANDS:
                    if sub[0] != builtin:
                        continue
                    for value in (sub[1], *sub[3]):
                        if value.startswith(current):
                            candidates.append(_completions.Candidate(value, sub[2]))
        # Add the built-in global flags that help lists for the active command
        if non_flags is not None and current.startswith("-"):
            for flag, description in global_flags(self.help_options(root=len(non_flags) <= 1)):
                for value in (f.split(" ")[0] for f in flag.split(", ")):
                    if value.startswith(current) and not any(c.value == value for c in candidates):
                        candidates.append(_completions.Candidate(value, description))
        out = _completions.format_candidates(shell, candidates)
        if out:
            self.write(out)

    def not_found(
        self,
        error: str,
        path: str,
        commands: dict[str, Entry],
        argv: list[str],
        output: _Output,
    ) -> None:
        cli = self.cli
        parent = f"{cli.name} {path}" if path else cli.name
        candidates = list(commands)
        if not path:
            candidates += self.builtin_names()
        suggestion = suggest(error, candidates)
        did_you_mean = f" Did you mean '{suggestion}'?" if suggestion else ""
        message = f"'{error}' is not a command for '{parent}'.{did_you_mean}"
        ctas: list[FormattedCta] = []
        if suggestion is not None:
            corrected = " ".join(suggestion if t == error else t for t in argv)
            ctas.append(FormattedCta(f"{cli.name} {corrected}"))
        ctas.append(FormattedCta(f"{parent} --help", "see all available commands"))
        cta = FormattedCtaBlock.of(ctas)
        failure = Error("COMMAND_NOT_FOUND", message)
        if output.human and not output.flags.full_output:
            self.writeln(human_error(failure))
            self.writeln(self.with_notice(cta).human())
        else:
            self.write_output(output, False, failure.to_json(), error, cta)
        self.exit = 1

    @typing.overload
    def with_notice(self, cta: FormattedCtaBlock) -> FormattedCtaBlock: ...

    @typing.overload
    def with_notice(self, cta: FormattedCtaBlock | None) -> FormattedCtaBlock | None: ...

    def with_notice(self, cta: FormattedCtaBlock | None) -> FormattedCtaBlock | None:
        """Appends framework notices, such as an available update, to suggestions."""
        notice = self.notice
        if notice is None:
            return cta
        if cta is None:
            return notice
        return FormattedCtaBlock([*cta.commands, *notice.commands], cta.description)

    @staticmethod
    def truncate(flags: _Flags, text: str) -> tuple[str, bool, float | None]:
        """Truncates text to the requested token window."""
        if flags.token_limit is None and flags.token_offset is None:
            return text, False, None
        total = float(_tokens.estimate(text))
        offset = flags.token_offset or 0.0
        end = total if flags.token_limit is None else offset + flags.token_limit
        if offset == 0 and end >= total:
            return text, False, None
        sliced = _tokens.slice_tokens(text, offset, end)
        start = min(offset, total)
        actual_end = min(end, total)
        nxt = actual_end if actual_end < total else None
        note = (
            f"[truncated: showing tokens {_js.number_to_string(start)}\u2013"
            f"{_js.number_to_string(actual_end)} of {_js.number_to_string(total)}]"
        )
        return f"{sliced}\n{note}", True, nxt

    def write_output(
        self,
        output: _Output,
        ok: bool,
        body: _filter.Filtered,
        command: str,
        cta: FormattedCtaBlock | None,
    ) -> None:
        """Writes a command result. `body` is `MISSING` for no data."""
        flags = output.flags
        fmt = output.format
        cta = self.with_notice(cta)
        if output.filter is not None and ok and not isinstance(body, Missing):
            body = _filter.apply(body, output.filter)
        text = "" if isinstance(body, Missing) else format_value(body, fmt)
        if flags.token_count:
            self.writeln(str(_tokens.estimate(text)))
            return
        if output.human and not flags.full_output:
            if ok:
                if not isinstance(body, Missing) and body is not None and output.render:
                    self.writeln(self.truncate(flags, text)[0])
            else:
                assert isinstance(body, dict)
                hint = body.get("hint")
                error = Error(
                    str(body["code"]),
                    str(body["message"]),
                    hint=hint if isinstance(hint, str) else None,
                )
                self.writeln(human_error(error))
            if cta is not None:
                self.writeln(cta.human())
            return
        meta: dict[str, Json] = {"command": command, "duration": self.duration()}
        if cta is not None:
            meta["cta"] = cta.to_json()
        key = "data" if ok else "error"
        envelope: dict[str, Json] = {"ok": ok}
        if flags.full_output:
            truncated, done, nxt = self.truncate(flags, text)
            if done:
                if nxt is not None:
                    meta["nextOffset"] = nxt
                envelope[key] = truncated
            elif not isinstance(body, Missing):
                envelope[key] = body
            envelope["meta"] = meta
            self.writeln(format_value(envelope, fmt))
            return
        if cta is None:
            if text:
                self.writeln(self.truncate(flags, text)[0])
            return
        if isinstance(body, dict):
            payload: dict[str, Json] = {**body, "cta": cta.to_json()}
        else:
            payload = {} if isinstance(body, Missing) else {"data": body}
            payload["cta"] = cta.to_json()
        self.writeln(self.truncate(flags, format_value(payload, fmt))[0])

    def write_failure(self, output: _Output, error: Error, command: str) -> None:
        cta = format_cta(self.display_name, error.cta)
        self.write_output(output, False, error.to_json(), command, cta)
        self.exit = error.exit_code if error.exit_code is not None else 1

    def deprecations(self, argv: list[str], options: Type | None) -> None:
        """Writes warnings for deprecated flags."""
        if options is None:
            return
        deprecated = [(_js.to_kebab(f.name), f.alias) for f in options.fields if f.ty.deprecated]
        known = {kebab for kebab, _ in deprecated}
        for token in argv:
            if token.startswith("--"):
                stripped = token[2:].split("=")[0]
                raw = stripped
                if stripped.startswith("no-") and stripped not in known:
                    raw = stripped[3:]
                if raw in known:
                    self.stderr.write(f"Warning: --{raw} is deprecated\n")
            elif len(token) >= 2 and token.startswith("-"):
                for ch in token[1:]:
                    kebab = next((k for k, alias in deprecated if alias == ch), None)
                    if kebab is not None:
                        self.stderr.write(f"Warning: --{kebab} is deprecated\n")

    async def config_defaults(self, path: str, flags: _Flags) -> dict[str, Json] | None:
        """Loads config-file defaults for a command path."""
        cli = self.cli
        config = cli.config
        if config is None or flags.config_disabled:
            return None

        def resolve_path(p: str) -> str:
            if p == "~" or p.startswith("~/"):
                rest = p[1:].lstrip("/")
                home = self.env("HOME") or ""
                return os.path.join(home, rest) if rest else home
            return os.path.join(os.getcwd(), p)

        target: str | None
        if flags.config_path is not None:
            target = resolve_path(flags.config_path)
        else:
            files = config.files or [f"{cli.name}.json"]
            target = next((p for p in map(resolve_path, files) if _exists(p)), None)

        parsed: object
        if config.loader is not None:
            try:
                parsed = config.loader(target)
                if inspect.isawaitable(parsed):
                    parsed = await parsed
            except Error:
                raise
            except Exception as error:
                raise unknown(str(error)) from error
            if parsed is None:
                return None
            if not isinstance(parsed, dict):
                raise unknown("Config loader must return a plain object or undefined")
        else:
            if target is None:
                return None
            try:
                with open(target, "rb") as file:
                    raw = file.read().decode("utf-8", "replace")
            except FileNotFoundError:
                # Search paths only resolve to existing files, so a missing file was named by flag.
                raise unknown(f"Config file not found: {target}") from None
            except OSError as error:
                # TypeScript reports Node's `fs` message here, whose wording varies by version.
                raise unknown(error.strerror or str(error)) from None
            details = _js.json_parse_error(raw)
            if details is not None:
                raise unknown(f"Invalid JSON config file: {target}\n\nDetails: {details}")
            parsed = _js.parse_json(raw)
            if not isinstance(parsed, dict):
                raise unknown(f"Invalid config file: expected a top-level object in {target}")
        node: Json = typing.cast("dict[str, Json]", parsed)
        for segment in [] if path == cli.name else path.split(" "):
            section = node.get("commands") if isinstance(node, dict) else None
            if not isinstance(section, dict) or segment not in section:
                return None
            node = section[segment]
        if not isinstance(node, dict):
            raise unknown(f"Invalid config section for '{path}': expected an object")
        options = node.get("options")
        if options is None or options == {}:
            return None
        if not isinstance(options, dict):
            raise unknown(f"Invalid config 'options' for '{path}': expected an object")
        return dict(options)

    async def execute(self, resolved: Resolved, filtered: list[str], output: _Output) -> None:
        """Parses input, runs middleware and the handler, and writes the result."""
        cli = self.cli
        command = resolved.command
        path = resolved.path
        depth = len(filtered) - len(resolved.rest)
        globals_: dict[str, Json] = {}
        argv = output.flags.rest
        globals_schema = cli.globals
        if globals_schema is not None:
            try:
                globals_, argv = _parser.parse_globals(
                    output.flags.rest, globals_schema, command.options, known=True, validate=True
                )
            except Error as error:
                self.early_error(error, output.human, output.flags.format)
                return
        argv = argv[depth:]
        if output.human:
            self.deprecations(argv, command.options)
        try:
            defaults = await self.config_defaults(path, output.flags)
        except Error as error:
            self.write_failure(output, error, path)
            return

        context = self.context(path, output, globals_)

        def parse() -> tuple[dict[str, Json], dict[str, Json], dict[str, Json]]:
            args, options = _parser.parse(argv, command.args, command.options, defaults)
            env = _parser.parse_env(command.env, self.env) if command.env else {}
            return args, options, env

        async def sink(chunks: Stream) -> None:
            await self.stream(chunks, path, output)

        result: Success | Error | None
        try:
            if cli.env is not None:
                context.env = build(cli.env, _parser.parse_env(cli.env, self.env))
        except Error as error:
            result = error
        else:
            chain = [*cli.middleware, *resolved.middleware, *command.middleware]
            result = await execute(command, context, chain, parse, sink)
        if result is None:
            return
        if isinstance(result, Error):
            if output.human and not output.flags.format_explicit and result.field_errors:
                self.validation_help(command, path, result)
            else:
                self.write_failure(output, result, path)
            return
        data = MISSING if result.data is None else result.data
        self.write_output(output, True, data, path, format_cta(self.display_name, result.cta))

    def context(
        self, path: str, output: _Output, globals_: dict[str, Json]
    ) -> MiddlewareContext[Any, Any, Any]:
        """Creates the middleware context of a run."""
        cli = self.cli
        return MiddlewareContext[Any, Any, Any](
            agent=not output.human,
            command=path,
            display_name=self.display_name,
            env=None,
            format=output.format,
            format_explicit=output.flags.format_explicit,
            globals=build(cli.globals, globals_) if cli.globals else None,
            name=cli.name,
            var=cli.vars_instance(),
            version=cli.version,
        )

    async def forward(self, hit: GatewayHit, filtered: list[str], output: _Output) -> None:
        """Runs a fetch gateway: sends argv as an HTTP request and writes the response."""
        cli = self.cli
        path = hit.path
        depth = len(filtered) - len(hit.rest)
        globals_: dict[str, Json] = {}
        argv = output.flags.rest
        if cli.globals is not None:
            try:
                globals_, argv = _parser.parse_globals(
                    output.flags.rest, cli.globals, None, known=True, validate=True
                )
            except Error as error:
                self.early_error(error, output.human, output.flags.format)
                return
        argv = argv[depth:]

        async def send() -> None:
            data = _gateway.parse_argv(argv)
            if hit.gateway.base_path:
                data.path = hit.gateway.base_path + data.path
            response = await call(hit.gateway.fetch, _gateway.build_request(data))
            if _gateway.is_streaming(response):
                await self.stream(_gateway.stream(response), path, output, cli.name)
                return
            body = await _gateway.read(response)
            if response.ok:
                self.write_output(output, True, body, path, None)
                return
            code, message = _gateway.error_of(body, response.status)
            self.write_output(output, False, {"code": code, "message": message}, path, None)
            self.exit = 1

        try:
            context = self.context(path, output, globals_)
            if cli.env is not None:
                context.env = build(cli.env, _parser.parse_env(cli.env, self.env))
            chain = [*cli.middleware, *hit.middleware]
            failure = await run_chain(chain, context, send) if chain else await send()
        except Error as error:
            failure = error
        except Exception as error:
            failure = unknown(str(error))
        if failure is not None:
            self.write_failure(output, failure, path)

    def validation_help(self, command: Command, path: str, error: Error) -> None:
        """Writes human validation errors followed by command help."""
        cli = self.cli
        lines: list[str] = []
        for f in error.field_errors or []:
            head, *tail = f.path.split(".")
            suffix = "." + ".".join(tail) if tail else ""
            if command.options is not None and command.options.field(head) is not None:
                kind, label = "option", f"--{_js.to_kebab(head)}{suffix}"
            elif command.env is not None and command.env.field(head) is not None:
                kind, label = "environment variable", f"{head}{suffix}"
            else:
                kind, label = "argument", f"<{f.path}>"
            if f.missing:
                lines.append(f"Error: missing required {kind} {label}")
            elif kind == "environment variable":
                lines.append(f"Error: invalid value for environment variable {label}: {f.message}")
            else:
                lines.append(f"Error: invalid value for {label}: {f.message}")
        lines += ["See below for usage.", ""]
        name = cli.name if path == cli.name else f"{cli.name} {path}"
        lines.append(
            format_command(
                name,
                HelpOptions(
                    args=command.args,
                    config_flag=self.config_flag(),
                    description=command.description,
                    env=command.env,
                    env_source=self.env,
                    examples=command.examples or None,
                    hint=command.hint,
                    options=command.options,
                    usage=command.usage,
                ),
            )
        )
        self.writeln("\n".join(lines))
        self.exit = 1

    async def stream(
        self,
        chunks: Stream | AsyncIterator[Json],
        path: str,
        output: _Output,
        name: str | None = None,
    ) -> None:
        """Writes a streamed result."""
        jsonl = output.format == "jsonl"
        incremental = jsonl or (not output.flags.format_explicit and output.format == "toon")
        name = name or self.display_name

        def fail(error: Error) -> None:
            cta = format_cta(name, error.cta)
            if jsonl:
                record: dict[str, Json] = {"type": "error", "ok": False, "error": error.to_json()}
                if cta is not None:
                    record["meta"] = {"cta": cta.to_json()}
                self.writeln(_js.stringify(record))
            elif incremental:
                self.writeln(human_error(error))
                if cta is not None:
                    self.writeln(cta.human())
            else:
                self.write_output(output, False, error.to_json(), path, cta)
            self.exit = error.exit_code if error.exit_code is not None else 1

        buffered: list[Json] = []
        try:
            async for chunk in chunks:
                value = to_json(chunk)
                if jsonl:
                    self.writeln(_js.stringify({"type": "chunk", "data": value}))
                elif incremental:
                    if output.render:
                        text = format_value(value, output.format)
                        self.writeln(self.truncate(output.flags, text)[0])
                else:
                    buffered.append(value)
        except Error as error:
            fail(error)
            return
        except Exception as error:
            fail(unknown(str(error)))
            return
        final = chunks.final if isinstance(chunks, Stream) else None
        cta = format_cta(name, final.cta if isinstance(final, Outcome) else None)
        if jsonl:
            meta: dict[str, Json] = {"command": path, "duration": self.duration()}
            if cta is not None:
                meta["cta"] = cta.to_json()
            self.writeln(_js.stringify({"type": "done", "ok": True, "meta": meta}))
        elif incremental:
            if cta is not None:
                self.writeln(cta.human())
        else:
            self.write_output(output, True, buffered, path, cta)


def _exists(path: str) -> bool:
    """Whether a path opens for reading, as a search path must."""
    try:
        os.close(os.open(path, os.O_RDONLY))
    except OSError:
        return False
    return True


def _tree(
    commands: dict[str, Entry], root: Command | None, description: str | None
) -> _completions.Node:
    """Builds the completion tree of a command group."""
    nodes: list[tuple[str, _completions.Node, bool]] = []
    for name, entry in commands.items():
        if isinstance(entry, Group):
            node = _tree(entry.commands, entry.root, entry.description)
        else:
            command = target(entry)
            assert command is not None
            node = _completions.Node(command.description, command.options, False, [])
        nodes.append((name, node, isinstance(entry, Alias)))
    options = root.options if root is not None else None
    return _completions.Node(description, options, True, nodes)
