"""Parses argv tokens and environment variables against schemas."""

from __future__ import annotations

import math
from collections.abc import Callable

from . import _js
from ._errors import unknown, validation
from ._js import Json
from ._schema import Type, validate

#: Looks up an environment variable.
EnvSource = Callable[[str], "str | None"]


class _Names:
    """Lookup tables for option names and aliases."""

    def __init__(self, schema: Type | None) -> None:
        self.schema = schema
        fields = schema.fields if schema else []
        self.aliases = {f.alias: f.name for f in fields if f.alias is not None}

    def long(self, raw: str) -> str | None:
        """Resolves a long option, accepting kebab-case for camelCase names."""
        fields = self.schema.fields if self.schema else []
        for f in fields:
            kebab = _js.to_kebab(f.name)
            if kebab == raw and kebab != f.name:
                return f.name
        return next((f.name for f in fields if f.name == raw), None)

    def ty(self, name: str) -> Type | None:
        """Returns the schema of an option."""
        f = self.schema.field(name) if self.schema else None
        return f.ty if f else None

    def is_count(self, name: str) -> bool:
        ty = self.ty(name)
        return ty is not None and ty.count

    def is_boolean(self, name: str) -> bool:
        ty = self.ty(name)
        return ty is not None and ty.kind == "boolean"

    def takes_value(self, name: str) -> bool:
        return not self.is_count(name) and not self.is_boolean(name)


def _increment(raw: dict[str, Json], name: str) -> None:
    current = raw.get(name)
    raw[name] = (current if isinstance(current, int) else 0) + 1


def _set(raw: dict[str, Json], names: _Names, name: str, value: str) -> None:
    """Sets an option value, collecting values of array options."""
    ty = names.ty(name)
    if ty is not None and ty.kind == "array":
        current = raw.get(name)
        if isinstance(current, list):
            current.append(value)
        else:
            raw[name] = [value]
    else:
        raw[name] = value


def _coerce(value: Json, ty: Type | None) -> Json:
    """Coerces a raw string to the option's type before validation."""
    if ty is not None and isinstance(value, str):
        if ty.kind in ("number", "integer"):
            return _number_value(_js.to_number(value))
        if ty.kind == "boolean":
            return value == "true"
    return value


def _number_value(number: float) -> Json:
    """Wraps a coerced number, keeping non-finite results for validation to report."""
    return _js.number(number) if math.isfinite(number) else number


def check(schema: Type, data: dict[str, Json]) -> dict[str, Json]:
    """Validates an object against a schema, raising a validation error on failure."""
    parsed, issues = validate(schema, data)
    if issues:
        raise validation(issues, data)
    return parsed


def parse(
    argv: list[str],
    args: Type | None,
    options: Type | None,
    defaults: dict[str, Json] | None,
) -> tuple[dict[str, Json], dict[str, Json]]:
    """Parses argv tokens against an args schema and an options schema.

    `defaults` are config-file option defaults, applied before argv values.
    """
    names = _Names(options)
    positionals: list[str] = []
    raw: dict[str, Json] = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("--no-") and len(token) > 5:
            name = names.long(token[5:])
            if name is None:
                raise unknown(f"Unknown flag: {token}")
            raw[name] = False
            i += 1
        elif token.startswith("--"):
            body = token[2:]
            if "=" in body:
                flag, value = body.split("=", 1)
                name = names.long(flag)
                if name is None:
                    raise unknown(f"Unknown flag: --{flag}")
                _set(raw, names, name, value)
                i += 1
                continue
            name = names.long(body)
            if name is None:
                raise unknown(f"Unknown flag: {token}")
            if names.is_count(name):
                _increment(raw, name)
                i += 1
            elif names.is_boolean(name):
                raw[name] = True
                i += 1
            else:
                if i + 1 >= len(argv):
                    raise unknown(f"Missing value for flag: {token}")
                _set(raw, names, name, argv[i + 1])
                i += 2
        elif len(token) >= 2 and token.startswith("-"):
            chars = token[1:]
            for j, short in enumerate(chars):
                name = names.aliases.get(short)
                if name is None:
                    raise unknown(f"Unknown flag: -{short}")
                if names.is_count(name):
                    _increment(raw, name)
                elif names.is_boolean(name):
                    raw[name] = True
                elif j != len(chars) - 1:
                    raise unknown(f"Non-boolean flag -{short} must be last in a stacked alias")
                else:
                    if i + 1 >= len(argv):
                        raise unknown(f"Missing value for flag: -{short}")
                    _set(raw, names, name, argv[i + 1])
                    i += 1
            i += 1
        else:
            positionals.append(token)
            i += 1

    # Positionals fill args in order; a final array arg collects the rest.
    raw_args: dict[str, Json] = {}
    parsed_args: dict[str, Json] = {}
    if args is not None:
        fields = args.fields
        for j, f in enumerate(fields):
            if f.ty.kind == "array":
                if j != len(fields) - 1:
                    raise unknown(
                        f'Variadic arg "{f.name}" must be the last key in the args schema'
                    )
                rest = positionals[j:]
                if rest:
                    raw_args[f.name] = list(rest)
            elif j < len(positionals):
                raw_args[f.name] = positionals[j]
        parsed_args = check(args, raw_args)

    merged = _normalize_defaults(defaults, names)
    for name, value in raw.items():
        merged[name] = _coerce(value, names.ty(name))
    parsed_options = check(options, merged) if options is not None else {}
    return parsed_args, parsed_options


def _normalize_defaults(defaults: dict[str, Json] | None, names: _Names) -> dict[str, Json]:
    """Normalizes config-file defaults and rejects unknown keys."""
    out: dict[str, Json] = {}
    for raw, value in (defaults or {}).items():
        name = names.long(raw)
        if name is None:
            raise unknown(f"Unknown config option: {raw}")
        out[name] = value
    return out


def parse_env(schema: Type, env: EnvSource) -> dict[str, Json]:
    """Parses environment variables against a schema."""
    raw: dict[str, Json] = {}
    for f in schema.fields:
        value = env(f.name)
        if value is None:
            continue
        if f.ty.kind in ("number", "integer"):
            raw[f.name] = _number_value(_js.to_number(value))
        elif f.ty.kind == "boolean":
            raw[f.name] = value in ("true", "1")
        else:
            raw[f.name] = value
    return check(schema, raw)


def parse_globals(
    argv: list[str],
    schema: Type,
    command: Type | None = None,
    *,
    known: bool = False,
    validate: bool = False,
) -> tuple[dict[str, Json], list[str]]:
    """Parses known global options, passing other tokens through in order.

    With `known`, `command` is the options schema of the command receiving the remaining tokens:
    values of its value-taking options pass through untouched, and an unknown flag stops global
    parsing.
    """
    names = _Names(schema)
    cmd = _Names(command) if known else None
    rest: list[str] = []
    raw: dict[str, Json] = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--" or (cmd is not None and _is_unknown_flag(token, names, cmd)):
            rest.extend(argv[i:])
            break
        if token.startswith("--no-") and len(token) > 5:
            name = names.long(token[5:])
            if name is None:
                rest.append(token)
            else:
                raw[name] = False
            i += 1
        elif token.startswith("--"):
            body = token[2:]
            if "=" in body:
                flag, value = body.split("=", 1)
                name = names.long(flag)
                if name is None:
                    rest.append(token)
                else:
                    _set(raw, names, name, value)
                i += 1
                continue
            name = names.long(body)
            if name is not None:
                if names.is_count(name):
                    _increment(raw, name)
                    i += 1
                elif names.is_boolean(name):
                    raw[name] = True
                    i += 1
                else:
                    if i + 1 >= len(argv):
                        raise unknown(f"Missing value for flag: {token}")
                    _set(raw, names, name, argv[i + 1])
                    i += 2
                continue
            rest.append(token)
            i += 1
            target = cmd.long(body) if cmd is not None else None
            if cmd is not None and target is not None and cmd.takes_value(target) and i < len(argv):
                rest.append(argv[i])
                i += 1
        elif len(token) >= 2 and token.startswith("-"):
            chars = token[1:]
            if not all(
                ch in names.aliases or (cmd is not None and ch in cmd.aliases) for ch in chars
            ):
                rest.append(token)
                i += 1
                continue
            command_chars = ""
            command_value: str | None = None
            for j, short in enumerate(chars):
                last = j == len(chars) - 1
                name = names.aliases.get(short)
                if name is None:
                    # Every character is known, so this one is a command alias.
                    assert cmd is not None
                    command_chars += short
                    if not cmd.takes_value(cmd.aliases[short]):
                        continue
                    if not last:
                        raise unknown(f"Non-boolean flag -{short} must be last in a stacked alias")
                    if i + 1 < len(argv):
                        command_value = argv[i + 1]
                        i += 1
                    continue
                if names.is_count(name):
                    _increment(raw, name)
                elif names.is_boolean(name):
                    raw[name] = True
                elif not last:
                    raise unknown(f"Non-boolean flag -{short} must be last in a stacked alias")
                else:
                    if i + 1 >= len(argv):
                        raise unknown(f"Missing value for flag: -{short}")
                    _set(raw, names, name, argv[i + 1])
                    i += 1
            if command_chars:
                rest.append(f"-{command_chars}")
            if command_value is not None:
                rest.append(command_value)
            i += 1
        else:
            rest.append(token)
            i += 1

    if not validate:
        return raw, rest
    coerced = {name: _coerce(value, names.ty(name)) for name, value in raw.items()}
    return check(schema, coerced), rest


def _is_unknown_flag(token: str, globals_: _Names, command: _Names) -> bool:
    """Whether a flag that may read the next token is neither a global nor a command option."""
    if token.startswith("--"):
        if token.startswith("--no-") or "=" in token:
            return False
        raw = token[2:]
        return globals_.long(raw) is None and command.long(raw) is None
    if not token.startswith("-") or len(token) < 2:
        return False
    return any(ch not in globals_.aliases and ch not in command.aliases for ch in token[1:])
