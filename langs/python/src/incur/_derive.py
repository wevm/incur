"""Declared CLIs: commands as classes and groups as unions of them, parsed into typed values."""

from __future__ import annotations

import dataclasses
import inspect
import re
import types
import typing
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    Any,
    Generic,
    Never,
    NoReturn,
    Self,
    TextIO,
    TypeVar,
    Union,
    dataclass_transform,
)

from ._command import Command as Registered
from ._command import Context, Middleware
from ._help import Example, Usage
from ._model import SchemaError, add_field, build, caller_locals, describe_fields, rename, type_of
from ._schema import Field, Type, object_type
from ._tree import Alias, Entry
from ._tree import Group as Mounted

if TYPE_CHECKING:
    from ._cli import Cli, Writer

_T = TypeVar("_T")

#: The handler of a declared CLI: takes the parsed command and the run context.
Handler = Callable[[_T, Context[None, None, None, Any, Any]], object]

_META = "__incur_command__"

#: Class keywords that describe a command, which a command group rejects.
_COMMAND_ONLY = ("destructive", "examples", "hint", "output", "usage")

#: Class methods that a field of the same name would hide.
_METHODS = ("cli", "parse", "parse_async", "parse_with", "serve", "serve_async")


@dataclass
class Meta:
    """What a declared command or group describes."""

    name: str
    description: str | None
    version: str | None
    aliases: list[str]
    middleware: list[Middleware]
    members: list[type] | None = None
    """The member classes of a group, or `None` for a command."""
    args: list[Field] = dataclasses.field(default_factory=list[Field])
    options: list[Field] = dataclasses.field(default_factory=list[Field])
    env: list[Field] = dataclasses.field(default_factory=list[Field])
    destructive: bool = False
    examples: list[Example] = dataclasses.field(default_factory=list[Example])
    hint: str | None = None
    output: Type | None = None
    usage: list[Usage] = dataclasses.field(default_factory=list[Usage])


def meta_of(cls: type) -> Meta:
    """Returns what a declared command or group class describes."""
    found = cls.__dict__.get(_META)
    if not isinstance(found, Meta):
        raise SchemaError(f"{cls.__qualname__} is not an incur.Command or incur.Group class")
    return found


def _inherited(cls: type) -> Meta | None:
    """Returns the metadata of the nearest declared base class."""
    return next((m for b in cls.__mro__[1:] if isinstance(m := b.__dict__.get(_META), Meta)), None)


def _kebab(name: str) -> str:
    """Spells a class name in kebab-case, such as `pr-list` for `PrList`."""
    return re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "-", name).lower()


def _description(cls: type, parent: Meta | None, description: str | None) -> str | None:
    """Returns a class's description: the keyword, its docstring, or its base's description."""
    if description is not None:
        return description
    doc = cls.__dict__.get("__doc__")
    if isinstance(doc, str):
        return inspect.cleandoc(doc)
    return parent.description if parent else None


@dataclass_transform(kw_only_default=True, field_specifiers=(dataclasses.field,))
class Command:
    """A command declared as a class: its fields are the command's input.

    Subclasses become keyword-only dataclasses. Each field is an option, named in camelCase,
    unless `typing.Annotated` metadata marks it `incur.arg(...)` (a positional argument, in field
    order) or `incur.env(...)` (an environment variable, named in SCREAMING_SNAKE_CASE). Field
    types and `incur.field` metadata work as in `@incur.schema` classes. The docstring is the
    description. Class keywords describe the command:

    >>> from typing import Annotated
    >>> from incur import arg
    >>> class Greet(Command, name="greet", version="1.0.0"):
    ...     '''Greets someone.'''
    ...
    ...     name: Annotated[str, arg("Name to greet")]
    ...     loud: bool = False
    >>> Greet.parse_with(["world", "--loud"])
    Greet(name='world', loud=True)

    At the top of a CLI, `name`, `version`, and `aliases` describe the CLI. Mounted in a group,
    `name` and `aliases` name the command, which defaults to the class name in kebab-case.

    A subclass inherits the fields and keywords of its base, except `name` and `aliases`;
    its middleware, examples, and usage lines follow the base's.
    """

    def __init_subclass__(
        cls,
        *,
        name: str | None = None,
        description: str | None = None,
        version: str | None = None,
        aliases: Sequence[str] = (),
        destructive: bool | None = None,
        examples: Sequence[Example] = (),
        hint: str | None = None,
        middleware: Sequence[Middleware] = (),
        output: object = None,
        usage: Sequence[Usage] = (),
        **kwargs: Any,
    ) -> None:
        """Declares a command.

        Args:
            name: The command name, or the CLI name at the top level.
            description: What the command does. Defaults to the docstring.
            version: Version printed by `--version`, when the command is the CLI.
            aliases: Alternative command names, or binary names at the top level.
            destructive: Marks the command as destructive in generated agent skills.
            examples: Usage examples shown in help and manifests.
            hint: Guidance shown after examples.
            middleware: Middleware that runs after CLI and group middleware.
            output: The output type: a schema class, `str`, `Any`, and so on.
            usage: Alternative usage lines.
            **kwargs: Keywords of other base classes.
        """
        super().__init_subclass__(**kwargs)
        parent = _inherited(cls)
        where = cls.__qualname__
        meta = Meta(
            name=name or _kebab(cls.__name__),
            description=_description(cls, parent, description),
            version=version or (parent.version if parent else None),
            aliases=list(aliases),
            middleware=[*(parent.middleware if parent else ()), *middleware],
            destructive=destructive
            if destructive is not None
            else bool(parent and parent.destructive),
            examples=[*(parent.examples if parent else ()), *examples],
            hint=hint or (parent.hint if parent else None),
            output=type_of(output, f"{where} output")
            if output is not None
            else (parent.output if parent else None),
            usage=[*(parent.usage if parent else ()), *usage],
        )
        # Annotations may name classes local to the declaring function.
        _, described = describe_fields(cls, caller_locals())
        for attr, ty, info in described:
            label = f"{where}.{attr}"
            if attr in _METHODS:
                raise SchemaError(
                    f"{label}: the field hides {where}.{attr}(); rename the attribute and set "
                    f"incur.field(name={attr!r})"
                )
            # Options and arguments are camelCase, environment variables SCREAMING_SNAKE_CASE.
            rule = "SCREAMING_SNAKE_CASE" if info.source == "env" else "camelCase"
            # The command line passes positional numbers as text.
            coerce = info.coerce and ty.kind in ("integer", "number")
            fields = {"arg": meta.args, "env": meta.env, "option": meta.options}[info.source]
            key = info.name or rename(rule, attr)
            typed = dataclasses.replace(ty, coerce=True) if coerce else ty
            add_field(fields, label, Field(key, typed, info.alias, attr))
        setattr(cls, _META, meta)

    @classmethod
    def cli(cls) -> Cli[Self]:
        """Returns a `Cli` of this command, as `incur.Cli(cls)` does, for customization."""
        # `_cli` imports this module.
        from ._cli import Cli  # noqa: PLC0415

        return Cli(cls)

    @classmethod
    def parse(cls) -> Self:
        """Parses the process arguments into this command, or exits.

        Help, `--version`, and errors print and exit with their code, as `serve` does.
        """
        return cls.cli().parse()

    @classmethod
    async def parse_async(cls) -> Self:
        """Parses the process arguments inside a running event loop, as `parse` does."""
        return await cls.cli().parse_async()

    @classmethod
    def parse_with(
        cls,
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        stdout: Writer | None = None,
        stderr: Writer | None = None,
        stdin: TextIO | None = None,
        tty: bool = False,
    ) -> Self | int:
        """Parses explicit arguments into this command, or returns the exit code.

        Takes the same arguments as `Cli.serve_with`.
        """
        return cls.cli().parse_with(
            argv, env=env, stdout=stdout, stderr=stderr, stdin=stdin, tty=tty
        )

    @classmethod
    def serve(cls, handler: Handler[Self]) -> NoReturn:
        """Runs the command with `handler`, writes its output, and exits.

        Unlike `parse`, it also serves `--mcp`, as `Cli.serve` does.
        """
        cls.cli().handle(handler).serve()

    @classmethod
    async def serve_async(cls, handler: Handler[Self]) -> int:
        """Runs the command with `handler` inside a running event loop. Returns the exit code."""
        return await cls.cli().handle(handler).serve_async()


class Group(Generic[_T]):
    """A command group declared as a union of its commands: `Group[Status | Install | Db]`.

    Members are `incur.Command` classes, or other groups, which nest. Parsing a group returns
    the member's value, a nested group's wrapped in the group, so class patterns `match` it:

    >>> class Status(Command): ...
    >>> class Migrate(Command): ...
    >>> class Db(Group[Migrate]):
    ...     '''Database commands.'''
    >>> class Ops(Group[Status | Db], name="ops"): ...
    >>> match Ops.parse_with(["db", "migrate"]):
    ...     case Db(Migrate()):
    ...         print("migrating")
    migrating

    The docstring is the description. At the top of a CLI, `name`, `version`, and `aliases`
    describe the CLI and `middleware` runs around every command; mounted, a group's `name`
    names it and its middleware runs around its commands. A subclass inherits the members.
    """

    command: _T
    """The parsed command of the group."""
    __match_args__ = ("command",)

    def __init__(self, command: _T) -> None:
        """Wraps a parsed command of the group."""
        self.command = command

    def __eq__(self, other: object) -> bool:
        return type(other) is type(self) and typing.cast("Self", other).command == self.command

    def __hash__(self) -> int:
        # Commands are mutable dataclasses, which are unhashable, as their groups are then.
        return hash((type(self), self.command))

    def __repr__(self) -> str:
        return f"{type(self).__qualname__}({self.command!r})"

    def __init_subclass__(
        cls,
        *,
        name: str | None = None,
        description: str | None = None,
        version: str | None = None,
        aliases: Sequence[str] = (),
        middleware: Sequence[Middleware] = (),
        **command_only: Never,
    ) -> None:
        """Declares a command group.

        Args:
            name: The group name, or the CLI name at the top level.
            description: What the group does. Defaults to the docstring.
            version: Version printed by `--version`, when the group is the CLI.
            aliases: Alternative binary names, when the group is the CLI.
            middleware: Middleware that runs around the group's commands.
            **command_only: Rejected: keywords that describe a command.

        Raises:
            SchemaError: When a keyword describes a command, or a member is not a command or a
                group.
        """
        where = cls.__qualname__
        for key in command_only:
            if key in _COMMAND_ONLY:
                raise SchemaError(
                    f"{where}: `{key}` describes a command, but {cls.__name__} is a command group"
                )
        super().__init_subclass__(**command_only)
        parent = _inherited(cls)
        members = _members(cls, parent)
        names: set[str] = set()
        for member in members:
            meta = meta_of(member)
            for taken in (meta.name, *(meta.aliases if meta.members is None else ())):
                if taken in names:
                    raise SchemaError(f"{where}: more than one command is named {taken!r}")
                names.add(taken)
        meta = Meta(
            name=name or _kebab(cls.__name__),
            description=_description(cls, parent, description),
            version=version or (parent.version if parent else None),
            aliases=list(aliases),
            middleware=[*(parent.middleware if parent else ()), *middleware],
            members=members,
        )
        setattr(cls, _META, meta)

    @classmethod
    def cli(cls: type[Group[_T]]) -> Cli[_T]:
        """Returns a `Cli` of this group, as `incur.Cli(cls)` does, for customization."""
        # `_cli` imports this module.
        from ._cli import Cli  # noqa: PLC0415

        return Cli(cls)

    @classmethod
    def parse(cls: type[Group[_T]]) -> _T:
        """Parses the process arguments into a command of this group, or exits.

        Help, `--version`, and errors print and exit with their code, as `serve` does.
        """
        return cls.cli().parse()

    @classmethod
    async def parse_async(cls: type[Group[_T]]) -> _T:
        """Parses the process arguments inside a running event loop, as `parse` does."""
        return await cls.cli().parse_async()

    @classmethod
    def parse_with(
        cls: type[Group[_T]],
        argv: Sequence[str],
        *,
        env: Mapping[str, str] | None = None,
        stdout: Writer | None = None,
        stderr: Writer | None = None,
        stdin: TextIO | None = None,
        tty: bool = False,
    ) -> _T | int:
        """Parses explicit arguments into a command of this group, or returns the exit code.

        Takes the same arguments as `Cli.serve_with`.
        """
        return cls.cli().parse_with(
            argv, env=env, stdout=stdout, stderr=stderr, stdin=stdin, tty=tty
        )

    @classmethod
    def serve(cls: type[Group[_T]], handler: Handler[_T]) -> NoReturn:
        """Runs the parsed command with `handler`, writes its output, and exits.

        Unlike `parse`, it also serves `--mcp`, as `Cli.serve` does.
        """
        cls.cli().handle(handler).serve()

    @classmethod
    async def serve_async(cls: type[Group[_T]], handler: Handler[_T]) -> int:
        """Runs the parsed command with `handler` inside a running event loop.

        Returns the exit code.
        """
        return await cls.cli().handle(handler).serve_async()


def _members(cls: type, parent: Meta | None) -> list[type]:
    """Returns the member classes a group's `Group[...]` base names, or its base group's."""
    where = cls.__qualname__
    bases = [b for b in cls.__dict__.get("__orig_bases__", ()) if typing.get_origin(b) is Group]
    if not bases:
        if parent is None:
            raise SchemaError(f"{where}: name the group's commands, as in Group[A | B]")
        return list(parent.members or ())
    (union,) = typing.get_args(bases[0])
    origin = typing.get_origin(union)
    listed = typing.get_args(union) if origin is Union or origin is types.UnionType else (union,)
    for member in listed:
        if not (isinstance(member, type) and isinstance(member.__dict__.get(_META), Meta)):
            raise SchemaError(f"{where}: {member!r} is not an incur.Command or incur.Group class")
    return list(listed)


def attach(into: dict[str, Entry], cls: type, run: Handler[Any]) -> Registered | None:
    """Registers a declared class's commands with `run` as their handler.

    A group's commands go into `into`; a command class returns the root command to register.
    """
    meta = meta_of(cls)
    if meta.members is None:
        return _command(cls, meta, run, root=True)
    for member in meta.members:
        sub = meta_of(member)
        if sub.members is None:
            command = _command(member, sub, run, root=False)
            for alias in command.aliases:
                into[alias] = Alias(command)
            into[sub.name] = command
        else:
            group = Mounted({}, sub.description, list(sub.middleware))
            attach(group.commands, member, _wrap(member, run))
            into[sub.name] = group
    return None


def _wrap(group: type, run: Handler[Any]) -> Handler[Any]:
    """Wraps the values of a nested group's commands in the group."""
    return lambda value, context: run(group(value), context)


def _command(cls: type, meta: Meta, run: Handler[Any], *, root: bool) -> Registered:
    """Registers a command class: its handler builds an instance from the parsed input."""
    sources = (("args", meta.args), ("options", meta.options), ("env", meta.env))

    def handler(context: Context[Any, Any, Any, Any, Any]) -> object:
        values: dict[str, object] = {}
        for source, fields in sources:
            data: dict[str, Any] = getattr(context, source) or {}
            for f in fields:
                if f.name in data:
                    values[f.attr] = build(f.ty, data[f.name])
        bare = dataclasses.replace(context, args=None, options=None, env=None)
        return run(cls(**values), bare)

    return Registered(
        handler=handler,
        # At the top, the CLI takes the name, aliases, and description.
        aliases=[] if root else list(meta.aliases),
        description=None if root else meta.description,
        args=object_type(meta.args) if meta.args else None,
        options=object_type(meta.options) if meta.options else None,
        env=object_type(meta.env) if meta.env else None,
        destructive=meta.destructive,
        examples=list(meta.examples),
        hint=meta.hint,
        middleware=list(meta.middleware),
        output=meta.output,
        usage=list(meta.usage),
    )
