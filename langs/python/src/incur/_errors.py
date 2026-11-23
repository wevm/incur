"""Command errors and call-to-action suggestions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import _js
from ._js import Json
from ._schema import Issue


@dataclass
class Cta:
    """A suggested command.

    `args` append as bare values and `options` as `--key value`; a value of `True` renders a
    placeholder such as `<name>` or `--key <key>`.
    """

    command: str
    """The command to run, without the CLI name."""
    description: str | None = None
    """What the command does."""
    args: dict[str, Json] = field(default_factory=dict[str, Json])
    """Positional arguments appended as bare values."""
    options: dict[str, Json] = field(default_factory=dict[str, Json])
    """Options appended as `--key value`."""


@dataclass
class CtaBlock:
    """A list of suggested commands with an optional label."""

    commands: list[Cta | str]
    """Suggested commands. Strings are commands without a description."""
    description: str | None = None
    """Label. Defaults to `Suggested command:` or `Suggested commands:`."""


@dataclass
class FieldError:
    """A field-level validation error."""

    code: str
    """The Zod issue code."""
    expected: str
    """The expected type."""
    message: str
    """Human-readable message."""
    missing: bool
    """Whether the input omitted the field."""
    path: str
    """The dotted field path."""
    received: str
    """The received value, when reported."""

    def to_json(self) -> dict[str, Json]:
        """Returns the field error as output data."""
        return {
            "code": self.code,
            "missing": self.missing,
            "path": self.path,
            "expected": self.expected,
            "received": self.received,
            "message": self.message,
        }


class Error(Exception):
    """A command failure with a machine-readable code, rendered like the TypeScript `c.error()`.

    Raise it from a handler or middleware. Any other exception reports as code `UNKNOWN` with the
    exception's message.

    >>> error = Error("NOT_AUTHENTICATED", "GitHub token not found", hint="Log in first.")
    >>> error.code, str(error)
    ('NOT_AUTHENTICATED', 'GitHub token not found')
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        hint: str | None = None,
        retryable: bool | None = None,
        exit_code: int | None = None,
        cta: CtaBlock | None = None,
        field_errors: list[FieldError] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        """Machine-readable error code."""
        self.message = message
        """Human-readable message."""
        self.hint = hint
        """Actionable hint."""
        self.retryable = retryable
        """Whether the operation can be retried."""
        self.exit_code = exit_code
        """Process exit code. Defaults to 1."""
        self.cta = cta
        """Suggested commands to run next."""
        self.field_errors = field_errors
        """Per-field validation errors."""

    def to_json(self) -> dict[str, Json]:
        """Returns the `error` object of the output envelope."""
        out: dict[str, Json] = {"code": self.code, "message": self.message}
        if self.hint is not None:
            out["hint"] = self.hint
        if self.retryable is not None:
            out["retryable"] = self.retryable
        if self.field_errors is not None:
            out["fieldErrors"] = [f.to_json() for f in self.field_errors]
        return out


def unknown(message: str) -> Error:
    """Creates an `UNKNOWN` error."""
    return Error("UNKNOWN", message)


def validation(issues: list[Issue], data: Json) -> Error:
    """Builds a validation error from schema issues, with Zod's message and details."""
    short = "; ".join(issue.message for issue in issues)
    details = _js.stringify_pretty([issue.to_json() for issue in issues])
    field_errors = [
        FieldError(
            code=issue.code,
            expected=issue.expected,
            message=issue.message,
            missing=not _has_path(data, issue.path),
            path=".".join(_js.to_string(part) for part in issue.path),
            received=issue.received or "",
        )
        for issue in issues
    ]
    return Error("VALIDATION_ERROR", f"{short}\n\nDetails: {details}", field_errors=field_errors)


def _has_path(data: Any, path: list[str | int]) -> bool:
    """Whether the input contains the full issue path."""
    current = data
    for part in path:
        # Issues report the indices of present array items, and keys of present objects.
        if isinstance(part, str) and part not in current:
            return False
        current = current[part]
    return True


@dataclass
class FormattedCta:
    """A suggestion with the CLI name and arguments folded into one command line."""

    command: str
    description: str | None = None


@dataclass
class FormattedCtaBlock:
    """A formatted block of suggestions."""

    commands: list[FormattedCta]
    description: str

    @staticmethod
    def of(commands: list[FormattedCta]) -> FormattedCtaBlock:
        """Creates a block with the default label."""
        label = "Suggested command:" if len(commands) == 1 else "Suggested commands:"
        return FormattedCtaBlock(commands, label)

    def to_json(self) -> dict[str, Json]:
        """Returns the block as output data."""
        commands: list[Json] = []
        for cta in self.commands:
            entry: dict[str, Json] = {"command": cta.command}
            if cta.description is not None:
                entry["description"] = cta.description
            commands.append(entry)
        return {"description": self.description, "commands": commands}

    def text(self) -> str:
        """Renders the block as plain text, as MCP tool results append it."""
        lines = [self.description]
        for cta in self.commands:
            suffix = f" - {cta.description}" if cta.description else ""
            lines.append(f"  {cta.command}{suffix}")
        return "\n".join(lines)

    def human(self) -> str:
        """Renders the block for a terminal."""
        width = max(_js.utf16_len(cta.command) for cta in self.commands)
        lines = ["", self.description]
        for cta in self.commands:
            suffix = ""
            if cta.description is not None:
                pad = " " * (width - _js.utf16_len(cta.command))
                suffix = f"  {pad}# {cta.description}"
            lines.append(f"  {cta.command}{suffix}")
        return "\n".join(lines)


def format_cta(name: str, block: CtaBlock | None) -> FormattedCtaBlock | None:
    """Formats a block, prefixing commands with the CLI name. Empty blocks format as `None`."""
    if block is None or not block.commands:
        return None
    program = name.split(" ", maxsplit=1)[0]
    commands: list[FormattedCta] = []
    for item in block.commands:
        cta = Cta(item) if isinstance(item, str) else item
        prefixed = cta.command == program or cta.command.startswith(program + " ")
        command = cta.command if prefixed else f"{name} {cta.command}"
        for key, value in cta.args.items():
            command += f" <{key}>" if value is True else f" {_js.to_string(value)}"
        for key, value in cta.options.items():
            command += f" --{key} <{key}>" if value is True else f" --{key} {_js.to_string(value)}"
        commands.append(FormattedCta(command, cta.description or None))
    if block.description is not None:
        return FormattedCtaBlock(commands, block.description)
    return FormattedCtaBlock.of(commands)


def human_error(error: Error) -> str:
    """Renders an error for a terminal."""
    prefix = "Error" if error.code in ("UNKNOWN", "COMMAND_NOT_FOUND") else f"Error ({error.code})"
    out = f"{prefix}: {error.message}"
    for f in error.field_errors or []:
        out += f"\n  {f.path}: {f.message}"
    if error.hint:
        out += f"\nHint: {error.hint}"
    return out
