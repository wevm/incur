"""`mcp add`: registers the CLI as an MCP server through `add-mcp` and Amp's settings."""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field

from . import _js, _pm
from ._http import parse_json
from ._js import Json

_EXACT_VERSION = re.compile(
    r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$"
)
_PACKAGE_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")


@dataclass
class Options:
    """The settings of one registration."""

    env: Mapping[str, str]
    cli: str | None = None
    command: str | None = None
    global_: bool = True
    agents: list[str] = field(default_factory=list[str])
    package: str | None = None
    version: str | None = None


@dataclass
class Result:
    """A completed registration."""

    command: str
    agents: list[str]


def is_package_name(name: str) -> bool:
    """Whether a name is a safe npm package name, such as `my-cli` or `@scope/my-cli`."""
    return _PACKAGE_NAME.match(name) is not None


def package_specifier(name: str, package: str | None, version: str | None) -> str:
    """The package specifier that runs the CLI, pinned to `version` when a package is set."""
    if package is None:
        return name
    if not is_package_name(package):
        raise ValueError(f"Invalid npm package name: {package}")
    if version is not None and not _EXACT_VERSION.match(version):
        raise ValueError(f"Invalid exact package version: {version}")
    return package if version is None else f"{package}@{version}"


def _depends_on(root: str, name: str) -> bool:
    """Whether the project at `root` lists `name` as a dependency."""
    try:
        with open(os.path.join(root, "package.json"), encoding="utf-8") as file:
            pkg = parse_json(file.read())
    except (OSError, ValueError):
        return False
    if not isinstance(pkg, dict):
        return False
    for key in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        deps = pkg.get(key)
        if isinstance(deps, dict) and name in deps:
            return True
    return False


def _bare(name: str, package: str | None) -> bool:
    """Whether the binary is expected on `PATH`, so agents can run it by name."""
    entry = sys.argv[0] if sys.argv else ""
    if not entry:
        return False
    normalized = entry.replace("\\", "/")
    match = re.match(r"^(.+)/node_modules/(.+)$", normalized)
    if match:
        return not match[2].startswith(".bin/") and not _depends_on(match[1], package or name)
    file = normalized.split("/")[-1]
    return file in (name, f"{name}.cmd", f"{name}.ps1")


def _default_command(name: str, runner: str, package: str | None, version: str | None) -> str:
    specifier = package_specifier(name, package, version) if package is not None else None
    if _bare(name, package) or (package is None and not is_package_name(name)):
        return f"{name} --mcp"
    return f"{runner} {specifier or name} --mcp"


def _split(command: str) -> list[str]:
    """Splits a command into tokens, respecting single and double quotes."""
    tokens: list[str] = []
    current = ""
    quote: str | None = None
    for ch in command:
        if quote:
            if ch == quote:
                quote = None
            else:
                current += ch
        elif ch in "\"'":
            quote = ch
        elif ch == " ":
            if current:
                tokens.append(current)
            current = ""
        else:
            current += ch
    if current:
        tokens.append(current)
    return tokens


def _read_amp(path: str) -> dict[str, Json]:
    """Reads Amp's settings: `{}` when the file is missing, else the JSON object it holds."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as file:
            text = file.read()
    except OSError:
        text = ""
    config = None if _js.json_parse_error(text) is not None else _js.parse_json(text)
    if not isinstance(config, dict):
        raise ValueError(f"Invalid Amp settings at {path}: expected a JSON object")
    return config


def _register_amp(path: str, config: dict[str, Json], name: str, command: str) -> bool:
    """Adds the server to Amp's settings, keeping the other fields of an existing entry."""
    tokens = _split(command)
    if not tokens:
        return False
    servers = config.get("amp.mcpServers")
    servers = servers if isinstance(servers, dict) else {}
    existing = servers.get(name)
    server = dict(existing) if isinstance(existing, dict) else {}
    server.update(command=tokens[0], args=list[Json](tokens[1:]))
    servers[name] = server
    config["amp.mcpServers"] = servers
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(_js.stringify_pretty(config) + "\n")
    return True


async def register(name: str, options: Options) -> Result:
    """Registers an MCP server with `add-mcp` and, directly, with Amp."""
    env = options.env
    runner = _pm.runner(env)
    command = options.command
    if command is None:
        command = _default_command(options.cli or name, runner, options.package, options.version)
    targets = options.agents
    # Amp is registered directly (`add-mcp` does not support it). Its settings are read first, so
    # invalid settings fail before any agent is configured.
    amp = not targets or "amp" in targets
    if options.global_:
        home = env.get("HOME") or os.path.expanduser("~")
        amp_path = os.path.join(home, ".config", "amp", "settings.json")
    else:
        amp_path = os.path.join(os.getcwd(), ".amp", "settings.json")
    amp_config = _read_amp(amp_path) if amp else None
    agents: list[str] = []
    if targets != ["amp"]:
        args = [command, "--name", name, "-y"]
        if options.global_:
            args.append("-g")
        for agent in targets:
            if agent != "amp":
                args += ["-a", agent]
        stdout = await _pm.exec([runner, "add-mcp", *args], env)
        for line in stdout.split("\n"):
            if "\u2713" in line or "\u2714" in line:
                label = re.sub(r"[│┃|]", "", line)
                label = re.sub(r".*[\u2713\u2714]\s*", "", label)
                label = re.sub(r":.*", "", label).strip()
                if label:
                    agents.append(label)
    if amp_config is not None and _register_amp(amp_path, amp_config, name, command):
        agents.append("Amp")
    return Result(command, agents)
