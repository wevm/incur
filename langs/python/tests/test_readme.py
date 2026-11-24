"""Runs the README: every Python example executes, and every shell command followed by `# →`
lines prints exactly those lines. A command runs the `main` its preceding example defines, with
the process arguments, or else serves its `cli`. An example without imports continues the
previous one.
"""

from __future__ import annotations

import contextlib
import io
import os
import re
import shlex
import sys
import types
from pathlib import Path
from typing import Any

import pytest

import incur

README = Path(__file__).parent.parent / "README.md"


def blocks() -> list[tuple[str, str]]:
    """Returns the README's fenced code blocks as `(language, code)` pairs."""
    return re.findall(r"^```(\w*)\n(.*?)^```$", README.read_text(), re.M | re.S)


def commands(code: str) -> list[tuple[str, list[str]]]:
    """Returns each `$ command` of a shell block with its expected `# →` output lines."""
    out: list[tuple[str, list[str]]] = []
    for line in code.splitlines():
        if line.startswith("$ "):
            out.append((line[2:], []))
        elif line.startswith("# →") and out:
            out[-1][1].append(line[4:])
    return [(command, expected) for command, expected in out if expected]


def test_readme(monkeypatch: pytest.MonkeyPatch) -> None:
    namespace: dict[str, Any] = {}
    checked = 0
    for index, (language, code) in enumerate(blocks()):
        if language == "python":
            if re.search(r"^(import|from) ", code, re.M):
                # A registered module, as dataclasses and annotations resolve through it.
                module = types.ModuleType(f"readme_{index}")
                monkeypatch.setitem(sys.modules, module.__name__, module)
                namespace = module.__dict__
            exec(compile(code, str(README), "exec"), namespace)
        elif language == "sh":
            for command, expected in commands(code):
                assert run(namespace, shlex.split(command), monkeypatch) == expected, command
                checked += 1
    assert checked >= 10


def run(namespace: dict[str, Any], argv: list[str], monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Runs an example's `main` with `argv` as the process arguments, or serves its `cli`."""
    stdout = io.StringIO()
    if "main" not in namespace:
        cli: incur.Cli = namespace["cli"]
        cli.serve_with(argv[1:], stdout=stdout)
        return stdout.getvalue().splitlines()
    with monkeypatch.context() as patch:
        patch.setattr(sys, "argv", argv)
        patch.setattr(sys, "stdout", stdout)
        patch.setattr(os, "environ", {})
        with contextlib.suppress(SystemExit):
            namespace["main"]()
    return stdout.getvalue().splitlines()
