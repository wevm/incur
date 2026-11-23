"""Package-manager detection from the environment and the executing entry point."""

from __future__ import annotations

import os
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
