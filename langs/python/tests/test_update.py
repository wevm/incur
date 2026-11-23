"""Update checks and `--update`: scheduling the detached refresh, asynchronous installers, and
package managers that cannot start.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
from inline_snapshot import snapshot

import incur
from incur import Context


def kit(update: incur.Update) -> incur.Cli:
    cli = incur.Cli("kit", version="1.0.0", update=update)

    @cli.command("ping")
    def ping(c: Context) -> str:
        return "pong"

    return cli


def serve(cli: incur.Cli, env: dict[str, str], *argv: str, tty: bool = False) -> tuple[int, str]:
    stdout = io.StringIO()
    code = cli.serve_with(argv, env=env, stdout=stdout, tty=tty)
    return code, stdout.getvalue()


def test_schedules_refreshes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def latest(c: incur.UpdateCheck) -> str:
        return "2.0.0"

    cli = kit(incur.Update(check=latest, interval=0))
    env = {"HOME": str(tmp_path)}
    entry = tmp_path / "entry.py"
    entry.write_text("")
    cache = tmp_path / ".cache" / "incur" / "updates" / "kit.json"
    monkeypatch.setattr(sys, "argv", [""])
    assert serve(cli, env, "ping", tty=True) == (0, "pong\n")
    assert not cache.exists()
    monkeypatch.setattr(sys, "argv", [str(entry)])
    assert serve(cli, env, "ping", tty=True) == (0, "pong\n")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    cache.write_text('{"checkedAt": 0, "latest": "1.5.0"}')
    assert serve(cli, env, "ping", tty=True) == snapshot(
        (
            0,
            """\
pong

Update available for kit:
  kit --update  # upgrade from 1.0.0 to 1.5.0
""",
        )
    )
    assert sorted(cache.parent.iterdir()) == [cache]


def test_async_installers(tmp_path: Path) -> None:
    installed: list[str | None] = []

    async def install(c: incur.UpdateInstall) -> None:
        installed.append(c.latest)

    cli = kit(incur.Update(install=install))
    assert serve(cli, {"HOME": str(tmp_path)}, "--update") == snapshot((0, "name: kit\n"))
    assert installed == [None]


def test_missing_package_managers(tmp_path: Path) -> None:
    cli = kit(incur.Update(package="kit"))
    assert serve(cli, {"HOME": str(tmp_path), "PATH": str(tmp_path)}, "--update") == snapshot(
        (
            1,
            """\
code: UPDATE_FAILED
message: spawn npm ENOENT
""",
        )
    )
