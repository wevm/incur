"""CLI definition, command routing, and the `serve` loop."""

from __future__ import annotations

import asyncio
import inspect
import math
import os
import sys
import time
import typing
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, NoReturn, Protocol, TypeVar

from . import _completions, _filter, _js, _parser, _skill, _tokens
from ._command import (
    Command,
    Middleware,
    MiddlewareContext,
    Outcome,
    OutputPolicy,
    Stream,
    Success,
    execute,
    inputs,
)
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
from ._help import Example, Usage, format_command, format_root
from ._help import Options as HelpOptions
from ._js import Json
from ._model import SchemaError, build, caller_locals, to_json, type_of
from ._schema import Field, Type, json_schema, object_type

_F = TypeVar("_F", bound=Callable[..., object])

#: Who sees the banner: everyone, agents only, or terminals only.
BannerMode = Literal["all", "agent", "human"]

#: The hint appended to destructive commands in agent skills.
DESTRUCTIVE_HINT = "Confirm with the user before executing this destructive command."


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


@dataclass
class _Alias:
    """Another name for a sibling command."""

    command: Command


@dataclass
class _Group:
    """A mounted command group."""

    commands: dict[str, _Entry]
    description: str | None
    middleware: list[Middleware]
    output_policy: OutputPolicy | None
    root: Command | None


_Entry = Command | _Alias | _Group


def _target(entry: _Entry) -> Command | None:
    """Returns the command an entry runs directly, or `None` for groups."""
    if isinstance(entry, _Alias):
        return entry.command
    return entry if isinstance(entry, Command) else None


@dataclass
class _Spec:
    """A CLI definition, as the serve loop reads it."""

    name: str
    description: str | None = None
    version: str | None = None
    aliases: list[str] = field(default_factory=list[str])
    banner: Callable[[], str | Awaitable[str | None] | None] | None = None
    banner_mode: BannerMode = "all"
    config: Config | None = None
    env: Type | None = None
    format: Format | None = None
    globals: Type | None = None
    output_policy: OutputPolicy | None = None
    sync: bool = True
    vars: type | dict[str, Any] = field(default_factory=dict[str, Any])
    commands: dict[str, _Entry] = field(default_factory=dict[str, "_Entry"])
    middleware: list[Middleware] = field(default_factory=list[Middleware])
    root: Command | None = None


class Cli:
    """A CLI: a router of commands, optionally with its own root command.

    >>> import incur
    >>> cli = incur.Cli("my-cli", description="My CLI")
    >>> @cli.command("status", description="Show repo status")
    ... def status(c: incur.Context) -> dict[str, bool]:
    ...     return {"clean": True}
    >>> cli.serve_with(["status"], stdout=sys.stdout)
    clean: true
    0

    Handlers and middleware may be `async def` functions, and streaming handlers async
    generators. `serve()` runs the event loop; `await cli.serve_async()` and `await cli.run(...)`
    run inside one that is already running.
    """

    def __init__(
        self,
        name: str,
        *,
        description: str | None = None,
        version: str | None = None,
        aliases: Sequence[str] = (),
        banner: Callable[[], str | Awaitable[str | None] | None] | None = None,
        banner_mode: BannerMode = "all",
        config: Config | None = None,
        env: type | None = None,
        format: Format | None = None,
        globals: type | None = None,
        output_policy: OutputPolicy | None = None,
        sync: bool = True,
        vars: type | Mapping[str, Any] | None = None,
    ) -> None:
        """Creates a CLI.

        Args:
            name: The CLI name, shown in help and used as the default binary name.
            description: What the CLI does.
            version: Version printed by `--version`.
            aliases: Alternative binary names. Completions register every name.
            banner: Renders text shown above root help. It may be an `async def` function.
            banner_mode: Who sees the banner.
            config: Enables config-file option defaults.
            env: A schema class of CLI-level environment variables, parsed before middleware.
                Middleware reads an instance as `c.env`.
            format: The default output format.
            globals: A schema class of global options available to every command. Middleware and
                handlers read an instance as `c.globals`.
            output_policy: The default output policy, inherited by every command.
            sync: Enables the built-in skills integration.
            vars: Variables that middleware sets for handlers: a class whose fields all have
                defaults, such as an `@incur.schema` class, instantiated for every run as
                `c.var`; or a mapping of defaults, copied into a `dict`.

        Raises:
            SchemaError: When a global option collides with a built-in flag.
        """
        self.name = name
        """The CLI name."""
        self._spec = _Spec(name)
        self._spec.description = description
        self._spec.version = version
        self._spec.aliases = list(aliases)
        self._spec.banner = banner
        self._spec.banner_mode = banner_mode
        self._spec.config = config
        self._spec.env = type_of(env, f"{name} env") if env is not None else None
        self._spec.format = format
        self._spec.globals = (
            self._check_globals(type_of(globals, f"{name} globals")) if globals else None
        )
        self._spec.output_policy = output_policy
        self._spec.sync = sync
        self._spec.vars = vars if isinstance(vars, type) else dict(vars or {})

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
            )
            for alias in command.aliases:
                self._spec.commands[alias] = _Alias(command)
            self._spec.commands[name] = command
            return fn

        return register

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

    def group(self, cli: Cli) -> Cli:
        """Mounts another CLI as a command group. Returns this CLI."""
        root = cli._spec.root
        if root is not None and root.description is None:
            root = replace(root, description=cli._spec.description)
        entry: _Entry
        if root is not None and not cli._spec.commands:
            # A CLI without subcommands mounts as a command, keeping its aliases.
            entry = replace(root, aliases=list(cli._spec.aliases))
            for alias in entry.aliases:
                self._spec.commands[alias] = _Alias(entry)
        else:
            entry = _Group(
                cli._spec.commands,
                cli._spec.description,
                cli._spec.middleware,
                cli._spec.output_policy,
                root,
            )
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
            os.environ,
            sys.stdout,
            sys.stderr,
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
        tty: bool = False,
    ) -> int:
        """Runs the CLI with explicit arguments and I/O inside a running event loop.

        Returns the exit code. Takes the same arguments as `serve_with`.
        """
        return await self._serve(
            list(argv), env or {}, stdout or _Null(), stderr or _Null(), tty, None
        )

    def serve_with(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        stdout: Writer | None = None,
        stderr: Writer | None = None,
        tty: bool = False,
    ) -> int:
        """Runs the CLI with explicit arguments and I/O. Returns the exit code.

        Runs the event loop with `asyncio.run`. Inside a running loop, await `run`.

        Args:
            argv: Arguments after the binary name.
            env: Environment variables. Defaults to none.
            stdout: Receives output. Defaults to discarding it.
            stderr: Receives warnings. Defaults to discarding them.
            tty: Whether stdout is a terminal, which selects human output.
        """
        return asyncio.run(self.run(argv, env=env, stdout=stdout, stderr=stderr, tty=tty))

    async def _serve(
        self,
        argv: list[str],
        env: Mapping[str, str],
        stdout: Writer,
        stderr: Writer,
        tty: bool,
        bin_name: str | None,
    ) -> int:
        display = bin_name if bin_name in (self.name, *self._spec.aliases) else self.name
        root = self._spec.root
        if root is not None and root.description is None:
            root = replace(root, description=self._spec.description)
        run = _Run(self._spec, display or self.name, env, stdout, stderr, tty, root)
        await run.serve(argv)
        return run.exit


class _Null:
    """A writer that discards text."""

    def write(self, text: str, /) -> int:
        return len(text)


@dataclass
class _Resolved:
    """A command to run."""

    command: Command
    commands: dict[str, _Entry] | None
    middleware: list[Middleware]
    output_policy: OutputPolicy | None
    path: str
    rest: list[str]


@dataclass
class _NotFound:
    """An unknown command."""

    commands: dict[str, _Entry]
    error: str
    path: str
    rest: list[str]


@dataclass
class _GroupHelp:
    """A group without a root command."""

    commands: dict[str, _Entry]
    description: str | None
    path: str


def _resolve(commands: dict[str, _Entry], tokens: list[str]) -> _Resolved | _NotFound | _GroupHelp:
    """Walks tokens down the command tree."""
    entry = commands.get(tokens[0]) if tokens else None
    if entry is None:
        return _NotFound(commands, tokens[0] if tokens else "(none)", "", tokens[1:])
    path = [tokens[0]]
    remaining = tokens[1:]
    inherited: OutputPolicy | None = None
    middleware: list[Middleware] = []
    while isinstance(entry, _Group):
        group = entry
        if group.output_policy is not None:
            inherited = group.output_policy
        middleware += group.middleware

        root = group.root
        target = None
        if root is not None:
            policy = root.output_policy or inherited
            target = _Resolved(
                root, group.commands, list(middleware), policy, " ".join(path), remaining
            )
        if not remaining:
            if target is not None:
                return target
            return _GroupHelp(group.commands, group.description, " ".join(path))
        nxt = remaining[0]
        child = group.commands.get(nxt)
        if child is None:
            if target is not None and _suggest(nxt, group.commands) is None:
                return target
            return _NotFound(group.commands, nxt, " ".join(path), remaining[1:])
        entry = child
        path.append(nxt)
        remaining = remaining[1:]
    command = _target(entry)
    assert command is not None
    return _Resolved(
        command, None, middleware, command.output_policy or inherited, " ".join(path), remaining
    )


def _suggest(text: str, candidates: Iterator[str] | Sequence[str] | dict[str, Any]) -> str | None:
    """Suggests the closest candidate by prefix, substring, then edit distance."""
    length = _js.utf16_len(text)
    threshold = 2 if length <= 4 else length // 2
    lower = text.lower()
    best: str | None = None
    best_score: int | None = None
    for candidate in candidates:
        lc = candidate.lower()
        distance = _levenshtein(lower, lc)
        if lc.startswith(lower) and lc != lower:
            score = distance
        elif lower in lc:
            score = 100 + distance
        elif distance <= threshold:
            score = 200 + distance
        else:
            continue
        if best_score is None or score < best_score:
            best_score = score
            best = candidate
    return best


def _levenshtein(a: str, b: str) -> int:
    """Computes the Levenshtein distance over UTF-16 code units."""
    x = _js.utf16(a)
    y = _js.utf16(b)
    dp = list(range(len(y) + 1))
    for i in range(1, len(x) + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, len(y) + 1):
            tmp = dp[j]
            dp[j] = prev if x[i - 1] == y[j - 1] else 1 + min(prev, dp[j], dp[j - 1])
            prev = tmp
    return dp[len(y)]


@dataclass
class _Flags:
    """Built-in flags extracted from argv."""

    config_disabled: bool = False
    config_path: str | None = None
    filter_output: str | None = None
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
    version: bool = False


def _extract_flags(argv: list[str], config_flag: str | None) -> _Flags:
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
        elif token == "--mcp":
            flags.mcp = True
        elif token in ("--help", "-h"):
            flags.help = True
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
            flags.filter_output = nxt
            i += 1
        elif token in ("--token-limit", "--token-offset") and nxt is not None:
            value = _js.to_number(nxt)
            if not math.isfinite(value) or not _js.trim(nxt):
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


def _help_entries(commands: dict[str, _Entry]) -> list[HelpEntry]:
    """Lists immediate children for help output, sorted by name."""
    out = [
        HelpEntry(name, entry.description)
        for name, entry in commands.items()
        if not isinstance(entry, _Alias)
    ]
    out.sort(key=lambda e: _js.locale_key(e.name))
    return out


def _hint_with_destructive(command: Command) -> str | None:
    if not command.destructive:
        return command.hint
    if not command.hint:
        return DESTRUCTIVE_HINT
    if DESTRUCTIVE_HINT in command.hint:
        return command.hint
    return f"{command.hint} {DESTRUCTIVE_HINT}"


def _prefixed_examples(examples: list[Example], name: str) -> list[Example]:
    return [Example(f"{name} {e.command}" if e.command else name, e.description) for e in examples]


def _command_info(name: str | None, command: Command) -> _skill.CommandInfo:
    examples = _prefixed_examples(command.examples, name) if name else list(command.examples)
    return _skill.CommandInfo(
        name=name,
        args=command.args,
        description=command.description,
        env=command.env,
        examples=examples,
        hint=_hint_with_destructive(command),
        options=command.options,
        output=command.output,
    )


def _skill_commands(
    commands: dict[str, _Entry],
    prefix: list[str],
    groups: dict[str, str],
    root: Command | None,
) -> list[_skill.CommandInfo]:
    """Collects commands for Markdown manifests, sorted by name."""
    out: list[_skill.CommandInfo] = []
    if root is not None:
        out.append(_command_info(None, root))
    for name, entry in commands.items():
        path = [*prefix, name]
        joined = " ".join(path)
        if isinstance(entry, Command):
            out.append(_command_info(joined, entry))
        elif isinstance(entry, _Group):
            if entry.description is not None:
                groups[joined] = entry.description
            if entry.root is not None:
                out.append(_command_info(joined, entry.root))
            out += _skill_commands(entry.commands, path, groups, None)
    out.sort(key=lambda info: _js.locale_key(info.name or ""))
    return out


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
        for example in _prefixed_examples(command.examples, path):
            item: dict[str, Json] = {"command": example.command}
            if example.description is not None:
                item["description"] = example.description
            examples.append(item)
        out["examples"] = examples
    return out


def _manifest_commands(
    commands: dict[str, _Entry], prefix: list[str], full: bool
) -> list[dict[str, Json]]:
    out: list[dict[str, Json]] = []
    for name, entry in commands.items():
        path = [*prefix, name]
        joined = " ".join(path)
        if isinstance(entry, Command):
            out.append(_manifest_entry(joined, entry, full))
        elif isinstance(entry, _Group):
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
        cli: _Spec,
        display_name: str,
        env: Mapping[str, str],
        stdout: Writer,
        stderr: Writer,
        tty: bool,
        root: Command | None,
    ) -> None:
        self.cli = cli
        self.display_name = display_name
        self.env_map = env
        self.stdout = stdout
        self.stderr = stderr
        self.tty = tty
        self.root = root
        self.exit = 0
        self.start = time.monotonic()

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
            hide_skills=not self.cli.sync,
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

    def root_help(self) -> str:
        cli = self.cli
        return format_root(
            cli.name,
            self.help_options(
                aliases=cli.aliases,
                commands=_help_entries(cli.commands),
                description=cli.description,
                root=True,
                version=cli.version,
            ),
        )

    def group_help(self, group: _GroupHelp, **overrides: Any) -> str:
        return format_root(
            f"{self.cli.name} {group.path}",
            self.help_options(
                commands=_help_entries(group.commands), description=group.description, **overrides
            ),
        )

    async def serve(self, argv: list[str]) -> None:
        cli = self.cli
        shell = self.env("COMPLETE")
        if shell is not None:
            self.complete(shell, argv)
            return
        try:
            flags = _extract_flags(argv, self.config_flag())
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

        if flags.mcp:
            self.unsupported("--mcp", human)
            return
        if flags.llms or flags.llms_full:
            self.llms(flags, filtered)
            return

        def builtin_index(builtin: str) -> int | None:
            if filtered and _find_builtin(filtered[0]) == builtin:
                return 0
            if (
                len(filtered) > 1
                and filtered[0] == cli.name
                and _find_builtin(filtered[1]) == builtin
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
            if builtin == "skills" and not cli.sync:
                continue
            index = builtin_index(builtin)
            if index is not None:
                self.builtin(builtin, filtered, index, argv, flags, human)
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
                commands = _help_entries(cli.commands)
                options = self.command_help(root, cli.aliases, version, commands, True)
                self.writeln(format_command(cli.name, options))
                return
            if root is None:
                await self.banner(human, flags.help)
                self.writeln(self.root_help())
                return

        resolved: _Resolved | _NotFound | _GroupHelp
        if root is not None and not filtered:
            resolved = _Resolved(root, None, [], None, cli.name, [])
        else:
            resolved = _resolve(cli.commands, filtered)

        if flags.help:
            self.help(resolved)
            return
        if flags.schema:
            self.schema(resolved, flags)
            return

        command_format = resolved.command.format if isinstance(resolved, _Resolved) else None
        fmt = flags.format if flags.format_explicit else command_format or cli.format or "toon"

        # A token that is not a typo of a known command falls back to the root command.
        if isinstance(resolved, _NotFound) and not resolved.path and root is not None:
            candidates = [*resolved.commands, *self.builtin_names()]
            if _suggest(resolved.error, candidates) is None:
                resolved = _Resolved(root, None, [], None, cli.name, list(filtered))

        if isinstance(resolved, _Resolved):
            policy = resolved.output_policy or cli.output_policy
        else:
            policy = cli.output_policy
        output = _Output(
            flags=flags,
            format=fmt,
            human=human,
            filter=_filter.parse(flags.filter_output) if flags.filter_output is not None else None,
            render=not (human and policy == "agent-only"),
        )

        if isinstance(resolved, _NotFound):
            self.not_found(resolved.error, resolved.path, resolved.commands, argv, output)
        elif isinstance(resolved, _Resolved):
            await self.execute(resolved, filtered, output)
        else:
            self.writeln(self.group_help(resolved, hide_skills=False))

    def builtin_names(self) -> list[str]:
        """Names of built-in commands, without skills when the integration is disabled."""
        return [n for n, _ in _BUILTINS if self.cli.sync or n != "skills"]

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

    def help(self, resolved: _Resolved | _NotFound | _GroupHelp) -> None:
        cli = self.cli
        if isinstance(resolved, _GroupHelp):
            text = self.group_help(resolved)
        elif isinstance(resolved, _NotFound):
            entries = _help_entries(cli.commands)
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
                entries = _help_entries(resolved.commands)
            elif is_root:
                entries = _help_entries(cli.commands)
            else:
                entries = []
            aliases = cli.aliases if is_root else command.aliases
            version = cli.version if is_root else None
            text = format_command(
                name, self.command_help(command, aliases, version, entries, is_root)
            )
        self.writeln(text)

    def schema(self, resolved: _Resolved | _NotFound | _GroupHelp, flags: _Flags) -> None:
        cli = self.cli
        if isinstance(resolved, _GroupHelp):
            self.writeln(self.group_help(resolved, hide_skills=False))
        elif isinstance(resolved, _NotFound):
            parent = f"{cli.name} {resolved.path}" if resolved.path else cli.name
            suggestion = _suggest(resolved.error, resolved.commands)
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
        commands: dict[str, _Entry] = cli.commands
        prefix: list[str] = []
        description = cli.description
        root = self.root
        for token in filtered:
            entry = commands.get(token)
            if entry is None:
                break
            if isinstance(entry, _Group):
                commands = entry.commands
                description = entry.description
                root = entry.root
                prefix.append(token)
            else:
                command = _target(entry)
                assert command is not None
                commands = {token: command}
                root = None
                break
        if not prefix:
            root = self.root
        scoped = " ".join([cli.name, *prefix])
        if not flags.format_explicit or flags.format == "md":
            groups: dict[str, str] = {}
            infos = _skill_commands(commands, [], groups, root)
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

    def builtin(
        self,
        builtin: str,
        filtered: list[str],
        index: int,
        argv: list[str],
        flags: _Flags,
        human: bool,
    ) -> None:
        """Handles `skills` and `mcp`: help output, and an error for unported actions."""
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
            suggestion = _suggest(sub, candidates)
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
        self.unsupported(f"{builtin} {found[1]}", human)

    def unsupported(self, feature: str, human: bool) -> None:
        """Reports a built-in this port does not implement."""
        error = Error(
            "UNSUPPORTED", f"'{feature}' is not supported by the Python port of incur yet."
        )
        self.early_error(error, human, "toon")

    def complete(self, shell: str, argv: list[str]) -> None:
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
                if name == "skills" and not cli.sync:
                    continue
                if name.startswith(current) and not any(c.value == name for c in candidates):
                    candidates.append(
                        _completions.Candidate(name, description, name != "completions")
                    )
        elif non_flags is not None and len(non_flags) == 2:
            builtin = _find_builtin(non_flags[1])
            if builtin is not None and builtin != "completions" and builtin in self.builtin_names():
                for sub in _BUILTIN_SUBCOMMANDS:
                    if sub[0] != builtin:
                        continue
                    for value in (sub[1], *sub[3]):
                        if value.startswith(current) and not any(
                            c.value == value for c in candidates
                        ):
                            candidates.append(_completions.Candidate(value, sub[2]))
        out = _completions.format_candidates(shell, candidates)
        if out:
            self.write(out)

    def not_found(
        self,
        error: str,
        path: str,
        commands: dict[str, _Entry],
        argv: list[str],
        output: _Output,
    ) -> None:
        cli = self.cli
        parent = f"{cli.name} {path}" if path else cli.name
        candidates = list(commands)
        if not path:
            candidates += self.builtin_names()
        suggestion = _suggest(error, candidates)
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
            self.writeln(cta.human())
        else:
            self.write_output(output, False, failure.to_json(), error, cta)
        self.exit = 1

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
        actual_end = min(end, total)
        nxt = actual_end if actual_end < total else None
        note = (
            f"[truncated: showing tokens {_js.number_to_string(offset)}\u2013"
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

    async def execute(self, resolved: _Resolved, filtered: list[str], output: _Output) -> None:
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

        context = MiddlewareContext[Any, Any, Any](
            agent=not output.human,
            command=path,
            display_name=self.display_name,
            env=None,
            format=output.format,
            format_explicit=output.flags.format_explicit,
            globals=build(globals_schema, globals_) if globals_schema else None,
            name=cli.name,
            var=cli.vars() if isinstance(cli.vars, type) else dict(cli.vars),
            version=cli.version,
        )

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

    async def stream(self, chunks: Stream, path: str, output: _Output) -> None:
        """Writes a streamed result."""
        jsonl = output.format == "jsonl"
        incremental = jsonl or (not output.flags.format_explicit and output.format == "toon")
        name = self.display_name

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
        final = chunks.final
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
    commands: dict[str, _Entry], root: Command | None, description: str | None
) -> _completions.Node:
    """Builds the completion tree of a command group."""
    nodes: list[tuple[str, _completions.Node, bool]] = []
    for name, entry in commands.items():
        if isinstance(entry, _Group):
            node = _tree(entry.commands, entry.root, entry.description)
        else:
            command = _target(entry)
            assert command is not None
            node = _completions.Node(command.description, command.options, False, [])
        nodes.append((name, node, isinstance(entry, _Alias)))
    options = root.options if root is not None else None
    return _completions.Node(description, options, True, nodes)
