"""Differential test: replays every case in `langs/differential/cases.json` against the TypeScript
reference implementation and this port, and requires identical stdout, stderr, exit codes, and
sandbox files. Mirrors `langs/differential/run.ts`.

Cases with a `bin` and no `sandbox` run in a child process started through a link with that name,
so the process entry point `Cli.serve` reads its real arguments, environment, and binary name.

Cases with a `sandbox` run isolated, as `langs/README.md` describes: fresh fixture CLIs, a reset
sandbox directory as `HOME` and working directory, an environment of only `HOME`, `PATH` (stub
package-manager runners), `TMPDIR`, and the case's variables, `stdin` fed to `--mcp`, and
`requests` sent to `Cli.fetch`.

Requires Node.js and the repository's `pnpm install`.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

import fixtures

import incur

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parents[2]
DIFFERENTIAL = ROOT / "langs" / "differential"
DURATION = re.compile(r"(?<![A-Za-z0-9])[0-9]+ms(?![A-Za-z0-9])", re.ASCII)
TIME = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z")
CHECKED = re.compile(r'"checkedAt":\d+')

ENTRY = f"""#!{sys.executable}
import os
import sys

sys.path.insert(0, {str(TESTS)!r})
import fixtures

fixtures.cli(os.environ["INCUR_FIXTURE"]).serve()
"""

STUB = """#!/bin/sh
{ printf '%s' "${0##*/}"; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$HOME/stub.log"
printf '%s' "$STUB_STDERR" >&2
printf '%s' "$STUB_STDOUT"
exit "${STUB_EXIT:-0}"
"""

Entry = str | None | dict[str, str]


def normalize(text: str) -> str:
    """Replaces durations such as `12ms` with `<n>ms`."""
    return DURATION.sub("<n>ms", text)


class Sandbox:
    """The root of sandboxed cases: `home` (HOME and working directory), `bin`, and `tmp`."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.home = root / "home"
        self.bin = root / "bin"
        self.tmp = root / "tmp"
        self.bin.mkdir()
        self.tmp.mkdir()
        for name in ("bun", "bunx", "npm", "npx", "pnpm", "pnpx"):
            stub = self.bin / name
            stub.write_text(STUB, "utf-8")
            stub.chmod(0o755)

    def expand(self, text: str) -> str:
        """Replaces `<sandbox>` and `<root>` placeholders with their real paths."""
        return text.replace("<sandbox>", str(self.home)).replace("<root>", str(self.root))

    def normalize(self, text: str) -> str:
        """Replaces real sandbox paths and timestamps with placeholders."""
        text = text.replace(str(self.home), "<sandbox>").replace(str(self.root), "<root>")
        return CHECKED.sub('"checkedAt":0', TIME.sub("<time>", text))

    def reset(self, seed: dict[str, Entry]) -> None:
        """Empties the sandbox and seeds it."""
        shutil.rmtree(self.home, ignore_errors=True)
        self.home.mkdir()
        for name, value in seed.items():
            target = self.home / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if value is None:
                target.mkdir(parents=True, exist_ok=True)
            elif isinstance(value, str):
                target.write_text(self.expand(value), "utf-8")
            else:
                target.symlink_to(self.expand(value["symlink"]))

    def tree(self) -> dict[str, Entry]:
        """Lists every entry under the sandbox, sorted by path, with normalized contents."""
        entries: dict[str, Entry] = {}

        def visit(relative: str) -> None:
            for name in os.listdir(self.home / relative):
                child = f"{relative}/{name}" if relative else name
                path = self.home / child
                if path.is_symlink():
                    entries[child] = {"symlink": self.normalize(os.readlink(path))}
                elif path.is_dir():
                    entries[child] = None
                    visit(child)
                else:
                    text = path.read_bytes().decode("utf-8", "replace")
                    entries[child] = metadata(self.normalize(text))

        visit("")
        return dict(sorted(entries.items(), key=lambda e: e[0].encode("utf-16-be")))


def metadata(text: str) -> str:
    """Sorts the `skills` and `paths` of a skills metadata file, as the reference does."""
    try:
        value = json.loads(text)
    except ValueError:
        return text
    if not isinstance(value, dict):
        return text
    data = cast("dict[str, Any]", value)
    skills, paths = data.get("skills"), data.get("paths")
    if not (isinstance(data.get("hash"), str) and isinstance(skills, list)):
        return text
    data["skills"] = sorted(cast("list[object]", skills), key=utf16)
    if isinstance(paths, list):
        data["paths"] = sorted(cast("list[object]", paths), key=utf16)
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n"


def utf16(value: object) -> bytes:
    """Orders strings by UTF-16 code units, as JavaScript's default sort does."""
    return str(value).encode("utf-16-be")


@contextmanager
def patched(**values: Any) -> Generator[None, None, None]:
    """Temporarily replaces `sys` attributes."""
    saved = {name: getattr(sys, name) for name in values}
    for name, value in values.items():
        setattr(sys, name, value)
    try:
        yield
    finally:
        for name, value in saved.items():
            setattr(sys, name, value)


async def send(cli: incur.Cli, requests: list[dict[str, Any]]) -> str:
    """Sends requests to `cli.fetch` in order and renders each response."""
    session: str | None = None
    out = ""
    for r in requests:
        headers = {
            key: (session or "") if value == "<session>" else value
            for key, value in r.get("headers", {}).items()
        }
        body = r.get("body")
        if body is not None and not isinstance(body, str):
            body = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
        url = r["url"] if r["url"].startswith("http") else f"http://localhost{r['url']}"
        response = await cli.fetch(
            incur.Request(url, method=r.get("method", "GET"), headers=headers, body=body)
        )
        session = response.headers.get("mcp-session-id") or session
        out += f"HTTP {response.status}\n"
        for key, value in response.headers.items():
            out += f"{key}: {'<session>' if key == 'mcp-session-id' else value}\n"
        out += f"\n{await response.text()}\n"
    return out


def run_sandboxed(sandbox: Sandbox, case: dict[str, Any]) -> dict[str, Any]:
    """Serves a case, or sends its requests, in a fresh sandbox with fresh fixture CLIs."""
    sandbox.reset(case["sandbox"])
    env = {
        "HOME": str(sandbox.home),
        "PATH": str(sandbox.bin),
        "TMPDIR": str(sandbox.tmp),
        **{key: sandbox.expand(value) for key, value in case.get("env", {}).items()},
    }
    lines = [
        line if isinstance(line, str) else json.dumps(line, separators=(",", ":"))
        for line in case.get("stdin", [])
    ]
    stdin = io.StringIO("".join(f"{line}\n" for line in lines))
    output = io.StringIO()
    errors = io.StringIO()
    previous = Path.cwd()
    os.chdir(sandbox.home)
    program = str(sandbox.home / case.get("bin", "cli"))
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)
    try:
        with patched(argv=[program], stderr=errors, stdin=stdin):
            cli = fixtures.cli(case["cli"])
            if "requests" in case:
                code = 0
                output.write(asyncio.run(send(cli, case["requests"])))
            else:
                code = cli.serve_with(
                    case["argv"],
                    env=env,
                    stdout=output,
                    stderr=errors,
                    stdin=stdin,
                    tty=case.get("tty", False),
                )
    finally:
        os.chdir(previous)
        os.environ.clear()
        os.environ.update(saved)
    return {
        "exit": code,
        "files": sandbox.tree(),
        "stderr": sandbox.normalize(errors.getvalue()),
        "stdout": sandbox.normalize(output.getvalue()),
    }


def spawn(links: Path, case: dict[str, Any]) -> dict[str, Any]:
    """Serves a case in a child process started through a link named after the case's `bin`."""
    assert not case.get("tty"), "cases with a `bin` cannot emulate a terminal"
    link = links / case["bin"]
    if not link.exists():
        link.symlink_to(links / "entry.py")
    env = {"INCUR_FIXTURE": case["cli"], **case.get("env", {})}
    # Coverage runs collect data from child processes too.
    env.update({k: v for k, v in os.environ.items() if k.startswith("COVERAGE_")})
    result = subprocess.run(  # noqa: PLW1510 - the exit code is part of the outcome.
        [str(link), *case["argv"]], env=env, capture_output=True, text=True, encoding="utf-8"
    )
    return {"exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def serve(case: dict[str, Any]) -> dict[str, Any]:
    """Serves a case in this process with injected I/O."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    previous = Path.cwd()
    # Config fixtures use paths relative to the differential directory.
    os.chdir(DIFFERENTIAL)
    try:
        code = fixtures.cli(case["cli"]).serve_with(
            case["argv"],
            env=case.get("env", {}),
            stdout=stdout,
            stderr=stderr,
            tty=case.get("tty", False),
        )
    finally:
        os.chdir(previous)
    return {"exit": code, "stdout": stdout.getvalue(), "stderr": stderr.getvalue()}


def run_case(case: dict[str, Any], links: Path, sandbox: Sandbox) -> dict[str, Any]:
    """Runs a case as the reference harness does."""
    if "sandbox" in case:
        return run_sandboxed(sandbox, case)
    return spawn(links, case) if "bin" in case else serve(case)


def describe(index: int, case: dict[str, Any], want: dict[str, Any], got: dict[str, Any]) -> str:
    """Renders a differing case."""

    def render(result: dict[str, Any]) -> str:
        files = "".join(f"  {k}: {json.dumps(v)}\n" for k, v in result.get("files", {}).items())
        return (
            f"(exit {result['exit']})\n{normalize(result['stdout'])}"
            f"--- stderr\n{normalize(result['stderr'])}" + (f"--- files\n{files}" if files else "")
        )

    return (
        f"case {index}: {json.dumps(case, ensure_ascii=False)}\n"
        f"--- expected {render(want)}\n--- actual {render(got)}"
    )


def matches(want: dict[str, Any], got: dict[str, Any]) -> bool:
    """Compares results after normalizing durations."""
    return all(
        normalize(want[key]) == normalize(got[key]) if key != "exit" else want[key] == got[key]
        for key in ("exit", "stdout", "stderr")
    ) and want.get("files") == got.get("files")


def test_matches_typescript(tmp_path: Path) -> None:
    cases: list[dict[str, Any]] = json.loads((DIFFERENTIAL / "cases.json").read_text("utf-8"))
    reference = subprocess.run(
        ["node", "--no-warnings", "--import", "tsx", "langs/differential/run.ts"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert reference.returncode == 0, f"reference run failed: {reference.stderr}"
    expected: list[dict[str, Any]] = json.loads(reference.stdout)
    assert len(expected) == len(cases)

    entry = tmp_path / "entry.py"
    entry.write_text(ENTRY, "utf-8")
    entry.chmod(0o755)
    sandbox = Sandbox(Path(os.path.realpath(tempfile.mkdtemp(prefix="incur-differential-"))))

    failures: list[str] = []
    try:
        for index, (case, want) in enumerate(zip(cases, expected, strict=True)):
            got = run_case(case, tmp_path, sandbox)
            if not matches(want, got):
                failures.append(describe(index, case, want, got))
    finally:
        shutil.rmtree(sandbox.root, ignore_errors=True)
    dump = os.environ.get("INCUR_DIFFERENTIAL_DUMP")
    if dump:
        Path(dump).write_text("\n\n=====\n\n".join(failures), "utf-8")
    shown = "\n\n".join(failures[:15])
    assert not failures, f"{len(failures)} of {len(cases)} cases differ:\n\n{shown}"
