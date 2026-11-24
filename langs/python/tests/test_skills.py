"""`skills add` and `skills list` against real file systems: agent links, included skill files,
re-syncs that remove stale skills, and the package root that global syncs resolve from.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from inline_snapshot import snapshot

import incur
from incur import Context


def kit(
    tmp_path: Path, *commands: str, depth: float = 1, include: list[str] | None = None
) -> incur.Cli:
    """A CLI with the given commands that syncs skills from `tmp_path`."""
    sync = incur.Sync(cwd=str(tmp_path), depth=depth, include=include or [])
    cli = incur.Cli("kit", description="A kit", update=False, sync=sync)
    for name in commands:

        @cli.command(name, description=f"Run {name}")
        def run(c: Context) -> str:
            return "ok"

    return cli


def serve(cli: incur.Cli, home: Path, *argv: str) -> tuple[int, str]:
    stdout = io.StringIO()
    code = cli.serve_with(argv, env={"HOME": str(home)}, stdout=stdout)
    return code, stdout.getvalue().replace(str(home), "<home>")


def tree(root: Path) -> list[str]:
    """Lists the files and symlinks under `root`, relative to it."""
    out: list[str] = []
    for directory, dirs, files in os.walk(root):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            if path.is_symlink():
                out.append(f"{path.relative_to(root)} -> {os.readlink(path)}")
            elif path.is_file():
                out.append(str(path.relative_to(root)))
    return sorted(out)


def test_links_agents_and_removes_stale_skills(tmp_path: Path) -> None:
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".cursor").mkdir()
    # Windsurf's skills directory already is the canonical one, so it needs no link.
    (home / ".agents" / "skills").mkdir(parents=True)
    (home / ".codeium" / "windsurf").mkdir(parents=True)
    (home / ".codeium" / "windsurf" / "skills").symlink_to("../../.agents/skills")
    project = tmp_path / "project"
    project.mkdir()
    assert serve(kit(project, "a", "b"), home, "skills", "add")[0] == 0
    assert serve(kit(project, "a"), home, "skills", "add")[0] == 0
    assert tree(home) == snapshot(
        [
            ".agents/skills/kit-a/SKILL.md",
            ".claude/skills/kit-a -> ../../.agents/skills/kit-a",
            ".codeium/windsurf/skills -> ../../.agents/skills",
            ".local/share/incur/kit.json",
        ]
    )


def test_includes_skill_files(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    project = tmp_path / "project"
    (project / "skills" / "extra").mkdir(parents=True)
    (project / "skills" / "extra" / "SKILL.md").write_text("---\ndescription: Extra\n---\n")
    (project / "SKILL.md").write_text("---\nname: kit\ndescription: Root\n---\n")
    # Frontmatter that does not parse skips the file.
    (project / "skills" / "bad").mkdir()
    (project / "skills" / "bad" / "SKILL.md").write_text('---\ndescription: "\\q"\n---\n')
    cli = kit(project, "a", depth=0, include=["_root", "skills/*"])
    assert serve(cli, home, "skills", "add")[0] == 0
    assert serve(cli, home, "skills", "list") == snapshot(
        (
            0,
            """\
  ✓ extra  Extra
  ✓ kit    A kit. Run `kit --help` for usage details.

2 skills (2 installed)
""",
        )
    )
    assert tree(home / ".agents") == snapshot(["skills/extra/SKILL.md", "skills/kit/SKILL.md"])


def test_resolves_the_package_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    home.mkdir()
    package = tmp_path / "package"
    (package / "bin").mkdir(parents=True)
    (package / "package.json").write_text("{}")
    (package / "SKILL.md").write_text("---\nname: packaged\n---\n")
    entry = package / "bin" / "kit"
    entry.write_text("")
    cli = incur.Cli("kit", update=False, sync=incur.Sync(include=["_root"]))

    @cli.command("a")
    def a(c: Context) -> str:
        return "a"

    loose = tmp_path / "loose"
    loose.write_text("")
    for argv0, cwd in ((str(entry), tmp_path), ("", package), (str(loose), package)):
        monkeypatch.setattr(sys, "argv", [argv0])
        monkeypatch.chdir(cwd)
        assert serve(cli, home, "skills", "add")[0] == 0
        assert (home / ".agents" / "skills" / "packaged" / "SKILL.md").exists()


def stub(tmp_path: Path, output: str) -> dict[str, str]:
    """An environment whose `npx` prints `output` and records its arguments."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    npx = bin_dir / "npx"
    npx.write_text(f'#!/bin/sh\necho "$@" >> "{tmp_path}/calls"\nprintf "{output}"\n')
    npx.chmod(0o755)
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    return {"HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin"}


def mcp_add(cli: incur.Cli, env: dict[str, str], *argv: str) -> tuple[int, str]:
    stdout = io.StringIO()
    code = cli.serve_with(["mcp", "add", *argv], env=env, stdout=stdout)
    return code, stdout.getvalue()


def test_mcp_add_commands(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env = stub(tmp_path, "│ ✓ Cursor: added\\n✓ \\n")
    cli = incur.Cli("kit", update=False)
    monkeypatch.setattr(sys, "argv", [""])
    assert mcp_add(cli, env, "--agent", "cursor") == snapshot(
        (
            0,
            """\
Registering MCP server...\r\x1b[K✓ Registered kit as MCP server
  Agents: Cursor

Agents can now use kit tools.
""",
        )
    )
    modules = tmp_path / "app"
    entry = modules / "node_modules" / "kit" / "bin.js"
    entry.parent.mkdir(parents=True)
    for manifest in ("[]", '{"dependencies": {}}'):
        (modules / "package.json").write_text(manifest)
        monkeypatch.setattr(sys, "argv", [str(entry)])
        assert mcp_add(cli, env, "--agent", "cursor")[0] == 0
    assert (tmp_path / "calls").read_text() == snapshot("""\
add-mcp npx kit --mcp --name kit -y -g -a cursor
add-mcp kit --mcp --name kit -y -g -a cursor
add-mcp kit --mcp --name kit -y -g -a cursor
""")


def test_mcp_add_through_windows_command_scripts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On Windows, `npx.cmd` runs through `cmd.exe` with each argument quoted for batch files."""
    (tmp_path / "npx").write_text("")
    (tmp_path / "npx.cmd").write_text("")
    calls: list[tuple[str, str | None]] = []

    def run(line: str, **kwargs: str) -> subprocess.CompletedProcess[bytes]:
        calls.append((line, kwargs["executable"]))
        return subprocess.CompletedProcess(line, 0, "│ ✓ Codex: added\n".encode(), b"")

    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "argv", [""])
    monkeypatch.setattr(subprocess, "run", run)
    env = {
        "COMSPEC": "C:\\Windows\\system32\\cmd.exe",
        "HOME": str(tmp_path),
        "PATH": f'"{tmp_path}";',
        "PATHEXT": ".exe;.cmd",
    }
    cli = incur.Cli("kit", update=False)
    agents = ["a&b|c^d", "100%", "%PATH%", 'say "hi"', 'a\\"b', "dir\\", "café"]
    argv = [arg for agent in agents for arg in ("--agent", agent)]
    assert mcp_add(cli, env, *argv)[0] == 0
    assert mcp_add(cli, {**env, "PATH": f";{tmp_path / 'none'}"}, "--agent", "codex") == snapshot(
        (1, "Registering MCP server...code: MCP_ADD_FAILED\nmessage: spawn npx ENOENT\n")
    )
    assert mcp_add(cli, env, "--agent", "a\nb") == snapshot(
        (1, "Registering MCP server...code: MCP_ADD_FAILED\nmessage: spawn npx EINVAL\n")
    )
    script = tmp_path / "npx.cmd"
    assert calls == [
        (
            f'cmd.exe /e:ON /v:OFF /d /c ""{script}" add-mcp "npx kit --mcp" --name kit -y -g'
            ' -a "a&b|c^d" -a "100%%cd:~,%" -a "%%cd:~,%PATH%%cd:~,%" -a "say ""hi"""'
            ' -a "a\\\\""b" -a "dir\\\\" -a café"',
            "C:\\Windows\\system32\\cmd.exe",
        )
    ]


@pytest.mark.skipif(sys.platform == "win32", reason="stands a POSIX script in for bunx.exe")
def test_mcp_add_through_windows_executables(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """On Windows, a runner installed as an executable, such as `bunx.exe`, runs directly."""
    bunx = tmp_path / "bunx.exe"
    bunx.write_text(f'#!/bin/sh\necho "$@" > "{tmp_path}/calls"\necho "│ ✓ Codex: added"\n')
    bunx.chmod(0o755)
    (tmp_path / "bunx.cmd").write_text("")
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "argv", [""])
    env = {
        "HOME": str(tmp_path),
        "PATH": str(tmp_path),
        "PATHEXT": ".exe;.cmd",
        "npm_config_user_agent": "bun/1.0.0",
    }
    cli = incur.Cli("kit", update=False)
    assert mcp_add(cli, env, "--agent", "codex") == snapshot(
        (
            0,
            """\
Registering MCP server...\r\x1b[K✓ Registered kit as MCP server
  Agents: Codex

Agents can now use kit tools.
""",
        )
    )
    assert (tmp_path / "calls").read_text() == "add-mcp bunx kit --mcp --name kit -y -g -a codex\n"


@pytest.mark.skipif(sys.platform != "win32", reason="runs a real Windows command script")
def test_mcp_add_through_a_real_windows_command_script(tmp_path: Path) -> None:
    """Arguments reach an npm-style `npx.cmd`, which forwards `%*` to its program, intact."""
    record = tmp_path / "record.py"
    record.write_text(
        "import json, os, sys\n"
        "open(os.environ['INCUR_CALLS'], 'w').write(json.dumps(sys.argv[1:]))\n"
    )
    (tmp_path / "npx.cmd").write_text(
        f'@ECHO off\r\n"{sys.executable}" "%~dp0\\record.py" %*\r\n', newline=""
    )
    env = {**os.environ, "HOME": str(tmp_path), "INCUR_CALLS": str(tmp_path / "calls")}
    env["PATH"] = f"{tmp_path};{env['PATH']}"
    agents = ["a&b|c<d>e^f", "100%", "%PATH%", "!bang! (x) ;semi, comma", 'q\\"uote', "dir\\"]
    argv = [arg for agent in agents for arg in ("--agent", agent)]
    code, output = mcp_add(incur.Cli("kit", update=False), env, *argv)
    assert code == 0, output
    calls = json.loads((tmp_path / "calls").read_text())
    assert calls[6:] == [arg for agent in agents for arg in ("-a", agent)]


def test_mcp_add_to_amp(tmp_path: Path) -> None:
    env = stub(tmp_path, "")
    outputs: list[tuple[int, str]] = []
    for command in ("kit serve ", " "):
        cli = incur.Cli("kit", update=False, mcp=incur.McpOptions(command=command, agents=["amp"]))
        outputs.append(mcp_add(cli, env, "--format", "json"))
    assert outputs == snapshot(
        [
            (
                0,
                """\
{
  "name": "kit",
  "command": "kit serve ",
  "agents": [
    "Amp"
  ]
}
""",
            ),
            (
                0,
                """\
{
  "name": "kit",
  "command": " ",
  "agents": []
}
""",
            ),
        ]
    )
    settings = Path(env["HOME"]) / ".config" / "amp" / "settings.json"
    assert settings.read_text() == snapshot("""\
{
  "amp.mcpServers": {
    "kit": {
      "command": "kit",
      "args": [
        "serve"
      ]
    }
  }
}
""")


def test_lists_skills(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    home.mkdir()
    cli = incur.Cli("kit", update=False, sync=incur.Sync(cwd=str(tmp_path)))

    @cli.command("ping", description="Line one\nLine two")
    def ping(c: Context) -> str:
        return "pong"

    # A block scalar description in the frontmatter lists as written.
    assert serve(cli, home, "skills", "list") == snapshot(
        (
            0,
            """\
  ✗ kit-ping  Line one
Line two. Run `kit ping --help` for usage details.

1 skill (0 installed)
""",
        )
    )
    assert serve(cli, home, "skills", "add")[0] == 0
    # Up-to-date skills add no notice.
    assert serve(cli, home, "ping") == (0, "pong\n")
    empty = incur.Cli("kit", update=False, sync=incur.Sync(cwd=str(tmp_path)))
    assert serve(empty, home, "skills", "list") == snapshot((0, "No skills found.\n"))
    # The working directory is gone, as when a shell deletes it.
    gone = tmp_path / "gone"
    gone.mkdir()
    monkeypatch.chdir(gone)
    gone.rmdir()
    assert serve(kit(tmp_path, "a"), home, "skills", "list")[0] == 0
    # Without an entry point, the package root falls back to the missing working directory.
    monkeypatch.setattr(sys, "argv", [""])
    unrooted = incur.Cli("kit", update=False)
    assert serve(unrooted, home, "skills", "list") == snapshot(
        (
            1,
            """\
code: LIST_SKILLS_FAILED
message: "[Errno 2] No such file or directory"
""",
        )
    )
