"""Python-only behavior that the differential suite cannot compare with TypeScript: built-ins this
port does not implement, process I/O defaults, handler and middleware failures, and inputs the
TypeScript reference treats differently by design.
"""

from __future__ import annotations

import io
import os
import sys
from collections.abc import Generator
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


def test_reports_unsupported_builtins() -> None:
    cli = incur.Cli("tool", version="1.0.0")
    outputs = [serve(cli, *argv) for argv in (["--mcp"], ["skills", "add"], ["mcp", "add"])]
    assert outputs == snapshot(
        [
            (
                1,
                "code: UNSUPPORTED\nmessage: '--mcp' is not supported by the Python port of incur yet.\n",
            ),
            (
                1,
                "code: UNSUPPORTED\nmessage: 'skills add' is not supported by the Python port of incur yet.\n",
            ),
            (
                1,
                "code: UNSUPPORTED\nmessage: 'mcp add' is not supported by the Python port of incur yet.\n",
            ),
        ]
    )
    assert serve(cli, "--mcp", tty=True) == snapshot(
        (1, "Error (UNSUPPORTED): '--mcp' is not supported by the Python port of incur yet.\n")
    )


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
    huge = "1" + "0" * 400
    outputs = [
        serve(app, "data", '{"a": null}', "--filter-output", "a"),
        serve(app, "data", '{"a": null}', "--filter-output", "a", "--full-output", "--json"),
        serve(app, "data", f"[9007199254740993, {huge}, -{huge}]", "--json"),
        serve(app, "status", "--full-output", "--token-offset", "1"),
    ]
    outputs = [(code, text.split("duration")[0]) for code, text in outputs]
    assert outputs == snapshot(
        [
            (0, ""),
            (0, '{\n  "ok": true,\n  "data": null,\n  "meta": {\n    "command": "data",\n    "'),
            (0, "[\n  9007199254740992,\n  null,\n  null\n]\n"),
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
