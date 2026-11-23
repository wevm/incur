"""Update checks and `--update`: cached latest versions, detached refreshes, and installers."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import os
import re
import subprocess
import sys
import time
import urllib.parse
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from . import _js, _pm
from ._http import Request, fetch, join_url, parse_json
from ._js import Json

#: The hidden flag of detached update checks.
CHECK_FLAG = "--incur-update-check"

_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
_PACKAGE = re.compile(r"^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*$")


@dataclass
class UpdateCheck:
    """What a custom update checker receives."""

    current: str
    """The current CLI version."""
    name: str
    """The CLI name."""
    package: str | None = None
    """The registry package name, when configured or inferred."""


@dataclass
class UpdateInstall:
    """What a custom update installer receives."""

    name: str
    """The CLI name."""
    current: str | None = None
    """The current CLI version, when known."""
    latest: str | None = None
    """The latest cached version, when known."""
    package: str | None = None
    """The registry package name, when configured or inferred."""


@dataclass
class Update:
    """Settings of update checks and `--update`.

    By default the CLI updates as the npm package that contains its entry point. Standalone
    distributions provide `check` and `install`.

    >>> def latest(c: UpdateCheck) -> str | None:
    ...     return "2.0.0"
    >>> Update(check=latest, interval=3600).interval
    3600
    """

    check: Callable[[UpdateCheck], str | Awaitable[str | None] | None] | None = None
    """Returns the latest version, or `None`. It may be an `async def` function."""
    install: Callable[[UpdateInstall], object] | None = None
    """Installs the latest version. It may be an `async def` function."""
    deferred: bool = False
    """Whether installation finishes after the updating process exits."""
    interval: float = 24 * 60 * 60
    """Minimum seconds between update checks. Defaults to one day."""
    package: str | None = None
    """The registry package name. Defaults to the package containing the entry point."""


@dataclass
class Options:
    """The update settings of one run."""

    update: Update
    version: str | None


@dataclass
class Available:
    """An available update."""

    current: str
    latest: str
    name: str


@dataclass
class _Provider:
    key: str
    name: str
    check: Callable[[UpdateCheck], object] | None
    install: Callable[[], Awaitable[None]] | None
    command: str | None
    current: str | None
    package: str | None
    deferred: bool


def _now() -> int:
    return int(time.time() * 1000)


def _package_of(name: str) -> tuple[str, str] | None:
    """Finds the npm package, name and version, that contains the entry point."""
    entry = sys.argv[0] if sys.argv else ""
    if not entry or not os.path.exists(entry):
        return None
    directory = os.path.dirname(os.path.realpath(entry))
    while True:
        metadata = _read_json(os.path.join(directory, "package.json"))
        if isinstance(metadata, dict):
            pkg, version = metadata.get("name"), metadata.get("version")
            if isinstance(pkg, str) and isinstance(version, str) and _provides(metadata, name):
                return pkg, version
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def _provides(metadata: dict[str, Json], name: str) -> bool:
    """Whether package metadata declares the CLI name."""
    pkg = metadata.get("name")
    binary = metadata.get("bin")
    if pkg == name or (isinstance(binary, dict) and name in binary):
        return True
    return isinstance(binary, str) and isinstance(pkg, str) and pkg.split("/")[-1] == name


def _read_json(path: str) -> Json | None:
    try:
        with open(path, encoding="utf-8") as file:
            return parse_json(file.read())
    except (OSError, ValueError):
        return None


def _provider(name: str, options: Options, env: Mapping[str, str]) -> _Provider | None:
    """Resolves package defaults and custom overrides."""
    update = options.update
    executing = _package_of(name)
    package = update.package or (executing[0] if executing else None)
    if package and not _PACKAGE.match(package):
        return None
    current = options.version or (executing[1] if executing else None)
    invocation = _pm.global_install(package, env) if package else None
    checker: Callable[[UpdateCheck], object] | None = update.check
    if checker is None and package:
        registry = package

        def latest(_: UpdateCheck) -> Awaitable[str | None]:
            return _fetch_latest(registry, env)

        checker = latest

    install: Callable[[], Awaitable[None]] | None = None
    if update.install is not None:
        custom = update.install

        async def run_custom() -> None:
            cached = _read_cache(_cache_path(package or name, env))
            latest = cached.get("latest") if cached else None
            context = UpdateInstall(
                name, current or None, latest if isinstance(latest, str) else None, package
            )
            result = custom(context)
            if inspect.isawaitable(result):
                await result

        install = run_custom
    elif invocation is not None:
        argv = invocation

        async def run_package() -> None:
            await _exec(argv, env)

        install = run_package

    if checker is None and install is None:
        return None
    command = " ".join(invocation) if invocation and update.install is None else None
    return _Provider(
        package or name,
        package or name,
        checker,
        install,
        command,
        current or None,
        package,
        update.deferred,
    )


async def _fetch_latest(package: str, env: Mapping[str, str]) -> str | None:
    """Fetches the latest version of an npm package from the registry."""
    registry = env.get("npm_config_registry") or "https://registry.npmjs.org"
    base = registry if registry.endswith("/") else f"{registry}/"
    url = join_url(base, urllib.parse.quote(package, safe="-_.!~*'()"))
    accept = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
    response = await asyncio.wait_for(fetch(Request(url, headers={"accept": accept})), 10)
    if not response.ok:
        return None
    metadata = parse_json(await response.text())
    tags = metadata.get("dist-tags") if isinstance(metadata, dict) else None
    latest = tags.get("latest") if isinstance(tags, dict) else None
    return latest if isinstance(latest, str) else None


def _version(text: str) -> tuple[list[int], list[int | str]] | None:
    """Parses a semantic version into its core numbers and prerelease identifiers."""
    match = _SEMVER.match(text)
    if not match:
        return None
    prerelease: list[int | str] = []
    for part in match[4].split(".") if match[4] else []:
        if not part.isdigit():
            prerelease.append(part)
        elif len(part) > 1 and part.startswith("0"):
            return None
        else:
            prerelease.append(int(part))
    return [int(match[1]), int(match[2]), int(match[3])], prerelease


def is_newer(candidate: str, current: str) -> bool:
    """Whether `candidate` is a newer semantic version than `current`."""
    a, b = _version(candidate), _version(current)
    if a is None or b is None:
        return False
    if a[0] != b[0]:
        return a[0] > b[0]
    pa, pb = a[1], b[1]
    if not pa or not pb:
        return not pa and bool(pb)
    for x, y in zip(pa, pb, strict=False):
        if x == y:
            continue
        if isinstance(x, int) != isinstance(y, int):
            return isinstance(x, str)
        return x > y  # type: ignore[operator]
    return len(pa) > len(pb)


def _cache_path(key: str, env: Mapping[str, str]) -> str:
    home = env.get("HOME") or os.path.expanduser("~")
    root = env.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    return os.path.join(root, "incur", "updates", f"{urllib.parse.quote(key, safe='')}.json")


def _read_cache(path: str) -> dict[str, Json] | None:
    value = _read_json(path)
    if not isinstance(value, dict):
        return None
    checked = value.get("checkedAt")
    latest = value.get("latest", "")
    if isinstance(checked, bool) or not isinstance(checked, (int, float)):
        return None
    return value if isinstance(latest, str) else None


def _write_cache(path: str, cache: dict[str, Json]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(_js.stringify(cache) + "\n")


def _disabled(env: Mapping[str, str]) -> bool:
    """Whether the environment suppresses update notifications."""
    if env.get("NO_UPDATE_NOTIFIER") or env.get("npm_config_update_notifier") == "false":
        return True
    ci = env.get("CI")
    return bool(ci) and ci != "false"


def check(name: str, options: Options, env: Mapping[str, str]) -> Available | None:
    """Returns a cached available update, and schedules a detached refresh when it is stale."""
    if _disabled(env):
        return None
    provider = _provider(name, options, env)
    if provider is None or provider.check is None or provider.current is None:
        return None
    path = _cache_path(provider.key, env)
    cached = _read_cache(path)
    now = _now()
    interval = max(0.0, options.update.interval * 1000)
    latest = cached.get("latest") if cached else None
    checked = cached["checkedAt"] if cached else 0
    assert isinstance(checked, (int, float))
    if cached is None or now - checked >= interval:
        _schedule_refresh(path, now, latest if isinstance(latest, str) else None)
    if not isinstance(latest, str) or not is_newer(latest, provider.current):
        return None
    return Available(provider.current, latest, provider.name)


def _schedule_refresh(path: str, now: int, latest: str | None) -> None:
    """Marks a check and starts a detached self-invocation that refreshes the cache."""
    entry = sys.argv[0] if sys.argv else ""
    if not entry:
        return
    frozen = getattr(sys, "frozen", False)
    command = [sys.executable, CHECK_FLAG] if frozen else [sys.executable, entry, CHECK_FLAG]
    cache: dict[str, Json] = {"checkedAt": now}
    if latest:
        cache["latest"] = latest
    with contextlib.suppress(OSError):
        _write_cache(path, cache)
        subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


async def refresh(name: str, options: Options, env: Mapping[str, str]) -> None:
    """Refreshes the cached latest version through the provider."""
    provider = _provider(name, options, env)
    if provider is None or provider.check is None or provider.current is None:
        return
    latest = provider.check(UpdateCheck(provider.current, name, provider.package))
    if inspect.isawaitable(latest):
        latest = await latest
    if not isinstance(latest, str) or not latest or _version(latest) is None:
        return
    _write_cache(_cache_path(provider.key, env), {"checkedAt": _now(), "latest": latest})


async def install(name: str, options: Options, env: Mapping[str, str]) -> dict[str, Json]:
    """Installs the latest version through the provider. Returns what `--update` reports."""
    provider = _provider(name, options, env)
    if provider is None or provider.install is None:
        raise RuntimeError(f"No update installer is configured for '{name}'.")
    await provider.install()
    out: dict[str, Json] = {}
    if provider.command:
        out["command"] = provider.command
    if provider.deferred:
        out["deferred"] = True
    out["name"] = provider.name
    return out


async def _exec(command: list[str], env: Mapping[str, str]) -> None:
    """Runs a package-manager command, failing with its useful error output."""
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as error:
        raise RuntimeError(f"spawn {command[0]} ENOENT") from error
    stdout, stderr = await process.communicate()
    if process.returncode == 0:
        return
    message = stderr.decode().strip() or stdout.decode().strip()
    raise RuntimeError(message or f"Command failed: {' '.join(command)}")
