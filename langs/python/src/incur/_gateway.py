"""Fetch gateways: curl-style argv as HTTP requests, and responses as command output."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from . import _js
from ._http import Headers, Request, Response, encode_params, join_url, search_params
from ._js import Json

_RESERVED = frozenset({"method", "body", "data", "header"})
_SHORT = {"X": "method", "d": "data", "H": "header"}


@dataclass
class Input:
    """A request parsed from curl-style argv."""

    path: str
    method: str
    headers: Headers
    body: str | None
    query: list[tuple[str, str]] = field(default_factory=list[tuple[str, str]])


def _set(query: list[tuple[str, str]], key: str, value: str) -> None:
    """Sets a query parameter as `URLSearchParams.set` does: replaces the first, drops others."""
    index = next((i for i, (k, _) in enumerate(query) if k == key), None)
    if index is None:
        query.append((key, value))
        return
    query[index] = (key, value)
    query[index + 1 :] = [(k, v) for k, v in query[index + 1 :] if k != key]


def parse_argv(argv: list[str]) -> Input:
    """Parses curl-style argv: path segments, `--key value` query parameters, and reserved flags.

    Raises:
        ValueError: When a flag has no value.
    """
    segments: list[str] = []
    headers = Headers()
    query: list[tuple[str, str]] = []
    method: str | None = None
    body: str | None = None

    def reserved(key: str, value: str) -> None:
        nonlocal method, body
        if key == "method":
            method = value.upper()
        elif key in ("body", "data"):
            body = value
        elif ":" in value:
            name, _, rest = value.partition(":")
            headers.set(_js.trim(name), _js.trim(rest))

    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("--"):
            if "=" in token:
                key, _, value = token[2:].partition("=")
                i += 1
            else:
                key = token[2:]
                if i + 1 >= len(argv):
                    raise ValueError(f"Missing value for --{key}")
                value = argv[i + 1]
                i += 2
            if key in _RESERVED:
                reserved(key, value)
            else:
                _set(query, key, value)
        elif token.startswith("-") and len(token) == 2:
            mapped = _SHORT.get(token[1])
            if mapped is None:
                # An unknown short flag stands alone.
                i += 1
                continue
            if i + 1 >= len(argv):
                raise ValueError(f"Missing value for {token}")
            reserved(mapped, argv[i + 1])
            i += 2
        else:
            segments.append(token)
            i += 1
    # Collapse slashes so a path token like `/users` cannot become a protocol-relative `//users`.
    path = re.sub("/{2,}", "/", "/" + "/".join(segments))
    return Input(path, method or ("POST" if body is not None else "GET"), headers, body, query)


def build_request(data: Input) -> Request:
    """Builds the request a gateway sends."""
    url = join_url("http://localhost", data.path)
    query = list(search_params(url.partition("?")[2]))
    for key, value in data.query:
        _set(query, key, value)
    base = url.partition("?")[0]
    if query:
        base += "?" + encode_params(query)
    if data.body is not None and "content-type" not in data.headers:
        data.headers.set("content-type", "application/json")
    return Request(base, method=data.method, headers=data.headers, body=data.body)


def is_streaming(response: Response) -> bool:
    """Whether a response streams NDJSON."""
    return response.headers.get("content-type") == "application/x-ndjson"


async def stream(response: Response) -> AsyncIterator[Json]:
    """Parses an NDJSON body as it arrives. Lines that are not JSON yield as text."""
    buffer = ""

    def value(line: str) -> Json:
        return _js.parse_json(line) if _js.json_parse_error(line) is None else line

    async for chunk in response.chunks():
        buffer += chunk.decode("utf-8", "replace")
        while "\n" in buffer:
            line, _, buffer = buffer.partition("\n")
            line = _js.trim(line)
            if line:
                yield value(line)
    remaining = _js.trim(buffer)
    if remaining:
        yield value(remaining)


async def read(response: Response) -> Json:
    """Reads a response body as JSON, or as text when it is not JSON."""
    text = await response.text()
    return _js.parse_json(text) if _js.json_parse_error(text) is None else text


def error_of(data: Json, status: int) -> tuple[str, str]:
    """Extracts an error code and message from a failed response body."""
    nested = data.get("error") if isinstance(data, dict) else None
    error = nested if isinstance(nested, dict) else None
    code = error.get("code") if error else None
    code = code if isinstance(code, str) and code else f"HTTP_{status}"
    if isinstance(data, dict) and "message" in data:
        message = _js.to_string(data["message"])
    elif error is not None and "message" in error:
        message = _js.to_string(error["message"])
    elif isinstance(data, str):
        message = data
    else:
        message = f"HTTP {status}"
    return code, message


def help_text(name: str, description: str | None) -> str:
    """Renders the help of a gateway command."""
    return "\n".join(
        [
            f"{name} \u2014 {description}" if description else name,
            "",
            f"Usage: {name} <path> [options]",
            "",
            "Path segments are joined into the request URL path.",
            "",
            "Options:",
            "  -X, --method <METHOD>     HTTP method (default: GET, POST if body present)",
            '  -H, --header "Key: Val"   Set a request header (repeatable)',
            "  -d, --data <json>          Request body (implies POST)",
            "      --body <json>          Request body (implies POST)",
            "  --<key> <value>            Query string parameter",
        ]
    )
