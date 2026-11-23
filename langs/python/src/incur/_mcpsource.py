"""Remote MCP servers as command groups: a streamable-HTTP client and generated commands."""

from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from typing import Any

from . import _js
from ._command import Command, Context, ToolMeta
from ._errors import Error
from ._http import FetchHandler, Headers, Request, call, normalize_url, parse_json
from ._http import fetch as default_fetch
from ._js import Json
from ._jsonschema import coerce, convert, describe, optional
from ._schema import Field, Type, object_type
from ._tree import Entry

PROTOCOL_VERSION = "2025-06-18"
_CATALOG = frozenset({"search_tools", "get_tool_details", "call_read_tool", "call_write_tool"})


class Source:
    """A remote MCP server reached over streamable HTTP, with its session state."""

    def __init__(self, url: str, fetch: FetchHandler | None, headers: Mapping[str, str]) -> None:
        self.url = normalize_url(url)
        self.fetch: FetchHandler = fetch or default_fetch
        self.headers = dict(headers)
        self.session: str | None = None
        self.initialized = False
        self.progressive = False

    async def request(self, method: str, params: Json = None) -> dict[str, Json]:
        """Sends a JSON-RPC request or notification and returns its result.

        Raises:
            RuntimeError: When the server answers with an HTTP or JSON-RPC error.
        """
        notification = method.startswith("notifications/")
        id_ = None if notification else str(uuid.uuid4())
        headers = Headers(self.headers)
        headers.set("content-type", "application/json")
        headers.set("accept", "application/json, text/event-stream")
        if self.session:
            headers.set("mcp-session-id", self.session)
        if self.initialized:
            headers.set("mcp-protocol-version", PROTOCOL_VERSION)
        message: dict[str, Json] = {"jsonrpc": "2.0"}
        if id_ is not None:
            message["id"] = id_
        message["method"] = method
        if params is not None:
            message["params"] = params
        body = _js.stringify(message)
        response = await call(
            self.fetch, Request(self.url, method="POST", headers=headers, body=body)
        )
        session = response.headers.get("mcp-session-id")
        if session:
            self.session = session
        if not response.ok:
            raise RuntimeError(f"MCP HTTP {response.status}")
        if notification and response.status == 202:
            return {}
        text = await response.text()
        if not text:
            return {}
        if "text/event-stream" in (response.headers.get("content-type") or ""):
            reply = _sse(text, id_)
        else:
            reply = _js.as_object(parse_json(text))
        error = reply.get("error")
        if isinstance(error, dict):
            message_text = error.get("message")
            raise RuntimeError(
                message_text if isinstance(message_text, str) else "MCP request failed"
            )
        result = reply.get("result")
        return result if isinstance(result, dict) else {}

    async def call(self, name: str, arguments: dict[str, Json]) -> Json:
        """Calls a tool of the server's catalog, failing on tool errors."""
        result = await self.request("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise RuntimeError(_text(result) or f"MCP tool failed: {name}")
        return _value(result)


def _sse(text: str, id_: str | None) -> dict[str, Json]:
    """Finds the JSON-RPC message answering `id_` in a server-sent event stream."""
    for event in re.split(r"\r?\n\r?\n", text):
        lines = [
            line[5:].lstrip() for line in re.split(r"\r?\n", event) if line.startswith("data:")
        ]
        data = "\n".join(lines)
        if not data:
            continue
        message = _js.as_object(parse_json(data))
        if id_ is None or message.get("id") == id_:
            return message
    raise RuntimeError("MCP SSE response did not include the matching JSON-RPC message")


def _text(result: dict[str, Json]) -> str:
    content = result.get("content")
    items = content if isinstance(content, list) else []
    texts = [
        item.get("text") for item in items if isinstance(item, dict) and item.get("type") == "text"
    ]
    return "\n".join(t for t in texts if isinstance(t, str) and t)


def _value(result: dict[str, Json]) -> Json:
    """The value of a tool result: structured content, or its text parsed as JSON."""
    if "structuredContent" in result:
        return result["structuredContent"]
    content = result.get("content")
    items = content if isinstance(content, list) else []
    texts: list[Json] = [
        item["text"]
        for item in items
        if isinstance(item, dict)
        and item.get("type") == "text"
        and isinstance(item.get("text"), str)
    ]
    if len(texts) == 1:
        text = str(texts[0])
        return _js.parse_json(text) if _js.json_parse_error(text) is None else text
    return texts


async def _tools(source: Source) -> list[dict[str, Json]]:
    """Initializes the server and lists its tools, paging through a progressive catalog."""
    await source.request(
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "incur", "version": "1.0.0"},
        },
    )
    source.initialized = True
    await source.request("notifications/initialized")
    listed = source.request("tools/list")
    tools = [t for t in _js.as_list((await listed).get("tools") or []) if isinstance(t, dict)]
    names = frozenset(name for t in tools if isinstance(name := t.get("name"), str))
    if len(tools) != 4 or names != _CATALOG:
        return tools
    source.progressive = True
    found: list[dict[str, Json]] = []
    offset: int | None = 0
    while offset is not None:
        search = _js.as_object(
            await source.call("search_tools", {"query": "", "limit": 20, "offset": offset})
        )
        for match in _js.as_list(search.get("tools") or []):
            name = match.get("name") if isinstance(match, dict) else None
            if not name:
                continue
            tool = await source.call("get_tool_details", {"name": name})
            if isinstance(tool, dict) and tool.get("name"):
                found.append(tool)
        nxt = search.get("nextOffset")
        nxt = int(nxt) if isinstance(nxt, (int, float)) and not isinstance(nxt, bool) else None
        if nxt is not None and nxt <= offset:
            raise RuntimeError("MCP tool catalog returned a non-advancing offset")
        offset = nxt
    return found


def _options(schema: dict[str, Json]) -> Type | None:
    """Options from a tool's input schema: one per property, numbers and booleans coerced."""
    properties = schema.get("properties")
    required = schema.get("required")
    names = set(required) if isinstance(required, list) else set[Json]()
    fields: list[Field] = []
    for key, prop in (properties if isinstance(properties, dict) else {}).items():
        ty = convert(prop)
        if key not in names:
            ty = optional(ty)
        description = prop.get("description") if isinstance(prop, dict) else None
        if isinstance(description, str):
            ty = describe(ty, description)
        fields.append(Field(key, coerce(ty)))
    return object_type(fields) if fields else None


async def commands(source: Source) -> dict[str, Entry]:
    """Generates a command per remote tool, calling it through `tools/call`."""
    out: dict[str, Entry] = {}
    for tool in await _tools(source):
        name = str(tool["name"])
        input_schema = tool.get("inputSchema")
        output_schema = tool.get("outputSchema")
        annotations = tool.get("annotations")
        description = tool.get("description")
        out[name] = Command(
            handler=_handler(source, name, annotations),
            description=description if isinstance(description, str) else None,
            options=_options(input_schema) if isinstance(input_schema, dict) else None,
            output=(
                convert(output_schema)
                if isinstance(output_schema, dict) and output_schema.get("type") == "object"
                else None
            ),
            mcp=ToolMeta(annotations=annotations) if isinstance(annotations, dict) else None,
        )
    return out


def _handler(source: Source, name: str, annotations: Json) -> Any:
    read_only = isinstance(annotations, dict) and annotations.get("readOnlyHint") is True

    async def run(c: Context[Any, Any]) -> Json:
        params: dict[str, Json] = {"name": name, "arguments": dict(c.options or {})}
        if source.progressive:
            tool = "call_read_tool" if read_only else "call_write_tool"
            params = {"name": tool, "arguments": params}
        result = await source.request("tools/call", params)
        if result.get("isError"):
            raise Error("MCP_TOOL_ERROR", _text(result))
        return _value(result)

    return run
