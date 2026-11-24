"""Declared CLIs: `incur.Command` classes and `incur.Group` unions, parsed into typed values."""

from __future__ import annotations

import asyncio
import io
import os
import sys
import types
from typing import Annotated, Any, Literal, assert_never

import pytest
from inline_snapshot import snapshot

import incur
from incur import Example, Usage, arg, env, field


async def trace(c: incur.MiddlewareContext, next_: incur.Next) -> None:
    """Records that the middleware ran."""
    c.var["trace"] = [*c.var.get("trace", []), c.command]
    await next_()


class Status(incur.Command):
    """Show status"""


class Deploy(
    incur.Command,
    examples=[Example("api 3")],
    hint="Deploys are logged.",
):
    """Deploys a service."""

    service: Annotated[str, arg("Service name")]
    replicas: Annotated[int | None, arg("Replica count")] = None
    stage: Annotated[Literal["dev", "prod"], field("Target stage", alias="s")] = "dev"
    verbose: Annotated[int, field("Verbosity", alias="v", count=True)] = 0
    api_token: Annotated[str | None, env("API token")] = None
    dry_run: Annotated[bool | None, field("Renamed flag", name="dry")] = None
    labels: Annotated[list[str], field("Labels")] = []


class Ship(
    Deploy,
    name="ship",
    aliases=["go"],
    description="Ship it now",
    usage=[Usage(args=["service"], options=["stage"], prefix="env X=1", suffix="| tee log")],
):
    pass


class Migrate(incur.Command): ...


class Shell(incur.Command, name="sh", middleware=[trace]):
    name: Annotated[str | None, arg()] = None


class Db(incur.Group[Migrate | Shell], middleware=[trace]):
    """Database commands"""


class Admin(Db, name="admin", description="Database admin"): ...


class Ping(incur.Command): ...


class Misc(incur.Group[Ping]): ...


class Wipe(incur.Command, destructive=True, output=str):
    """Wipe all data"""

    yes: Annotated[bool, field("Confirmation", alias="y")] = False
    level: Annotated[float | None, arg("Strict level", coerce=False)] = None


class Ops(
    incur.Group[Status | Deploy | Ship | Db | Admin | Misc | Wipe],
    name="ops",
    version="2.0.0",
    aliases=["op"],
):
    """Operations tooling."""


class Bare(incur.Command, version="0.1.0"):
    """A CLI that takes no input."""


class Loose(incur.Command):
    """Optional fields without defaults."""

    path: Annotated[str | None, arg("Path")]
    tag: Annotated[str | None, field("Tag")]
    home: Annotated[str | None, env("Home")]
    extra: Any


def ops() -> incur.Cli[Status | Deploy | Ship | Db | Admin | Misc | Wipe]:
    return incur.Cli(Ops, update=False, sync=False)


def parse(cli: incur.Cli[Any], *argv: str, env: dict[str, str] | None = None) -> str:
    """Parses `argv` and returns the result and the output."""
    stdout = io.StringIO()
    parsed = cli.parse_with(argv, env=env, stdout=stdout)
    return f"{parsed!r}\n{stdout.getvalue()}"


def test_parses_declared_commands() -> None:
    outputs = [
        parse(ops(), "status"),
        parse(ops(), "status", "--full-output"),
        parse(ops(), "deploy", "api", "3", "-s", "prod", "-vv", "--dry", env={"API_TOKEN": "x"}),
        parse(ops(), "go", "web", "--labels", "a"),
        parse(ops(), "db", "sh", "main"),
        parse(ops(), "admin", "migrate"),
        parse(ops(), "wipe", "-y"),
        parse(ops(), "wipe", "3"),
        parse(ops(), "deploy"),
        parse(incur.Cli(Bare), "--version"),
        parse(ops(), "misc", "ping"),
        parse(ops(), "misc", "--help"),
    ]
    assert "---\n".join(outputs) == snapshot("""\
Status()
---
Status()
---
Deploy(service='api', replicas=3, stage='prod', verbose=2, api_token='x', dry_run=True, labels=[])
---
Ship(service='web', replicas=None, stage='dev', verbose=0, api_token=None, dry_run=None, labels=['a'])
---
Db(Shell(name='main'))
---
Admin(Migrate())
---
Wipe(yes=True, level=None)
---
1
code: VALIDATION_ERROR
message: "Invalid input: expected number, received string\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"number\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"level\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected number, received string\\"\\n  }\\n]"
fieldErrors[1]{code,missing,path,expected,received,message}:
  invalid_type,false,level,number,"","Invalid input: expected number, received string"
---
1
code: VALIDATION_ERROR
message: "Invalid input: expected string, received undefined\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"service\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  }\\n]"
fieldErrors[1]{code,missing,path,expected,received,message}:
  invalid_type,true,service,string,"","Invalid input: expected string, received undefined"
---
0
0.1.0
---
Misc(Ping())
---
0
ops misc

Usage: ops misc <command>

Commands:
  ping

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --json                              Shorthand for --format json
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
""")
    assert Bare.parse_with([]) == Bare()
    assert Loose.parse_with([], env={}) == Loose(path=None, tag=None, home=None, extra=None)
    assert Loose.parse_with(["a", "--tag", "t", "--extra", "x"], env={"HOME": "/h"}) == Loose(
        path="a", tag="t", home="/h", extra="x"
    )
    assert Ops.parse_with(["db", "migrate"]) == Db(Migrate())
    assert Ops.parse_with(["--help"]) == 0
    assert repr(Admin(Shell(name="x"))) == "Admin(Shell(name='x'))"
    assert Db(Migrate()) != Admin(Migrate())
    with pytest.raises(TypeError, match="unhashable"):
        hash(Db(Migrate()))


def test_matches_parsed_commands() -> None:
    def describe(command: Status | Deploy | Ship | Db | Admin | Misc | Wipe) -> str:
        match command:
            case Status():
                return "status"
            case Ship(service=service) | Deploy(service=service):
                return f"deploy {service}"
            # Subclasses of groups are listed: pyright does not narrow them by sub-patterns.
            case Admin(command=sub) | Db(command=sub):
                match sub:
                    case Migrate():
                        return f"{type(command).__name__} migrate"
                    case Shell(name=name):
                        return f"{type(command).__name__} shell {name}"
            case Misc(Ping()):
                return "ping"
            case Wipe(yes=yes):
                return f"wipe {yes}"
            case _:
                assert_never(command)

    argvs = [["status"], ["go", "x"], ["admin", "migrate"], ["db", "sh"], ["misc", "ping"]]
    parsed = [ops().parse_with(argv) for argv in argvs]
    assert [describe(p) for p in parsed if not isinstance(p, int)] == snapshot(
        ["status", "deploy x", "Admin migrate", "Db shell None", "ping"]
    )


def test_parses_failed_middleware() -> None:
    def cli() -> incur.Cli[Bare]:
        cli = incur.Cli(Bare, update=False)

        @cli.use
        async def deny(c: incur.MiddlewareContext, next_: incur.Next) -> None:
            await next_()
            raise incur.Error("DENIED", "failed after the command")

        return cli

    assert parse(cli()) == snapshot("""\
1
code: DENIED
message: failed after the command
""")
    assert parse(cli(), "--format", "json") == snapshot("""\
1
{
  "code": "DENIED",
  "message": "failed after the command"
}
""")


def test_hides_mcp_when_parsing() -> None:
    cli = incur.Cli(Ops, update=False)
    complete = {"COMPLETE": "bash"}
    outputs = [
        parse(cli, "--help"),
        parse(cli, "--mcp"),
        parse(cli, "mcp", "add"),
        parse(cli, "mc"),
        parse(cli, "--", "ops", "", env=complete),
        parse(cli, "--", "ops", "mcp", "", env=complete),
        parse(cli, "deploy", "--help"),
        parse(cli, "ship", "--help"),
        parse(cli, "admin", "--help"),
    ]
    # Completion candidates are separated by control characters.
    text = "---\n".join(outputs).replace("\v", " ").replace("\x01", "/")
    assert text == snapshot("""\
0
ops@2.0.0 — Operations tooling.

Usage: ops <command>
Aliases: op

Commands:
  admin   Database admin
  db      Database commands
  deploy  Deploys a service.
  misc
  ship    Ship it now
  status  Show status
  wipe    Wipe all data

Integrations:
  completions  Generate shell completion script
  skills       Sync skill files to agents (add, list)

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --json                              Shorthand for --format json
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
  --version                           Show version
---
1
code: COMMAND_NOT_FOUND
message: '--mcp' is not a command for 'ops'.
cta:
  description: "Suggested command:"
  commands[1]{command,description}:
    ops --help,see all available commands
---
1
code: COMMAND_NOT_FOUND
message: 'mcp' is not a command for 'ops'.
cta:
  description: "Suggested command:"
  commands[1]{command,description}:
    ops --help,see all available commands
---
1
code: COMMAND_NOT_FOUND
message: 'mc' is not a command for 'ops'. Did you mean 'go'?
cta:
  description: "Suggested commands:"
  commands[2]:
    - command: ops go
    - command: ops --help
      description: see all available commands
---
0
status deploy ship db/ admin/ misc/ wipe completions skills/---
0
status deploy ship db/ admin/ misc/ wipe---
0
ops deploy — Deploys a service.

Usage: ops deploy <service> [replicas] [options]

Arguments:
  service   Service name
  replicas  Replica count

Options:
  --stage, -s <dev|prod>  Target stage (default: dev)
  --verbose, -v <count>   Verbosity (default: 0)
  --dry                   Renamed flag
  --labels <array>        Labels

Examples:
  ops deploy api 3

Deploys are logged.

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --json                              Shorthand for --format json
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output

Environment Variables:
  API_TOKEN  API token
---
0
ops ship — Ship it now

Usage: env X=1 ops ship <service> --stage <stage> | tee log
Aliases: go

Arguments:
  service   Service name
  replicas  Replica count

Options:
  --stage, -s <dev|prod>  Target stage (default: dev)
  --verbose, -v <count>   Verbosity (default: 0)
  --dry                   Renamed flag
  --labels <array>        Labels

Examples:
  ops ship api 3

Deploys are logged.

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --json                              Shorthand for --format json
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output

Environment Variables:
  API_TOKEN  API token
---
0
ops admin — Database admin

Usage: ops admin <command>

Commands:
  migrate
  sh

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --json                              Shorthand for --format json
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
""")


def test_serves_declared_commands() -> None:
    def run(command: Status | Deploy | Ship | Db | Admin | Misc | Wipe, c: incur.Context) -> object:
        assert c.args is None
        return {"command": repr(command), "trace": c.var.get("trace")}

    served = ops().handle(run)
    stdout = io.StringIO()
    assert served.serve_with(["db", "sh", "main"], stdout=stdout) == 0
    assert served.serve_with(["--help"], stdout=stdout) == 0
    # A declared group mounts in a builder CLI, and a builder CLI in a declared one.
    builder = incur.Cli("tool", update=False)
    builder.group(incur.Cli(Db).handle(lambda command, _: repr(command)))
    extra = incur.Cli("extra")

    @extra.command("run")
    def extra_run(c: incur.Context) -> str:
        return "extra"

    mixed = incur.Cli(Ops, update=False).group(extra)
    assert builder.serve_with(["db", "migrate"], stdout=stdout) == 0
    assert mixed.parse_with(["extra", "run"], stdout=stdout) == 0
    assert mixed.parse_with(["status"]) == Status()
    assert stdout.getvalue() == snapshot("""\
command: Db(Shell(name='main'))
trace[2]: db sh,db sh
ops@2.0.0 — Operations tooling.

Usage: ops <command>
Aliases: op

Commands:
  admin   Database admin
  db      Database commands
  deploy  Deploys a service.
  misc
  ship    Ship it now
  status  Show status
  wipe    Wipe all data

Integrations:
  completions  Generate shell completion script
  mcp          Register as MCP server (add, doctor)

Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --json                              Shorthand for --format json
  --llms, --llms-full                 Print LLM-readable manifest
  --mcp                               Start as MCP stdio server
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output
  --version                           Show version
Migrate()
extra
""")


def test_serves_and_parses_the_process(monkeypatch: pytest.MonkeyPatch) -> None:
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(os, "environ", {})
    monkeypatch.setattr(sys, "argv", ["ops", "go", "web"])
    assert Ops.parse() == Ship(service="web")
    assert asyncio.run(Ops.parse_async()) == Ship(service="web")
    monkeypatch.setattr(sys, "argv", ["bare"])
    assert Bare.parse() == Bare()
    assert asyncio.run(Bare.parse_async()) == Bare()
    with pytest.raises(SystemExit) as exit_info:
        Bare.serve(lambda bare, _: "served")
    assert exit_info.value.code == 0
    assert asyncio.run(Bare.serve_async(lambda bare, _: "async")) == 0
    monkeypatch.setattr(sys, "argv", ["ops", "misc", "ping"])
    with pytest.raises(SystemExit) as exit_info:
        Ops.serve(lambda command, _: repr(command))
    assert exit_info.value.code == 0
    assert asyncio.run(Ops.serve_async(lambda command, _: "async")) == 0
    monkeypatch.setattr(sys, "argv", ["ops", "--version"])
    with pytest.raises(SystemExit) as exit_info:
        Ops.parse()
    assert exit_info.value.code == 0
    assert stdout.getvalue() == snapshot("""\
served
async
Misc(Ping())
async
2.0.0
""")


def test_rejects_invalid_declarations() -> None:
    def declare(name: str, base: object, /, **keywords: object) -> type:
        """Declares a class that type checkers reject."""
        return types.new_class(name, (base,), keywords)

    with pytest.raises(incur.SchemaError, match=r"^Bad: `hint` describes a command, but Bad is a"):
        declare("Bad", incur.Group[Status], hint="Not for groups")
    with pytest.raises(TypeError):
        declare("Unknown", incur.Group[Status], color="red")
    with pytest.raises(incur.SchemaError, match=r"^Empty: name the group's commands"):
        declare("Empty", incur.Group)
    with pytest.raises(
        incur.SchemaError, match=r"^Strings: <class 'str'> is not an incur\.Command"
    ):
        declare("Strings", incur.Group[str])
    go = declare("Go", incur.Command, name="ship")
    with pytest.raises(incur.SchemaError, match=r"^Twice: more than one command is named 'ship'"):
        declare("Twice", incur.Group[Ship | go])
    with pytest.raises(incur.SchemaError, match=r"^Hidden\.parse: the field hides Hidden\.parse"):
        types.new_class(
            "Hidden",
            (incur.Command,),
            {},
            lambda ns: ns.update(__annotations__={"parse": bool}, parse=False),
        )
    with pytest.raises(incur.SchemaError, match=r"Marked\.name: incur\.arg\(\) marks a field"):

        @incur.schema
        class Marked:
            name: Annotated[str, arg()]

    with pytest.raises(incur.SchemaError, match=r"^int is not an incur\.Command or incur\.Group"):
        incur.Cli(typing_cast(int))
    with pytest.raises(incur.SchemaError, match=r"handle\(\) needs a Cli of an incur.Command"):
        incur.Cli("tool").handle(lambda command, _: None)
    with pytest.raises(incur.SchemaError, match=r"parse\(\) needs a Cli of an incur.Command"):
        incur.Cli("tool").parse_with([])


def typing_cast(cls: type) -> Any:
    """Passes a class that is not declared, which type checkers reject."""
    return cls
