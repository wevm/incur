"""`c.elicit`: asks the user of a 2026-07-28 MCP client for input while a command runs as a tool.

MCP tool calls are stateless: a call that needs input stops the command and answers
`input_required`, and the client retries the call with the answer. The command reruns, and its
`n`th `c.elicit` call reads the answer keyed `elicit-n`. Earlier answers ride in `requestState`,
since a retry carries only the answers to the latest request.
"""

from __future__ import annotations

import typing
from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, Literal, TypeVar

from . import _js
from ._errors import Error
from ._js import Json
from ._model import build, type_of
from ._parser import check
from ._schema import json_schema

T = TypeVar("T")
R = TypeVar("R")

#: How the user answered: submitted, declined, or dismissed.
Action = Literal["accept", "decline", "cancel"]


@dataclass(frozen=True)
class Elicited(Generic[T]):
    """The user's answer to an elicitation."""

    action: Action
    """`accept` when the user submitted (or, for a URL, agreed to open it), else `decline` or
    `cancel`."""
    content: T | None = None
    """The submitted fields of an accepted form."""


class Elicit:
    """Asks the user of a 2026-07-28 MCP client for input while a command runs as a tool.

    Outside MCP, and when the client does not support the mode, calls raise
    `ELICITATION_UNSUPPORTED`.
    """

    def __init__(
        self,
        capabilities: Json = None,
        responses: dict[str, Json] | None = None,
        *,
        mcp: bool = False,
    ) -> None:
        declared = capabilities.get("elicitation") if isinstance(capabilities, dict) else None
        self._declared = (
            typing.cast("dict[str, Json]", declared) if mcp and isinstance(declared, dict) else None
        )
        self._responses = responses or {}
        self._index = 0
        self.pending: dict[str, Json] | None = None
        """The `input_required` result the first unanswered call produced."""

    def __call__(self, message: str, schema: type[T]) -> Elicited[T]:
        """Asks for structured, non-sensitive input with a flat schema class of primitive fields.

        Code before the call runs again on each retry.
        """
        ty = type_of(schema, schema.__name__)
        # Clients answer with what the schema accepts, so defaulted fields are optional.
        out = json_schema(ty, "input")
        requested: dict[str, Json] = {"type": "object", "properties": out.get("properties", {})}
        required = _js.as_list(out.get("required", []))
        if required:
            requested["required"] = required

        def read(response: dict[str, Json]) -> Elicited[T] | None:
            if response["action"] != "accept":
                return Elicited(typing.cast("Action", response["action"]))
            content = response.get("content")
            if not isinstance(content, dict):
                return None
            try:
                return Elicited("accept", build(ty, check(ty, content)))
            except Error:
                return None

        return self._ask("form", {"message": message, "requestedSchema": requested}, read)

    def url(self, message: str, url: str) -> Elicited[None]:
        """Sends the user to a URL for input that must not pass through the client.

        `accept` means the user agreed to open it, not that the interaction finished.
        """
        return self._ask(
            "url",
            {"message": message, "url": url},
            lambda response: Elicited[None](typing.cast("Action", response["action"])),
        )

    def _supports(self, mode: str) -> bool:
        declared = self._declared
        if declared is None:
            return False
        return mode in declared or (mode == "form" and "url" not in declared)

    def _ask(
        self, mode: str, params: dict[str, Json], read: Callable[[dict[str, Json]], R | None]
    ) -> R:
        key = f"elicit-{self._index}"
        self._index += 1
        if not self._supports(mode):
            raise Error(
                "ELICITATION_UNSUPPORTED",
                f"Elicitation requires an MCP client that supports {mode} elicitation.",
                retryable=False,
            )
        response = self._responses.get(key)
        if isinstance(response, dict) and response.get("action") in ("accept", "decline", "cancel"):
            value = read(response)
            if value is not None:
                return value
        if self.pending is None:
            answered = {
                f"elicit-{i}": self._responses[f"elicit-{i}"]
                for i in range(self._index - 1)
                if f"elicit-{i}" in self._responses
            }
            pending: dict[str, Json] = {
                "resultType": "input_required",
                "inputRequests": {
                    key: {"method": "elicitation/create", "params": {"mode": mode, **params}}
                },
            }
            if answered:
                pending["requestState"] = _js.stringify(answered)
            self.pending = pending
        raise Error("INPUT_REQUIRED", "Waiting for the user to respond.", retryable=False)


def responses(params: dict[str, Json]) -> dict[str, Json]:
    """The answers a retried request carries.

    Earlier answers come from `requestState`, then `inputResponses`. Like the SDK, it drops input
    responses that are not bare result objects.
    """
    out: dict[str, Json] = {}
    state = params.get("requestState")
    if isinstance(state, str):
        parsed = _js.parse_json(state) if _js.json_parse_error(state) is None else None
        if isinstance(parsed, dict):
            out.update(parsed)
    given = params.get("inputResponses")
    if isinstance(given, dict):
        out.update(
            {
                key: entry
                for key, entry in given.items()
                if isinstance(entry, dict) and "method" not in entry and "result" not in entry
            }
        )
    return out
