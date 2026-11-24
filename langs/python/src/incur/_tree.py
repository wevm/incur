"""The command tree: CLI definitions, entries, and command resolution."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterator, Sequence
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Literal

from . import _js
from ._command import Command, Middleware, OutputPolicy
from ._help import Entry as HelpEntry
from ._http import FetchHandler
from ._schema import Type

if TYPE_CHECKING:
    from ._cli import Config
    from ._formatter import Format
    from ._mcp import McpOptions
    from ._mcp_features import App, Prompt, Resource, ResourceTemplate
    from ._sync import Sync
    from ._update import Update

#: Who sees the banner: everyone, agents only, or terminals only.
BannerMode = Literal["all", "agent", "human"]


@dataclass
class Alias:
    """Another name for a sibling command."""

    command: Command


@dataclass
class Group:
    """A mounted command group."""

    commands: dict[str, Entry]
    description: str | None = None
    middleware: list[Middleware] = field(default_factory=list[Middleware])
    output_policy: OutputPolicy | None = None
    root: Command | None = None
    mcp: bool = True


@dataclass
class Gateway:
    """A command that forwards its arguments to a fetch handler as an HTTP request."""

    fetch: FetchHandler
    description: str | None = None
    base_path: str | None = None
    output_policy: OutputPolicy | None = None


Entry = Command | Alias | Group | Gateway


def target(entry: Entry) -> Command | None:
    """Returns the command an entry runs directly, or `None` for groups and gateways."""
    if isinstance(entry, Alias):
        return entry.command
    return entry if isinstance(entry, Command) else None


@dataclass
class Spec:
    """A CLI definition, as the transports read it."""

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
    sync: Sync | None = None
    vars: type | dict[str, Any] = field(default_factory=dict[str, Any])
    commands: dict[str, Entry] = field(default_factory=dict[str, "Entry"])
    middleware: list[Middleware] = field(default_factory=list[Middleware])
    root: Command | None = None
    root_fetch: FetchHandler | None = None
    mcp: McpOptions | None = None
    mcp_enabled: bool = True
    prompts: list[Prompt] = field(default_factory=list["Prompt"])
    resources: list[Resource] = field(default_factory=list["Resource"])
    resource_templates: list[ResourceTemplate] = field(default_factory=list["ResourceTemplate"])
    apps: list[App] = field(default_factory=list["App"])
    package: str | None = None
    update: Update | None = None
    pending: list[Callable[[], Awaitable[None]]] = field(
        default_factory=list[Callable[[], Awaitable[None]]]
    )
    lazy: dict[str, Callable[[], Awaitable[None]]] = field(
        default_factory=dict[str, Callable[[], Awaitable[None]]]
    )
    parse_only: bool = False
    """Whether the CLI parses a declared command for its caller, which hides `--mcp`."""

    def root_command(self) -> Command | None:
        """Returns the root command, described by the CLI when it has no description."""
        root = self.root
        if root is not None and root.description is None:
            root = replace(root, description=self.description)
        return root

    async def load_pending(self) -> None:
        """Resolves pending generated groups, such as OpenAPI commands."""
        while self.pending:
            await self.pending.pop(0)()

    async def load(self, name: str | None = None) -> None:
        """Resolves deferred commands: pending groups, and one lazy group or every one."""
        await self.load_pending()
        if name is None:
            for load in list(self.lazy.values()):
                await load()
        elif name in self.lazy:
            await self.lazy[name]()

    def vars_instance(self) -> Any:
        """Creates the variables of one run."""
        return self.vars() if isinstance(self.vars, type) else dict(self.vars)


def once(load: Callable[[], Awaitable[None]]) -> Callable[[], Awaitable[None]]:
    """Wraps a loader so concurrent and later calls share its first run, including a failure."""
    task: list[asyncio.Future[None]] = []

    async def run() -> None:
        if not task:
            task.append(asyncio.ensure_future(load()))
        await asyncio.shield(task[0])

    return run


@dataclass
class Resolved:
    """A command to run."""

    command: Command
    commands: dict[str, Entry] | None
    middleware: list[Middleware]
    output_policy: OutputPolicy | None
    path: str
    rest: list[str]


@dataclass
class GatewayHit:
    """A fetch gateway to forward to."""

    gateway: Gateway
    middleware: list[Middleware]
    output_policy: OutputPolicy | None
    path: str
    rest: list[str]


@dataclass
class NotFound:
    """An unknown command."""

    commands: dict[str, Entry]
    error: str
    path: str
    rest: list[str]


@dataclass
class GroupHelp:
    """A group without a root command."""

    commands: dict[str, Entry]
    description: str | None
    path: str


Resolution = Resolved | GatewayHit | NotFound | GroupHelp


def resolve(commands: dict[str, Entry], tokens: list[str]) -> Resolution:
    """Walks tokens down the command tree."""
    entry = commands.get(tokens[0]) if tokens else None
    if entry is None:
        return NotFound(commands, tokens[0] if tokens else "(none)", "", tokens[1:])
    path = [tokens[0]]
    remaining = tokens[1:]
    inherited: OutputPolicy | None = None
    middleware: list[Middleware] = []
    while isinstance(entry, Group):
        group = entry
        if group.output_policy is not None:
            inherited = group.output_policy
        middleware += group.middleware

        root = group.root
        hit = None
        if root is not None:
            policy = root.output_policy or inherited
            hit = Resolved(
                root, group.commands, list(middleware), policy, " ".join(path), remaining
            )
        if not remaining:
            if hit is not None:
                return hit
            return GroupHelp(group.commands, group.description, " ".join(path))
        nxt = remaining[0]
        child = group.commands.get(nxt)
        if child is None:
            if hit is not None and suggest(nxt, group.commands) is None:
                return hit
            return NotFound(group.commands, nxt, " ".join(path), remaining[1:])
        entry = child
        path.append(nxt)
        remaining = remaining[1:]
    if isinstance(entry, Gateway):
        policy = entry.output_policy or inherited
        return GatewayHit(entry, middleware, policy, " ".join(path), remaining)
    command = target(entry)
    assert command is not None
    return Resolved(
        command, None, middleware, command.output_policy or inherited, " ".join(path), remaining
    )


def suggest(text: str, candidates: Iterator[str] | Sequence[str] | dict[str, Any]) -> str | None:
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


def help_entries(commands: dict[str, Entry]) -> list[HelpEntry]:
    """Lists immediate children for help output, sorted by name."""
    out = [
        HelpEntry(name, entry.description)
        for name, entry in commands.items()
        if not isinstance(entry, Alias)
    ]
    out.sort(key=lambda e: _js.locale_key(e.name))
    return out
