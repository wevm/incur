"""Runs the README: every Python example executes, and every shell command followed by `# →`
lines runs against the `cli` its preceding example defines and prints exactly those lines.
"""

from __future__ import annotations

import io
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
            # A registered module, as dataclasses and annotations resolve through it.
            module = types.ModuleType(f"readme_{index}")
            monkeypatch.setitem(sys.modules, module.__name__, module)
            exec(compile(code, str(README), "exec"), module.__dict__)
            namespace = module.__dict__
        elif language == "sh":
            cli: incur.Cli = namespace["cli"]
            for command, expected in commands(code):
                stdout = io.StringIO()
                cli.serve_with(shlex.split(command)[1:], stdout=stdout)
                assert stdout.getvalue().splitlines() == expected, command
                checked += 1
    assert checked >= 10
