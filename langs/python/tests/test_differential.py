"""Differential test: replays every case in `langs/differential/cases.json` against the TypeScript
reference implementation and this port, and requires identical stdout, stderr, and exit codes.
Durations are the only normalized values.

Cases with a `bin` run in a child process started through a link with that name, so the process
entry point `Cli.serve` reads its real arguments, environment, and binary name.

Requires Node.js and the repository's `pnpm install`.
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import fixtures

TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parents[2]
DIFFERENTIAL = ROOT / "langs" / "differential"
DURATION = re.compile(r"(?<![A-Za-z0-9])[0-9]+ms(?![A-Za-z0-9])", re.ASCII)

ENTRY = f"""#!{sys.executable}
import os
import sys

sys.path.insert(0, {str(TESTS)!r})
import fixtures

fixtures.cli(os.environ["INCUR_FIXTURE"]).serve()
"""


def normalize(text: str) -> str:
    """Replaces durations such as `12ms` with `<n>ms`."""
    return DURATION.sub("<n>ms", text)


def spawn(links: Path, case: dict[str, Any]) -> tuple[int, str, str]:
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
    return result.returncode, result.stdout, result.stderr


def serve(case: dict[str, Any]) -> tuple[int, str, str]:
    """Serves a case in this process with injected I/O."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = fixtures.cli(case["cli"]).serve_with(
        case["argv"],
        env=case.get("env", {}),
        stdout=stdout,
        stderr=stderr,
        tty=case.get("tty", False),
    )
    return code, stdout.getvalue(), stderr.getvalue()


def test_matches_typescript(tmp_path: Path, monkeypatch: Any) -> None:
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

    # Config fixtures use paths relative to the differential directory.
    monkeypatch.chdir(DIFFERENTIAL)
    entry = tmp_path / "entry.py"
    entry.write_text(ENTRY, "utf-8")
    entry.chmod(0o755)

    failures: list[str] = []
    for index, (case, want) in enumerate(zip(cases, expected, strict=True)):
        exit_code, stdout, stderr = spawn(tmp_path, case) if "bin" in case else serve(case)
        actual = (exit_code, normalize(stdout), normalize(stderr))
        wanted = (want["exit"], normalize(want["stdout"]), normalize(want["stderr"]))
        if actual != wanted:
            failures.append(
                f"case {index}: {case['cli']} {case['argv']!r} env={case.get('env', {})!r} "
                f"tty={case.get('tty', False)}\n"
                f"--- expected (exit {wanted[0]})\n{wanted[1]}{wanted[2]}\n"
                f"--- actual (exit {actual[0]})\n{actual[1]}{actual[2]}"
            )
    dump = os.environ.get("INCUR_DIFFERENTIAL_DUMP")
    if dump:
        Path(dump).write_text("\n\n=====\n\n".join(failures), "utf-8")
    shown = "\n\n".join(failures[:15])
    assert not failures, f"{len(failures)} of {len(cases)} cases differ:\n\n{shown}"
