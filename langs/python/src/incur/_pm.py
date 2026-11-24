"""Package-manager detection from the environment and the executing entry point."""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
from collections.abc import Mapping
from typing import Literal

PackageManager = Literal["bun", "npm", "pnpm"]


def _entry() -> str:
    """The resolved path of the executing entry point, or `""`."""
    entry = sys.argv[0] if sys.argv else ""
    return os.path.realpath(entry) if entry else ""


def detect(env: Mapping[str, str]) -> PackageManager:
    """Detects the package manager from npm's environment variables and the entry point path."""
    agent = env.get("npm_config_user_agent", "")
    exec_path = env.get("npm_execpath", "")
    entry = _entry()
    if "pnpm" in agent:
        return "pnpm"
    if "bun" in agent:
        return "bun"
    if agent.startswith("npm/"):
        return "npm"
    for name in ("pnpm", "bun", "npm"):
        if name in exec_path:
            return name
    if "/.pnpm/" in entry or "\\.pnpm\\" in entry:
        return "pnpm"
    if "/.bun/" in entry or "\\bun\\" in entry:
        return "bun"
    return "npm"


def runner(env: Mapping[str, str]) -> str:
    """The package runner of the detected package manager: `npx`, `pnpx`, or `bunx`."""
    return {"pnpm": "pnpx", "bun": "bunx", "npm": "npx"}[detect(env)]


def global_install(name: str, env: Mapping[str, str]) -> list[str]:
    """The command that installs the latest version of a package globally."""
    manager = detect(env)
    verb = "install" if manager == "npm" else "add"
    return [manager, verb, "--global", f"{name}@latest"]


async def exec(argv: list[str], env: Mapping[str, str]) -> str:
    """Runs a package-manager command and returns its stdout.

    A failure raises its trimmed stderr, else its stdout, else a `Command failed` message. On
    Windows, npm, npx, pnpm, and pnpx are `.cmd` scripts that `subprocess` cannot launch safely, so
    a script found on `PATH` runs through `cmd.exe` with its arguments quoted the way Rust's and
    Zig's standard libraries quote batch file arguments.
    """
    command, *args = argv
    script = _which(command, env) if sys.platform == "win32" else None
    if script is not None and script[-4:].lower() in (".bat", ".cmd"):
        # `cmd.exe` ends the command line at a line break, which would drop the arguments after it.
        if any("\r" in arg or "\n" in arg for arg in args):
            raise RuntimeError(f"spawn {command} EINVAL")
        line = " ".join([f'""{script}"', *map(_quote, args)]) + '"'
        # A string runs verbatim on Windows, where a list would be quoted for the C runtime.
        result = await asyncio.to_thread(
            subprocess.run,
            f"cmd.exe /e:ON /v:OFF /d /c {line}",
            executable=env.get("COMSPEC"),
            env=dict(env),
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
        code, out, err = result.returncode, result.stdout, result.stderr
    else:
        try:
            process = await asyncio.create_subprocess_exec(
                script or command,
                *args,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as error:
            raise RuntimeError(f"spawn {command} ENOENT") from error
        out, err = await process.communicate()
        code = process.returncode
    stdout = out.decode()
    if code == 0:
        return stdout
    message = err.decode().strip() or stdout.strip()
    raise RuntimeError(message or f"Command failed: {' '.join(argv)}")


def _which(command: str, env: Mapping[str, str]) -> str | None:
    """Finds `command` on `PATH` with each `PATHEXT` extension, as `cmd.exe` does.

    Unlike `cmd.exe`, it does not search the working directory.
    """
    extensions = [e for e in env.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(";") if e]
    for directory in env.get("PATH", "").split(";"):
        if not directory:
            continue
        for extension in extensions:
            file = os.path.join(directory.replace('"', ""), command + extension)
            if os.path.isfile(file):
                return file
    return None


_UNQUOTED = re.compile(r"[\w#$*+\-./:?@\\\u00a0-\U0010ffff]*")


def _quote(arg: str) -> str:
    """Quotes a batch file argument as Rust's standard library does.

    It quotes anything but known-safe characters, doubles embedded quotes and the backslashes
    before them, and turns `%` into `%%cd:~,%` so `cmd.exe` expands no variables.
    """
    body = re.sub(r'(\\*)"', r'\1\1""', arg).replace("%", "%%cd:~,%")
    if arg and not arg.endswith("\\") and _UNQUOTED.fullmatch(arg):
        return body
    return '"' + re.sub(r"(\\*)$", r"\1\1", body) + '"'
