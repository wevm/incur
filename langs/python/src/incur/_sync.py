"""`skills add` and `skills list`: generated skill files installed for coding agents."""

from __future__ import annotations

import contextlib
import datetime
import glob
import hashlib
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field

from . import _js, _skill, _yaml
from ._http import parse_json
from ._js import Json


@dataclass
class Sync:
    """Settings of the built-in `skills add` command.

    >>> Sync(include=["skills/*"], suggestions=["Show my status"]).depth
    1
    """

    body: str | None = None
    """Text printed after the synced skills, for whatever installing skills cannot do itself."""
    command: str | None = None
    """Command generated skill files show in place of the CLI name, such as `bunx @scope/my-cli`.
    Skill names still derive from the CLI name."""
    cwd: str | None = None
    """Directory that resolves `include` globs, for `skills add` and `skills list`. Defaults to the
    package root: the nearest directory above the entry point with a `package.json`. Project
    installs (`skills add --no-global`) always go to the working directory."""
    depth: float = 1
    """Grouping depth of skill files: commands sharing this many name segments share a file."""
    include: list[str] = field(default_factory=list[str])
    """Glob patterns of directories with extra `SKILL.md` files, such as `skills/*`. `_root`
    names a `SKILL.md` in `cwd` itself."""
    suggestions: list[str] = field(default_factory=list[str])
    """Example prompts shown after syncing."""


@dataclass
class Options:
    """The settings of one sync or listing."""

    env: Mapping[str, str]
    command: str | None = None
    cwd: str | None = None
    depth: float = 1
    description: str | None = None
    include: list[str] = field(default_factory=list[str])
    global_: bool | None = None


@dataclass
class Skill:
    """A generated or included skill."""

    name: str
    description: str | None = None
    installed: bool = False


@dataclass
class Result:
    """A completed sync."""

    skills: list[Skill]
    paths: list[str]
    agents: list[Json]


@dataclass
class _Agent:
    name: str
    global_dir: str
    project_dir: str
    universal: bool
    marker: str


def _home(env: Mapping[str, str]) -> str:
    return env.get("HOME") or os.path.expanduser("~")


def _agents(env: Mapping[str, str]) -> list[_Agent]:
    """Every known agent, with paths resolved from the environment."""
    home = _home(env)
    config = env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    claude = (env.get("CLAUDE_CONFIG_DIR") or "").strip() or os.path.join(home, ".claude")
    codex = (env.get("CODEX_HOME") or "").strip() or os.path.join(home, ".codex")
    universal = [
        ("Amp", os.path.join(config, "agents", "skills"), os.path.join(config, "amp")),
        ("Cline", os.path.join(home, ".agents", "skills"), os.path.join(home, ".cline")),
        ("Codex", os.path.join(codex, "skills"), codex),
        ("Cursor", os.path.join(home, ".cursor", "skills"), os.path.join(home, ".cursor")),
        ("Gemini CLI", os.path.join(home, ".gemini", "skills"), os.path.join(home, ".gemini")),
        (
            "GitHub Copilot",
            os.path.join(home, ".copilot", "skills"),
            os.path.join(home, ".copilot"),
        ),
        ("Kimi CLI", os.path.join(config, "agents", "skills"), os.path.join(home, ".kimi")),
        ("OpenCode", os.path.join(config, "opencode", "skills"), os.path.join(config, "opencode")),
    ]
    linked = [
        ("Claude Code", claude, ".claude"),
        ("Windsurf", os.path.join(home, ".codeium", "windsurf"), ".windsurf"),
        ("Continue", os.path.join(home, ".continue"), ".continue"),
        ("Roo", os.path.join(home, ".roo"), ".roo"),
        ("Kilo", os.path.join(home, ".kilocode"), ".kilocode"),
        ("Goose", os.path.join(config, "goose"), ".goose"),
        ("Augment", os.path.join(home, ".augment"), ".augment"),
        ("Trae", os.path.join(home, ".trae"), ".trae"),
        ("Junie", os.path.join(home, ".junie"), ".junie"),
        ("Crush", os.path.join(config, "crush"), ".crush"),
        ("Kiro CLI", os.path.join(home, ".kiro"), ".kiro"),
        ("Qwen Code", os.path.join(home, ".qwen"), ".qwen"),
        ("OpenHands", os.path.join(home, ".openhands"), ".openhands"),
    ]
    return [
        *(_Agent(n, g, ".agents/skills", True, m) for n, g, m in universal),
        *(_Agent(n, os.path.join(d, "skills"), f"{p}/skills", False, d) for n, d, p in linked),
    ]


def _detected(env: Mapping[str, str]) -> list[_Agent]:
    return [a for a in _agents(env) if os.path.exists(a.marker)]


def frontmatter(content: str) -> tuple[str | None, str | None]:
    """Reads `name` and `description` from a skill file's YAML frontmatter."""
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", content)
    if match is None:
        return None, None
    meta = _yaml.parse_mapping(match[1])
    name, description = meta.get("name"), meta.get("description")
    return (
        name if isinstance(name, str) else None,
        description if isinstance(description, str) else None,
    )


def _sanitize(name: str) -> str:
    return re.sub(r"[/\\]", "-", name.strip()).replace("..", "")[:255]


def _discover(root: str) -> list[tuple[str, str, bool]]:
    """Finds skill directories under `root`: `(name, directory, is_root)`."""
    found: list[tuple[str, str, bool]] = []

    # Skills are staged one level deep: `<root>/<name>/SKILL.md`, or `<root>/SKILL.md`.
    for entry in sorted(os.listdir(root)):
        sub = os.path.join(root, entry)
        if os.path.isdir(sub):
            found.append(
                (_sanitize(_name_line(os.path.join(sub, "SKILL.md")) or entry), sub, False)
            )
    skill = os.path.join(root, "SKILL.md")
    if os.path.exists(skill):
        name = _sanitize(_name_line(skill) or "skill")
        if not any(n == name for n, _, _ in found):
            found.append((name, root, True))
    return found


def _name_line(path: str) -> str | None:
    with open(path, encoding="utf-8") as file:
        match = re.search(r"^name:\s*(.+)$", file.read(), re.M)
    return match[1] if match else None


def _remove(path: str) -> None:
    """Removes a file, directory, or symlink, ignoring absent paths."""
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


def _real(path: str) -> str:
    """Resolves a path through symlinks, as far as its parents exist."""
    if os.path.exists(path):
        return os.path.realpath(path)
    parent = os.path.dirname(path)
    if os.path.exists(parent):
        return os.path.join(os.path.realpath(parent), os.path.basename(path))
    return path


def _install(source: str, is_global: bool, cwd: str, env: Mapping[str, str]) -> Result:
    """Copies skills to the canonical directory and links them for non-universal agents."""
    canonical_base = os.path.join(_home(env) if is_global else cwd, ".agents", "skills")
    detected = _detected(env)
    paths: list[str] = []
    agents: list[Json] = []
    for name, directory, is_root in _discover(source):
        canonical = os.path.join(canonical_base, name)
        _remove(canonical)
        os.makedirs(canonical, exist_ok=True)
        if is_root:
            shutil.copyfile(
                os.path.join(directory, "SKILL.md"), os.path.join(canonical, "SKILL.md")
            )
        else:
            shutil.copytree(directory, canonical, dirs_exist_ok=True)
        paths.append(canonical)
        for agent in detected:
            if agent.universal:
                continue
            base = agent.global_dir if is_global else os.path.join(cwd, agent.project_dir)
            target = os.path.join(base, name)
            # An agent directory that resolves to the canonical one needs no link.
            if _real(target) == _real(canonical):
                continue
            _remove(target)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            relative = os.path.relpath(_real(canonical), _real(os.path.dirname(target)))
            os.symlink(relative, target)
            agents.append({"agent": agent.name, "path": target, "mode": "symlink"})
    return Result([], paths, agents)


def _uninstall(name: str, is_global: bool, cwd: str, env: Mapping[str, str]) -> None:
    """Removes a skill from the canonical directory and every detected agent."""
    _remove(os.path.join(_home(env) if is_global else cwd, ".agents", "skills", name))
    for agent in _detected(env):
        if not agent.universal:
            base = agent.global_dir if is_global else os.path.join(cwd, agent.project_dir)
            _remove(os.path.join(base, name))


def _package_root() -> str:
    """The nearest directory above the entry point with a `package.json`, or the working one."""
    entry = sys.argv[0] if sys.argv else ""
    if not os.path.exists(entry):
        return os.getcwd()
    directory = os.path.dirname(os.path.realpath(entry))
    root = os.path.abspath(os.sep)
    while directory != root:
        if os.path.exists(os.path.join(directory, "package.json")):
            return directory
        directory = os.path.dirname(directory)
    return os.getcwd()


def _meta_path(name: str, env: Mapping[str, str], project: str | None) -> str:
    """The metadata file of a CLI's global installs, or of its installs in a project directory."""
    data = env.get("XDG_DATA_HOME") or os.path.join(_home(env), ".local", "share")
    if project is None:
        return os.path.join(data, "incur", f"{name}.json")
    key = hashlib.sha256(os.path.abspath(project).encode()).hexdigest()[:16]
    return os.path.join(data, "incur", "projects", key, f"{name}.json")


def _read_meta(name: str, env: Mapping[str, str], project: str | None) -> dict[str, Json] | None:
    try:
        with open(_meta_path(name, env, project), encoding="utf-8") as file:
            meta = parse_json(file.read())
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def read_hash(name: str, env: Mapping[str, str], project: str | None = None) -> str | None:
    """The command hash stored by the last global sync, or the last sync in `project`."""
    meta = _read_meta(name, env, project)
    value = meta.get("hash") if meta else None
    return value if isinstance(value, str) and value else None


def _strings(value: Json | None) -> list[str]:
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def _installed(name: str, env: Mapping[str, str], is_global: bool = True) -> set[str]:
    """Names of previously synced skills still installed, globally or in the project."""
    meta = _read_meta(name, env, None if is_global else os.getcwd())
    skills = _strings(meta.get("skills")) if meta else []
    if not meta or not skills:
        return set()
    paths = _strings(meta.get("paths"))
    if paths:
        return {os.path.basename(p) for p in paths if os.path.exists(os.path.join(p, "SKILL.md"))}
    bases = [
        os.path.join(_home(env), ".agents", "skills"),
        os.path.join(os.getcwd(), ".agents", "skills"),
    ]
    return {s for s in skills if any(os.path.exists(os.path.join(b, s, "SKILL.md")) for b in bases)}


def has_installed_skills(name: str, env: Mapping[str, str], is_global: bool = True) -> bool:
    """Whether any previously synced skill is still installed, globally or in the project."""
    return bool(_installed(name, env, is_global))


def _included(pattern: str, cwd: str) -> list[str]:
    """Paths of `SKILL.md` files matching an include pattern, relative to `cwd`."""
    target = "SKILL.md" if pattern == "_root" else os.path.join(pattern, "SKILL.md")
    return sorted(glob.glob(target, root_dir=cwd))


def _generated(
    name: str, infos: list[_skill.CommandInfo], groups: dict[str, str], options: Options
) -> list[tuple[_skill.File, str, str | None]]:
    files = _skill.split(name, infos, options.depth, groups, options.command)
    out: list[tuple[_skill.File, str, str | None]] = []
    for file in files:
        # The rendered description, which a block scalar in the frontmatter would obscure.
        skill, _ = frontmatter(file.content)
        out.append((file, skill or file.dir or name, file.description))
    return out


async def list_skills(
    name: str, infos: list[_skill.CommandInfo], groups: dict[str, str], options: Options
) -> list[Skill]:
    """Lists generated and included skills with their install status."""
    root = options.cwd or _package_root()
    installed = _installed(name, options.env) | _installed(name, options.env, is_global=False)
    skills = [
        Skill(skill, description, skill in installed)
        for _, skill, description in _generated(name, infos, groups, options)
    ]
    for pattern in options.include:
        for match in _included(pattern, root):
            with contextlib.suppress(OSError, UnicodeDecodeError, ValueError):
                with open(os.path.join(root, match), encoding="utf-8") as file:
                    meta_name, description = frontmatter(file.read())
                skill = (
                    (meta_name or name)
                    if pattern == "_root"
                    else os.path.basename(os.path.dirname(match))
                )
                if not any(s.name == skill for s in skills):
                    skills.append(Skill(skill, description, skill in installed))
    skills.sort(key=lambda s: _js.locale_key(s.name))
    return skills


async def sync(
    name: str, infos: list[_skill.CommandInfo], groups: dict[str, str], options: Options
) -> Result:
    """Generates skill files, installs them for detected agents, and records their hash."""
    env = options.env
    is_global = options.global_ is not False
    root = options.cwd or _package_root()
    cwd = os.getcwd()
    tmp = tempfile.mkdtemp(prefix=f"incur-skills-{name}-", dir=env.get("TMPDIR") or None)
    try:
        skills: list[Skill] = []
        for file, skill, description in _generated(name, infos, groups, options):
            path = (
                os.path.join(tmp, file.dir, "SKILL.md")
                if file.dir
                else os.path.join(tmp, "SKILL.md")
            )
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as out:
                out.write(f"{file.content}\n")
            skills.append(Skill(skill, description))
        for pattern in options.include:
            for match in _included(pattern, root):
                with contextlib.suppress(OSError, UnicodeDecodeError, ValueError):
                    with open(os.path.join(root, match), encoding="utf-8") as file:
                        content = file.read()
                    meta_name, description = frontmatter(content)
                    skill = (
                        (meta_name or name)
                        if pattern == "_root"
                        else os.path.basename(os.path.dirname(match))
                    )
                    dest = os.path.join(tmp, skill, "SKILL.md")
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    with open(dest, "w", encoding="utf-8") as out:
                        out.write(content)
                    if not any(s.name == skill for s in skills):
                        skills.append(Skill(skill, description))
        result = _install(tmp, is_global, cwd, env)
        current = [os.path.basename(p) for p in result.paths]
        # Project installs keep their own metadata, so projects with same-named CLIs stay apart.
        project = None if is_global else cwd
        previous = _read_meta(name, env, project)
        for old in _strings(previous.get("skills")) if previous else []:
            if old not in current:
                _uninstall(old, is_global, cwd, env)
        agent_paths = [str(_js.as_object(a)["path"]) for a in result.agents]
        _write_meta(
            name,
            env,
            project,
            {
                "hash": _skill.hash_commands(infos),
                "skills": list(dict.fromkeys(current)),
                "paths": [*result.paths, *agent_paths],
                "at": datetime.datetime.now(datetime.UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            },
        )
        skills.sort(key=lambda s: _js.locale_key(s.name))
        return Result(skills, result.paths, result.agents)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _write_meta(
    name: str, env: Mapping[str, str], project: str | None, meta: dict[str, Json]
) -> None:
    path = _meta_path(name, env, project)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(_js.stringify(meta) + "\n")
