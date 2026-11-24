"""MCP protocol revision 2026-07-28: per-request envelopes and the HTTP validation ladder.

Mirrors how `@modelcontextprotocol/server` serves the revision: `server/discover`, `_meta`
validation, standard header checks, and result stamping.
"""

from __future__ import annotations

import base64
import binascii
import math
import re
from collections.abc import Callable
from typing import TYPE_CHECKING

from . import _js
from ._errors import Error
from ._http import Request, Response
from ._js import Json
from ._schema import MAX_SAFE_INTEGER, Type, is_number, json_schema

if TYPE_CHECKING:
    from ._mcp import CacheHint, Server

#: The modern protocol revision the server speaks.
VERSION = "2026-07-28"
VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
INFO_KEY = "io.modelcontextprotocol/clientInfo"
CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities"
LOG_KEY = "io.modelcontextprotocol/logLevel"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
_RESERVED = (VERSION_KEY, INFO_KEY, CAPABILITIES_KEY, LOG_KEY)
_REQUIRED = (VERSION_KEY, CAPABILITIES_KEY)
_LEVELS = ("debug", "info", "notice", "warning", "error", "critical", "alert", "emergency")
_CACHEABLE = (
    "tools/list",
    "prompts/list",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "server/discover",
)
_NAME_SOURCE = {"tools/call": "name", "prompts/get": "name", "resources/read": "uri"}
_DECIMAL = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")
_BASE64 = re.compile(r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")


def is_message(value: Json) -> bool:
    """Whether a value is a JSON-RPC 2.0 request, notification, or response."""
    if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
        return False
    id_ = value.get("id")
    has_id = "id" in value and isinstance(id_, (str, int)) and not isinstance(id_, bool)
    if "method" in value:
        params = value.get("params")
        valid_params = "params" not in value or isinstance(params, dict)
        return isinstance(value["method"], str) and valid_params and ("id" not in value or has_id)
    return has_id and ("result" in value or "error" in value)


def is_modern_version(version: str) -> bool:
    """Whether a protocol revision belongs to the 2026-07-28 era."""
    return version >= VERSION


def _meta(params: Json) -> dict[str, Json] | None:
    meta = params.get("_meta") if isinstance(params, dict) else None
    return meta if isinstance(meta, dict) else None


def meta_of(params: Json) -> dict[str, Json]:
    """A message's `_meta` object, or an empty one."""
    return _meta(params) or {}


def has_claim(params: Json) -> bool:
    """Whether a message's params name a protocol version in `_meta`."""
    meta = _meta(params)
    return meta is not None and VERSION_KEY in meta


def claimed_version(params: Json) -> str | None:
    """The protocol version a message's `_meta` names, when it is a string."""
    meta = _meta(params)
    value = meta.get(VERSION_KEY) if meta is not None else None
    return value if isinstance(value, str) else None


def _received(meta: dict[str, Json], key: str) -> str:
    if key not in meta:
        return "undefined"
    value = meta[key]
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "array" if isinstance(value, list) else "object"


def _schema_issues(meta: dict[str, Json]) -> list[tuple[str, str]]:
    """The envelope schema's issues as `(path, message)`, in schema order."""
    issues: list[tuple[str, str]] = []
    if not isinstance(meta.get(VERSION_KEY), str):
        issues.append(
            (
                VERSION_KEY,
                f"Invalid input: expected string, received {_received(meta, VERSION_KEY)}",
            )
        )
    if INFO_KEY in meta:
        info = meta[INFO_KEY]
        if not isinstance(info, dict):
            message = f"Invalid input: expected object, received {_received(meta, INFO_KEY)}"
            issues.append((INFO_KEY, message))
        else:
            for name in ("name", "version"):
                if not isinstance(info.get(name), str):
                    received = _received(info, name)
                    message = f"Invalid input: expected string, received {received}"
                    issues.append((f"{INFO_KEY}.{name}", message))
    if not isinstance(meta.get(CAPABILITIES_KEY), dict):
        received = _received(meta, CAPABILITIES_KEY)
        issues.append((CAPABILITIES_KEY, f"Invalid input: expected object, received {received}"))
    if LOG_KEY in meta and meta[LOG_KEY] not in _LEVELS:
        levels = "|".join(f'"{level}"' for level in _LEVELS)
        issues.append((LOG_KEY, f"Invalid option: expected one of {levels}"))
    return issues


def envelope_issues(meta: dict[str, Json]) -> list[tuple[str, str]]:
    """Validates `_meta` as a per-request envelope: missing keys first, then schema issues."""
    issues = [(key, "missing") for key in _REQUIRED if key not in meta]
    missing = {key for key, _ in issues}
    issues += [issue for issue in _schema_issues(meta) if issue[0] not in missing]
    return issues


def envelope_error(params: Json) -> str | None:
    """The error a modern-era instance answers a request with when its envelope is invalid."""
    meta = _meta(params) or {}
    envelope = {key: meta[key] for key in _RESERVED if key in meta}
    if not envelope:
        return (
            "Request is missing the required _meta envelope for protocol revision 2026-07-28 "
            f"({', '.join(_REQUIRED)})"
        )
    issues = _schema_issues(envelope)
    if issues:
        listed = "; ".join(message for _, message in issues)
        return f"Invalid _meta envelope for protocol revision 2026-07-28: {listed}"
    return None


def encode(
    method: str, result: dict[str, Json], info: dict[str, Json], cache: CacheHint | None = None
) -> dict[str, Json]:
    """Stamps `resultType`, cache hints, and the server identity on a modern result."""
    out = dict(result)
    if out.get("resultType") != "input_required":
        out["resultType"] = "complete"
    if method in _CACHEABLE:
        # The server's hints cover lists and discovery; reads keep the defaults.
        hint = cache if method != "resources/read" else None
        ttl = hint.ttl_ms if hint is not None else None
        scope = hint.cache_scope if hint is not None else None
        out["ttlMs"] = 0 if ttl is None else ttl
        out["cacheScope"] = scope or "private"
    meta = dict(_js.as_object(out["_meta"])) if "_meta" in out else {}
    meta[SERVER_INFO_KEY] = info
    out["_meta"] = meta
    return out


def _error(status: int, code: int, message: str, data: Json, id_: Json) -> Response:
    error: dict[str, Json] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return Response.json({"jsonrpc": "2.0", "error": error, "id": id_}, status=status)


class _RejectError(Exception):
    def __init__(self, code: int, message: str, data: Json = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def _mismatch(header: str, body: str) -> _RejectError:
    message = f"Bad Request: the request headers and body disagree: {body}"
    return _RejectError(-32020, message, {"mismatch": {"header": header, "body": body}})


def unsupported(requested: str) -> tuple[int, str, dict[str, Json]]:
    """The UnsupportedProtocolVersion error for a requested revision."""
    data: dict[str, Json] = {"supported": [VERSION], "requested": requested}
    return -32022, f"Unsupported protocol version: {requested}", data


def _invalid_envelope(issue: tuple[str, str]) -> _RejectError:
    key, problem = issue
    message = f"Invalid _meta envelope for protocol revision 2026-07-28: {key}: {problem}"
    return _RejectError(-32602, message, {"envelope": {"key": key, "problem": problem}})


def is_modern_request(request: Request) -> bool:
    """Whether an MCP POST claims the 2026-07-28 revision, by header or by `_meta`."""
    text = request.text()
    if _js.json_parse_error(text) is not None:
        return False
    header = request.headers.get("mcp-protocol-version")
    if header is not None and header != "" and is_modern_version(header):
        return True
    body = _js.parse_json(text)
    return any(
        isinstance(message, dict) and has_claim(message.get("params"))
        for message in (body if isinstance(body, list) else [body])
    )


def _decode_name(value: str) -> str | None:
    if not (value.startswith("=?base64?") and value.endswith("?=")):
        return value
    payload = value[9:-2]
    if not _BASE64.match(payload):
        return None
    try:
        return base64.b64decode(payload).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None


def _classify(request: Request, body: Json) -> tuple[dict[str, Json], str]:
    """Routes a modern-claiming body: returns the message and its revision, or raises."""
    header = request.headers.get("mcp-protocol-version")
    method_header = request.headers.get("mcp-method")
    if isinstance(body, list):
        if not body:
            raise _RejectError(-32600, "Bad Request: empty JSON-RPC batch")
        for element in body:
            if isinstance(element, dict) and has_claim(element.get("params")):
                raise _RejectError(
                    -32600,
                    "Bad Request: JSON-RPC batches may not contain requests for protocol "
                    "revision 2026-07-28 or later",
                )
            if not is_message(element):
                raise _RejectError(
                    -32600, "Bad Request: JSON-RPC batch contains an invalid message"
                )
        raise _RejectError(
            -32600, "Bad Request: JSON-RPC batches are not supported by this endpoint"
        )
    if not is_message(body):
        raise _RejectError(-32600, "Bad Request: the request body is not a valid JSON-RPC message")
    assert isinstance(body, dict)
    if "method" not in body:
        raise _RejectError(
            -32600, "Bad Request: JSON-RPC responses cannot be posted to this endpoint"
        )
    method = str(body["method"])
    params = body.get("params")
    claimed = claimed_version(params)
    header_modern = header is not None and is_modern_version(header)
    if "id" not in body:
        if has_claim(params):
            if claimed is None:
                meta = _meta(params) or {}
                raise _invalid_envelope(
                    next(i for i in envelope_issues(meta) if i[0] == VERSION_KEY)
                )
            if header is not None and header != claimed:
                raise _mismatch(
                    header,
                    f"the notification envelope names protocol version {claimed} but the "
                    f"MCP-Protocol-Version header names {header}",
                )
            revision = claimed
        else:
            revision = str(header)
        if is_modern_version(revision) and method_header is not None and method_header != method:
            raise _mismatch(
                method_header,
                f"the notification body names method {method} but the Mcp-Method header "
                f"names {method_header}",
            )
        return body, revision
    meta = _meta(params)
    valid_claim = (
        claimed is not None and is_modern_version(claimed) and not envelope_issues(meta or {})
    )
    if method == "initialize" and not valid_claim:
        if header_modern:
            raise _mismatch(
                str(header),
                "an initialize request (legacy handshake) was sent with a modern "
                "MCP-Protocol-Version header",
            )
        requested = params.get("protocolVersion") if isinstance(params, dict) else None
        if isinstance(requested, str):
            raise _RejectError(*unsupported(requested))
        raise _RejectError(
            -32022,
            "Unsupported protocol version: the request did not name a protocol version",
            {"supported": [VERSION]},
        )
    if has_claim(params):
        issues = envelope_issues(meta or {})
        if issues:
            raise _invalid_envelope(issues[0])
        assert claimed is not None
        if header is not None and header != claimed:
            raise _mismatch(
                header,
                f"the body envelope names protocol version {claimed} but the "
                f"MCP-Protocol-Version header names {header}",
            )
        if method_header is not None and method_header != method:
            raise _mismatch(
                method_header,
                f"the body names method {method} but the Mcp-Method header names {method_header}",
            )
        return body, claimed
    missing: list[Json] = (
        ["_meta"]
        if meta is None
        else [key for key, problem in envelope_issues(meta) if problem == "missing"]
    )
    raise _RejectError(
        -32602,
        f"Invalid params: the MCP-Protocol-Version header names protocol revision {header}, "
        f"but the request is missing the required per-request envelope key(s): "
        f"{', '.join(str(key) for key in missing)}",
        {"envelope": {"missing": missing}},
    )


def _check_headers(request: Request, message: dict[str, Json], revision: str) -> None:
    method = str(message["method"])
    if request.headers.get("mcp-protocol-version") is None:
        raise _mismatch(
            "(missing)",
            f"the body envelope names protocol version {revision} but the required "
            "MCP-Protocol-Version header is absent",
        )
    if request.headers.get("mcp-method") is None:
        raise _mismatch(
            "(missing)",
            f"the body names method {method} but the required Mcp-Method header is absent",
        )
    field = _NAME_SOURCE.get(method)
    if field is None:
        return
    params = message.get("params")
    raw = params.get(field) if isinstance(params, dict) else None
    value = raw if isinstance(raw, str) else None
    header = request.headers.get("mcp-name")
    if header is None:
        if value is None:
            return
        raise _mismatch(
            "(missing)",
            f'the body carries params.{field}="{value}" but the required Mcp-Name header is absent',
        )
    decoded = _decode_name(header)
    if decoded is None:
        raise _mismatch(header, "the Mcp-Name header carries an invalid Base64 sentinel value")
    if value is not None and decoded != value:
        raise _mismatch(
            header,
            f'the body carries params.{field}="{value}" but the Mcp-Name header names "{decoded}"',
        )


def _param_text(value: Json) -> str | None:
    """The text a primitive argument travels as in an `Mcp-Param-*` header, or `None`."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if is_number(value):
        assert isinstance(value, (int, float))
        if not math.isfinite(value) or (value == int(value) and abs(value) > MAX_SAFE_INTEGER):
            return None
        return _js.number_to_string(value)
    return None


def _check_params(server: Server, request: Request, message: dict[str, Json]) -> None:
    """Checks a direct tool's `Mcp-Param-*` headers against the call's arguments."""
    params = message.get("params")
    name = (
        params.get("name")
        if message["method"] == "tools/call" and isinstance(params, dict)
        else None
    )
    tool = server.tools.get(name) if isinstance(name, str) else None
    if tool is None or not tool.headers or tool.inputs is None:
        return
    assert isinstance(params, dict)
    arguments = params.get("arguments")
    for f in tool.inputs.fields:
        if f.ty.header is None:
            continue
        key = f"Mcp-Param-{f.ty.header}"
        raw = arguments.get(f.name) if isinstance(arguments, dict) else None
        text = _param_text(raw) if raw is not None else None
        if text is None:
            continue
        header = request.headers.get(key)
        if header is None:
            raise _mismatch(
                key,
                f"the body carries {f.name}={_js.stringify(raw)} but the {key} header is absent",
            )
        decoded = _decode_name(header)
        if decoded is None:
            raise _mismatch(key, f"the {key} header carries an invalid Base64 sentinel value")
        if not _param_equal(f.ty, decoded, raw, text):
            raise _mismatch(
                key,
                f"the {key} header decodes to {_js.stringify(decoded)} but the body carries "
                f"{f.name}={_js.stringify(raw)}",
            )


def _param_equal(ty: Type, decoded: str, raw: Json, text: str) -> bool:
    """Compares integer inputs numerically, as `42.0` equals `42`, and others as text."""
    if (
        json_schema(ty, "input").get("type") == "integer"
        and _DECIMAL.fullmatch(decoded)
        and is_number(raw)
    ):
        return float(decoded) == raw
    return decoded == text


def _content_type(header: str | None) -> bool:
    essence = (header or "").split(";", 1)[0].strip().lower()
    return essence == "application/json"


async def handle_http(create: Callable[[], Server], request: Request) -> Response:
    """Answers a modern-claiming MCP POST with a fresh server instance."""
    if not _content_type(request.headers.get("content-type")):
        return _error(
            415, -32000, "Unsupported Media Type: Content-Type must be application/json", None, None
        )
    body = _js.parse_json(request.text())
    id_: Json = None
    if isinstance(body, dict) and isinstance(body.get("method"), str):
        raw = body.get("id")
        id_ = raw if isinstance(raw, (str, int)) and not isinstance(raw, bool) else None
    try:
        message, revision = _classify(request, body)
        if revision != VERSION:
            raise _RejectError(*unsupported(revision))
        if "id" in message:
            _check_headers(request, message, revision)
    except _RejectError as reject:
        return _error(400, reject.code, reject.message, reject.data, id_)

    if "id" not in message:
        return Response(status=202)
    try:
        server = create()
    except Error:
        return _error(500, -32603, "Internal server error", None, id_)
    try:
        _check_params(server, request, message)
    except _RejectError as reject:
        return _error(400, reject.code, reject.message, reject.data, id_)

    async def drop(_: dict[str, Json]) -> None:
        return None

    response = await server.handle_modern(message, drop, request)
    assert response is not None
    error = response.get("error")
    status = 404 if isinstance(error, dict) and error.get("code") == -32601 else 200
    return Response.json(response, status=status)
