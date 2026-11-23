"""Python-only behavior that the differential suite cannot compare with TypeScript: process I/O
defaults, handler and middleware failures, the async API,
typed middleware state, and inputs the TypeScript reference treats differently by design, such as
exact integers beyond 2^53.
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import typing
from collections.abc import AsyncGenerator, Generator
from pathlib import Path
from typing import Annotated

import fixtures
import pytest
from inline_snapshot import snapshot

import incur
from incur import Context, CtaBlock, Error, field


def serve(
    cli: incur.Cli, *argv: str, tty: bool = False, env: dict[str, str] | None = None
) -> tuple[int, str]:
    """Serves `argv` and returns the exit code and the output, stderr after stdout."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = cli.serve_with(argv, env=env, stdout=stdout, stderr=stderr, tty=tty)
    return code, stdout.getvalue() + stderr.getvalue()


def test_discards_output_without_streams() -> None:
    assert fixtures.cli("app").serve_with(["status"]) == 0


def test_reports_unreadable_config_files(tmp_path: Path) -> None:
    cli = incur.Cli("tool", config=incur.Config(flag="config"))

    @cli.command("echo")
    def echo(c: Context) -> int:
        return 1

    # The operating system's message, as TypeScript reports Node's.
    assert serve(cli, "echo", "--config", str(tmp_path)) == snapshot(
        (1, "code: UNKNOWN\nmessage: Is a directory\n")
    )


def test_reports_config_loader_errors() -> None:
    def loader(file: str | None) -> object:
        raise Error("BAD_CONFIG", "config rejected", hint="Fix it.")

    cli = incur.Cli("tool", config=incur.Config(loader=loader))

    @cli.command("echo")
    def echo(c: Context) -> int:
        return 1

    assert serve(cli, "echo", tty=True) == snapshot(
        (1, "Error (BAD_CONFIG): config rejected\nHint: Fix it.\n")
    )


def test_rejects_globals_that_shadow_builtins() -> None:
    @incur.schema
    class Shadow:
        format: str | None = None

    @incur.schema
    class ShortHelp:
        hide: Annotated[bool | None, field(alias="h")] = None

    @incur.schema
    class NoConfig:
        no_config: Annotated[bool | None, field(name="noConfig")] = None

    with pytest.raises(incur.SchemaError, match="'format' conflicts with a built-in flag"):
        incur.Cli("tool", globals=Shadow)
    with pytest.raises(incur.SchemaError, match="'-h' for 'hide' conflicts"):
        incur.Cli("tool", globals=ShortHelp)
    with pytest.raises(incur.SchemaError, match="'noConfig' conflicts"):
        incur.Cli("tool", config=incur.Config(flag="config"), globals=NoConfig)
    assert incur.Cli("tool", globals=NoConfig).name == "tool"


def test_reports_handler_and_middleware_exceptions() -> None:
    cli = incur.Cli("tool")

    @cli.use
    def guard(c: incur.MiddlewareContext, next_: incur.Next) -> None:
        if c.command == "guarded":
            raise KeyError("guarded")
        next_()

    @cli.command("guarded")
    def guarded(c: Context) -> int:
        return 1

    @cli.command("pairs")
    def pairs(c: Context) -> incur.Outcome:
        return incur.ok({1: 2}, cta=CtaBlock(["tool status"]))

    @cli.command("opaque")
    def opaque(c: Context) -> object:
        return object()

    assert [serve(cli, name) for name in ("guarded", "pairs", "opaque")] == snapshot(
        [
            (
                1,
                """\
code: UNKNOWN
message: 'guarded'
""",
            ),
            (
                1,
                """\
code: UNKNOWN
message: key 1 is not a string
cta:
  description: "Suggested command:"
  commands[1]{command}:
    tool status
""",
            ),
            (1, "code: UNKNOWN\nmessage: object is not JSON serializable\n"),
        ]
    )


Stream = Generator[object, None, incur.Outcome | None]


def test_streams_without_suggestions() -> None:
    cli = incur.Cli("tool")

    @cli.command("fail")
    def fail(c: Context) -> Stream:
        yield 1
        raise Error("BROKE", "broke")

    @cli.command("crash")
    def crash(c: Context) -> Stream:
        yield 1
        raise ValueError("crashed")

    @cli.command("done")
    def done(c: Context) -> Stream:
        yield {"a": 1}

    @cli.command("hidden", output_policy="agent-only")
    def hidden(c: Context) -> Stream:
        yield {"a": 1}
        return incur.ok(cta=CtaBlock(["status"]))

    outputs = [
        serve(cli, "fail", "--format", "jsonl"),
        serve(cli, "fail"),
        serve(cli, "crash"),
        serve(cli, "done", "--format", "jsonl")[1].replace(
            serve(cli, "done", "--format", "jsonl")[1].split('"duration":"')[1].split('"')[0],
            "<n>ms",
        ),
        serve(cli, "done"),
        serve(cli, "hidden", tty=True),
    ]
    assert outputs == snapshot(
        [
            (
                1,
                """\
{"type":"chunk","data":1}
{"type":"error","ok":false,"error":{"code":"BROKE","message":"broke"}}
""",
            ),
            (1, "1\nError (BROKE): broke\n"),
            (1, "1\nError: crashed\n"),
            '{"type":"chunk","data":{"a":1}}\n{"type":"done","ok":true,"meta":{"command":"done","duration":"<n>ms"}}\n',
            (0, "a: 1\n"),
            (0, "\nSuggested command:\n  tool status\n"),
        ]
    )


def test_formats_edge_values() -> None:
    app = fixtures.cli("app")
    outputs = [
        serve(app, "data", '{"a": null}', "--filter-output", "a"),
        serve(app, "data", '{"a": null}', "--filter-output", "a", "--full-output", "--json"),
        serve(app, "data", "[1e400, -1e400]", "--json"),
        serve(app, "status", "--full-output", "--token-offset", "1"),
    ]
    outputs = [(code, text.split("duration")[0]) for code, text in outputs]
    assert outputs == snapshot(
        [
            (0, ""),
            (0, '{\n  "ok": true,\n  "data": null,\n  "meta": {\n    "command": "data",\n    "'),
            (0, "[\n  null,\n  null\n]\n"),
            (
                0,
                """\
ok: true
data: ": true\\nbranch: main\\n[truncated: showing tokens 1–6 of 6]"
meta:
  command: status
  \
""",
            ),
        ]
    )


def test_covers_rarely_used_paths() -> None:
    cli = incur.Cli("tool", banner=lambda: None)
    group = incur.Cli("group")

    @group.command("leaf")
    def leaf(c: Context) -> int:
        return 1

    cli.group(group)
    glob = fixtures.cli("globals")
    outputs = [
        serve(cli, tty=True)[1].splitlines()[0],
        serve(cli, "--llms")[1],
        serve(glob, "show", "-n")[1],
    ]
    assert outputs == snapshot(
        [
            "tool",
            """\
# tool

| Command | Description |
|---------|-------------|
| `tool group leaf` |  |

Run `tool --llms-full` for full manifest. Run `tool <command> --schema` for argument details.
""",
            'code: UNKNOWN\nmessage: "Missing value for flag: -n"\n',
        ]
    )


def test_serves_the_process(monkeypatch: pytest.MonkeyPatch) -> None:
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "argv", ["/usr/bin/other", "status"])
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(os, "environ", {})
    with pytest.raises(SystemExit) as exit_info:
        fixtures.cli("app").serve()
    assert exit_info.value.code == 0
    assert stdout.getvalue() == "clean: true\nbranch: main\n"


BIG = {"safe": 9007199254740993, "max": 2**64 - 1, "min": -(2**63)}


def big_cli() -> incur.Cli:
    @incur.schema
    class Options:
        count: Annotated[int | None, field("Count")] = None
        wide: Annotated[int | None, field("Wide", max=2**64)] = None
        ratio: Annotated[float | None, field("Ratio")] = None

    cli = incur.Cli("big", config=incur.Config(loader=lambda path: {"options": {"wide": 2**63}}))

    @cli.root()
    def root(c: Context[None, Options]) -> dict[str, object]:
        return {**BIG, "list": list(BIG.values()), "options": incur.dump(c.options)}

    @cli.command("chunks")
    async def chunks(c: Context) -> AsyncGenerator[object, None]:
        for value in BIG.values():
            yield value

    @cli.command("text")
    def text(c: Context) -> str:
        return '{"max": 18446744073709551615}'

    return cli


def test_keeps_exact_integers_in_every_format() -> None:
    cli = big_cli()
    outputs = [serve(cli, "--format", fmt)[1] for fmt in ("toon", "json", "yaml", "md", "jsonl")]
    assert outputs == snapshot(
        [
            """\
safe: 9007199254740993
max: 18446744073709551615
min: -9223372036854775808
list[3]: 9007199254740993,18446744073709551615,-9223372036854775808
options:
  wide: 9223372036854775808
""",
            """\
{
  "safe": 9007199254740993,
  "max": 18446744073709551615,
  "min": -9223372036854775808,
  "list": [
    9007199254740993,
    18446744073709551615,
    -9223372036854775808
  ],
  "options": {
    "wide": 9223372036854775808
  }
}
""",
            """\
safe: 9007199254740993
max: 18446744073709551615
min: -9223372036854775808
list:
  - 9007199254740993
  - 18446744073709551615
  - -9223372036854775808
options:
  wide: 9223372036854775808
""",
            """\
## safe

9007199254740993

## max

18446744073709551615

## min

-9223372036854775808

## list

9007199254740993,18446744073709551615,-9223372036854775808

## options

| Key  | Value               |
|------|---------------------|
| wide | 9223372036854775808 |
""",
            '{"safe":9007199254740993,"max":18446744073709551615,"min":-9223372036854775808,"list":[9007199254740993,18446744073709551615,-9223372036854775808],"options":{"wide":9223372036854775808}}\n',
        ]
    )


def test_keeps_exact_integers_in_filters_tokens_and_streams() -> None:
    cli = big_cli()
    outputs = [
        serve(cli, "--filter-output", "max,list[1,3]")[1],
        serve(cli, "--token-count")[1],
        serve(cli, "--token-limit", "4")[1],
        serve(cli, "chunks")[1],
        serve(cli, "chunks", "--format", "jsonl")[1].split('"duration"')[0],
        serve(cli, "chunks", "--json")[1],
        serve(cli, "text", "--json")[1],
    ]
    assert outputs == snapshot(
        [
            """\
max: 18446744073709551615
list[2]: 18446744073709551615,-9223372036854775808
""",
            "25\n",
            """\
safe: 9007199254740993
max
[truncated: showing tokens 0–4 of 25]
""",
            """\
9007199254740993
18446744073709551615
-9223372036854775808
""",
            """\
{"type":"chunk","data":9007199254740993}
{"type":"chunk","data":18446744073709551615}
{"type":"chunk","data":-9223372036854775808}
{"type":"done","ok":true,"meta":{"command":"chunks",\
""",
            """\
[
  9007199254740993,
  18446744073709551615,
  -9223372036854775808
]
""",
            """\
{
  "max": 18446744073709551615
}
""",
        ]
    )


def test_reads_exact_integer_options() -> None:
    cli = big_cli()
    outputs = [
        serve(cli, "--wide", "18446744073709551615", "--ratio", "18446744073709551615", "--json"),
        serve(cli, "--count", "9007199254740991", "--filter-output", "options"),
        serve(cli, "--count", "9007199254740993"),
        serve(cli, "--count", "-9007199254740993", "--json"),
        serve(cli, "--count", "1.5"),
    ]
    assert outputs == snapshot(
        [
            (
                0,
                """\
{
  "safe": 9007199254740993,
  "max": 18446744073709551615,
  "min": -9223372036854775808,
  "list": [
    9007199254740993,
    18446744073709551615,
    -9223372036854775808
  ],
  "options": {
    "wide": 18446744073709551615,
    "ratio": 18446744073709552000
  }
}
""",
            ),
            (
                0,
                """\
options:
  count: 9007199254740991
  wide: 9223372036854775808
""",
            ),
            (
                1,
                """\
code: VALIDATION_ERROR
message: "Too big: expected int to be <=9007199254740991\\n\\nDetails: [\\n  {\\n    \\"code\\": \\"too_big\\",\\n    \\"maximum\\": 9007199254740991,\\n    \\"note\\": \\"Integers must be within the safe integer range.\\",\\n    \\"origin\\": \\"int\\",\\n    \\"inclusive\\": true,\\n    \\"path\\": [\\n      \\"count\\"\\n    ],\\n    \\"message\\": \\"Too big: expected int to be <=9007199254740991\\"\\n  }\\n]"
fieldErrors[1]{code,missing,path,expected,received,message}:
  too_big,false,count,"","","Too big: expected int to be <=9007199254740991"
""",
            ),
            (
                1,
                """\
{
  "code": "VALIDATION_ERROR",
  "message": "Too small: expected int to be >=-9007199254740991\\n\\nDetails: [\\n  {\\n    \\"code\\": \\"too_small\\",\\n    \\"minimum\\": -9007199254740991,\\n    \\"note\\": \\"Integers must be within the safe integer range.\\",\\n    \\"origin\\": \\"int\\",\\n    \\"inclusive\\": true,\\n    \\"path\\": [\\n      \\"count\\"\\n    ],\\n    \\"message\\": \\"Too small: expected int to be >=-9007199254740991\\"\\n  }\\n]",
  "fieldErrors": [
    {
      "code": "too_small",
      "missing": false,
      "path": "count",
      "expected": "",
      "received": "",
      "message": "Too small: expected int to be >=-9007199254740991"
    }
  ]
}
""",
            ),
            (
                1,
                """\
code: VALIDATION_ERROR
message: "Invalid input: expected int, received number\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"int\\",\\n    \\"format\\": \\"safeint\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"count\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected int, received number\\"\\n  }\\n]"
fieldErrors[1]{code,missing,path,expected,received,message}:
  invalid_type,false,count,int,"","Invalid input: expected int, received number"
""",
            ),
        ]
    )


@incur.schema
class Session:
    user: str = "anonymous"
    trail: list[str] = []


@incur.schema
class Verbosity:
    verbose: Annotated[bool | None, field("Verbose")] = None


def test_runs_async_handlers_and_middleware() -> None:
    cli = incur.Cli("tool", vars=Session, globals=Verbosity)

    @cli.use
    async def outer(
        c: incur.MiddlewareContext[Session, None, Verbosity], next_: incur.Next
    ) -> None:
        c.var.trail.append("async before")
        await next_()
        c.var.trail.append("async after")

    @cli.use
    def inner(c: incur.MiddlewareContext[Session], next_: incur.Next) -> None:
        c.var.trail.append("sync before")
        next_()
        c.var.trail.append(f"sync after: {c.var.trail[-1]}")

    seen: list[Session] = []

    @cli.command("whoami")
    async def whoami(c: Context[None, None, None, Session, Verbosity]) -> dict[str, object]:
        typing.assert_type(c.var, Session)
        typing.assert_type(c.globals, Verbosity)
        await asyncio.sleep(0)
        c.var.trail.append("handler")
        seen.append(c.var)
        return {"user": c.var.user, "verbose": c.globals.verbose}

    @cli.command("count")
    def count(c: Context) -> Stream:
        yield 1
        yield incur.ok(cta=CtaBlock(["whoami"]))
        yield 2

    async def main() -> list[tuple[int, str]]:
        # `run` works inside a running event loop, where `serve_with` cannot.
        outputs: list[tuple[int, str]] = []
        for argv in (["whoami", "--verbose"], ["count"]):
            out = io.StringIO()
            outputs.append((await cli.run(argv, stdout=out), out.getvalue()))
        return outputs

    assert asyncio.run(main()) == snapshot(
        [
            (
                0,
                """\
user: anonymous
verbose: true
""",
            ),
            (
                0,
                """\
1

Suggested command:
  tool whoami
""",
            ),
        ]
    )
    assert seen[0].trail == snapshot(
        ["async before", "sync before", "handler", "sync after: handler", "async after"]
    )


def test_nests_plain_middleware_beyond_thread_pools() -> None:
    cli = incur.Cli("tool", vars={"depth": 0})
    for _ in range(64):
        cli.use(lambda c, next_: c.set("depth", c.var["depth"] + 1) or next_())

    @cli.command("depth")
    def depth(c: Context) -> int:
        return c.var["depth"]

    assert serve(cli, "depth") == snapshot((0, "64\n"))


def test_awaits_loaders_and_banners() -> None:
    async def loader(path: str | None) -> object:
        await asyncio.sleep(0)
        return {"commands": {"echo": {"options": {"text": "loaded"}}}}

    async def banner() -> str:
        return "Async banner"

    @incur.schema
    class EchoOptions:
        text: str = ""

    cli = incur.Cli("tool", config=incur.Config(loader=loader), banner=banner)

    @cli.command("echo")
    def echo(c: Context[None, EchoOptions]) -> str:
        return c.options.text

    assert [serve(cli, "echo"), serve(cli, tty=True)[1].splitlines()[0]] == snapshot(
        [(0, "loaded\n"), "Async banner"]
    )


def test_serves_the_process_inside_a_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    stdout = io.StringIO()
    monkeypatch.setattr(sys, "argv", ["app", "whoami"])
    monkeypatch.setattr(sys, "stdout", stdout)
    monkeypatch.setattr(os, "environ", {"APP_USER": "root"})
    assert asyncio.run(fixtures.cli("app").serve_async()) == 0
    assert stdout.getvalue() == "user: root\n"


def test_rejects_mismatched_state_classes() -> None:
    @incur.schema
    class Other:
        user: str = ""

    cli = incur.Cli("tool", vars=Session, globals=Verbosity)
    with pytest.raises(incur.SchemaError, match="Context vars must be Session, the CLI's vars"):

        @cli.command("vars")
        def wrong_vars(c: Context[None, None, None, Other]) -> None: ...

    with pytest.raises(incur.SchemaError, match="Context globals must be Verbosity"):

        @cli.command("globals")
        def wrong_globals(c: Context[None, None, None, Session, Other]) -> None: ...
