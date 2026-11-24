"""The MCP server: commands as tools over stdio and streamable HTTP."""

from __future__ import annotations

import asyncio
import os
import re
import typing
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any, Literal, TextIO

from . import _js
from ._command import Command, Middleware, MiddlewareContext, Stream, ToolMeta, execute
from ._errors import Error, format_cta, unknown
from ._http import Request, Response
from ._js import Json
from ._model import build, to_json
from ._parser import check, parse_defaults, parse_env
from ._schema import Field, Type, json_schema, object_type, validate
from ._tree import Entry, Group, Spec

#: The protocol versions the server speaks, newest first.
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07")


@dataclass
class ToolAnnotations:
    """MCP tool annotations: hints that describe a tool's behavior to clients."""

    title: str | None = None
    """A human-readable title."""
    read_only_hint: bool | None = None
    """Whether the tool leaves its environment unchanged."""
    destructive_hint: bool | None = None
    """Whether the tool may perform destructive updates."""
    idempotent_hint: bool | None = None
    """Whether repeated calls with the same arguments have no additional effect."""
    open_world_hint: bool | None = None
    """Whether the tool interacts with an open world of external entities."""

    def to_json(self) -> dict[str, Json]:
        """Returns the annotations as MCP spells them."""
        names = {
            "title": self.title,
            "readOnlyHint": self.read_only_hint,
            "destructiveHint": self.destructive_hint,
            "idempotentHint": self.idempotent_hint,
            "openWorldHint": self.open_world_hint,
        }
        return {key: value for key, value in names.items() if value is not None}


@dataclass
class McpTool:
    """How a command appears as an MCP tool."""

    name: str | None = None
    """The tool name. Defaults to the command path joined with `_`."""
    description: str | None = None
    """The tool description. Defaults to the command's."""
    annotations: ToolAnnotations | None = None
    """Behavior hints for clients."""
    instructions: str | None = None
    """Usage instructions, sent as the tool's `_meta.instructions`."""

    def meta(self) -> ToolMeta:
        """Returns the tool settings as commands store them."""
        annotations = self.annotations.to_json() if self.annotations else None
        return ToolMeta(self.name, self.description, annotations, self.instructions)


@dataclass
class ToolFilter:
    """Which commands MCP clients see, and how they discover them."""

    discovery: Literal["direct", "progressive"] = "progressive"
    """`progressive` exposes search, inspect, and call tools instead of every command schema;
    `direct` lists every command as a tool."""
    include: list[str] | None = None
    """Tool name patterns to expose, where `*` matches any characters. Defaults to all."""
    exclude: list[str] = field(default_factory=list[str])
    """Tool name patterns to hide. Excludes win over includes."""


@dataclass
class McpOptions:
    """MCP server and registration settings."""

    agents: list[str] = field(default_factory=list[str])
    """Agents that `mcp add` targets by default, such as `claude-code` or `cursor`."""
    command: str | None = None
    """The command agents run to start the server. Detected when omitted."""
    instructions: str | None = None
    """Instructions describing how to use the server."""
    name: str | None = None
    """The server and registration name. Defaults to the CLI name."""
    stateless: bool = True
    """Whether MCP over HTTP runs without sessions."""
    title: str | None = None
    """A human-readable server title."""
    tools: ToolFilter | None = None
    """Which commands clients see."""


@dataclass
class Tool:
    """A command exposed as a tool."""

    name: str
    description: str | None
    command: Command
    middleware: list[Middleware]
    details: dict[str, Json]
    """The input schema `get_tool_details` reports."""
    output: dict[str, Json] | None
    annotations: dict[str, Json] | None
    instructions: str | None
    inputs: Type
    """Args, options, and globals merged, as direct tools validate input."""


#: Returns the config section of a command path, such as `project list`.
ConfigSection = Callable[[str], "dict[str, Json] | None"]


def with_defaults(ty: Type, values: dict[str, Json]) -> Type:
    """Returns a schema with parsed values as the defaults of their fields."""
    fields = [
        replace(f, ty=_with_default(f.ty, values[f.name])) if f.name in values else f
        for f in ty.fields
    ]
    return replace(ty, fields=fields)


def _with_default(ty: Type, value: Json) -> Type:
    """Returns a field schema with a new default."""
    if ty.raw is None:
        return replace(ty, default=value, null_default=value is None)
    # `.default()` wraps a converted schema: its JSON leads with the new default, and the field
    # is no longer optional.
    raw = {"default": value, **{k: v for k, v in ty.raw.items() if k != "default"}}
    return replace(
        ty, default=value, null_default=value is None, optional=False, required=None, raw=raw
    )


def collect(
    spec: Spec, filter_: ToolFilter | None, config: ConfigSection | None = None
) -> list[Tool]:
    """Collects the tools of a CLI, filtered and sorted by name.

    Raises:
        Error: When two tools share a name, or a config section is invalid.
    """
    tools = _entries(spec.commands, [], [], spec.globals, config)
    if filter_ is not None:
        includes = [_pattern(p) for p in filter_.include or []]
        excludes = [_pattern(p) for p in filter_.exclude]
        tools = [
            t
            for t in tools
            if not any(p.match(t.name) for p in excludes)
            and (not includes or any(p.match(t.name) for p in includes))
        ]
    seen: set[str] = set()
    for tool in tools:
        if tool.name in seen:
            raise unknown(f"Duplicate MCP tool name: {tool.name}")
        seen.add(tool.name)
    return sorted(tools, key=lambda t: _js.locale_key(t.name))


def _pattern(pattern: str) -> re.Pattern[str]:
    return re.compile("^" + ".*".join(re.escape(part) for part in pattern.split("*")) + "$")


def _entries(
    commands: dict[str, Entry],
    prefix: list[str],
    middleware: list[Middleware],
    globals_: Type | None,
    config: ConfigSection | None,
) -> list[Tool]:
    out: list[Tool] = []
    for name, entry in commands.items():
        path = [*prefix, name]
        if isinstance(entry, Group):
            if not entry.mcp:
                continue
            chain = [*middleware, *entry.middleware]
            if entry.root is not None and entry.root.mcp_enabled:
                out.append(_tool(entry.root, path, chain, globals_, config))
            out += _entries(entry.commands, path, chain, globals_, config)
        elif isinstance(entry, Command) and entry.mcp_enabled:
            out.append(_tool(entry, path, middleware, globals_, config))
    return out


def _tool(
    command: Command,
    path: list[str],
    middleware: list[Middleware],
    globals_: Type | None,
    config: ConfigSection | None,
) -> Tool:
    # Config values become option defaults, so a call's own arguments still win.
    section = config(" ".join(path)) if config is not None else None
    if section is not None:
        values = parse_defaults(section, command.options)
        # Without options, any key fails above, so the section reaches only commands with options.
        options = typing.cast("Type", command.options)
        command = replace(command, options=with_defaults(options, values))
    meta = command.mcp or ToolMeta()
    properties: dict[str, Json] = {}
    required: list[Json] = []
    merged: dict[str, Field] = {}
    for schema in (command.args, command.options, globals_):
        if schema is None:
            continue
        out = json_schema(schema)
        properties.update(_js.as_object(out["properties"]))
        required += _js.as_list(out.get("required", []))
        for f in schema.fields:
            merged[f.name] = f
    details: dict[str, Json] = {"type": "object", "properties": properties}
    if required:
        details["required"] = required
    output = json_schema(command.output) if command.output is not None else None
    return Tool(
        name=meta.name or "_".join(path),
        description=meta.description or command.description,
        command=command,
        middleware=middleware,
        details=details,
        output=output if output is not None and output.get("type") == "object" else None,
        annotations=meta.annotations,
        instructions=meta.instructions,
        inputs=object_type(list(merged.values())),
    )


#: Sends a progress message for a streamed chunk.
Progress = Callable[[Json], Awaitable[None]]


async def call_tool(
    spec: Spec,
    tool: Tool,
    params: dict[str, Json],
    *,
    parsed: bool = False,
    progress: Progress | None = None,
    request: Request | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Json]:
    """Runs a tool's command with flat parameters and returns a tool result."""
    command = tool.command
    source = os.environ if env is None else env
    name = spec.name
    globals_: dict[str, Json] = {}
    inputs = params
    if spec.globals is not None:
        arg_keys = {f.name for f in command.args.fields} if command.args else set[str]()
        global_keys = {f.name for f in spec.globals.fields}
        raw: dict[str, Json] = {}
        inputs = {}
        for key, value in params.items():
            if key in global_keys:
                raw[key] = value
            if key not in global_keys or key in arg_keys:
                inputs[key] = value
        try:
            globals_ = raw if parsed else check(spec.globals, raw)
        except Error as error:
            body: dict[str, Json] = {"code": error.code, "message": error.message}
            body["fieldErrors"] = [f.to_json() for f in error.field_errors or []]
            return {"content": [_text(_js.stringify(body))], "isError": True}

    context = spec_context(spec, tool.name, globals_, request)

    def parse() -> tuple[dict[str, Json], dict[str, Json], dict[str, Json]]:
        arg_keys = {f.name for f in command.args.fields} if command.args else set[str]()
        args = {k: v for k, v in inputs.items() if k in arg_keys}
        options = {k: v for k, v in inputs.items() if k not in arg_keys}
        return (
            check(command.args, args) if command.args else {},
            check(command.options, options) if command.options else {},
            parse_env(command.env, source.get) if command.env else {},
        )

    streamed: list[dict[str, Json]] = []

    async def sink(chunks: Stream) -> None:
        values: list[Json] = []
        try:
            async for chunk in chunks:
                value = to_json(chunk)
                values.append(value)
                if progress is not None:
                    await progress(value)
        except Error as error:
            streamed.append(_failure(error, name))
            return
        except Exception as error:
            streamed.append(_failure(unknown(str(error)), name))
            return
        final = chunks.final
        cta = format_cta(name, getattr(final, "cta", None))
        text = _js.stringify(values)
        result: dict[str, Json] = {}
        if cta is not None:
            result["_meta"] = {"cta": cta.to_json()}
        result["content"] = [_text(f"{text}\n\n{cta.text()}" if cta else text)]
        streamed.append(result)

    chain = [*spec.middleware, *tool.middleware, *command.middleware]
    try:
        if spec.env is not None:
            context.env = build(spec.env, parse_env(spec.env, source.get))
    except Error as error:
        return _failure(error, name)
    outcome = await execute(command, context, chain, parse, sink)
    if outcome is None:
        return streamed[0]
    if isinstance(outcome, Error):
        return _failure(outcome, name)
    data = outcome.data
    cta = format_cta(name, outcome.cta)
    text = _js.stringify(data)
    result: dict[str, Json] = {}
    if cta is not None:
        result["_meta"] = {"cta": cta.to_json()}
    result["content"] = [_text(f"{text}\n\n{cta.text()}" if cta else text)]
    if data is not None and tool.output is not None:
        result["structuredContent"] = data
    return result


def spec_context(spec: Spec, path: str, globals_: dict[str, Json], request: Request | None) -> Any:
    """Creates the middleware context of an agent run over MCP or HTTP."""
    return MiddlewareContext[Any, Any, Any](
        agent=True,
        command=path,
        display_name=spec.name,
        env=None,
        format="json",
        format_explicit=True,
        globals=build(spec.globals, globals_) if spec.globals else None,
        name=spec.name,
        var=spec.vars_instance(),
        version=spec.version,
        request=request,
    )


def _text(text: str) -> dict[str, Json]:
    return {"type": "text", "text": text}


def _failure(error: Error, name: str) -> dict[str, Json]:
    """Renders a failed command as a tool error."""
    cta = format_cta(name, error.cta)
    text = _js.stringify(error.to_json()) if error.field_errors else error.message
    if error.hint:
        text += f"\nHint: {error.hint}"
    if cta is not None:
        text += f"\n\n{cta.text()}"
    meta: dict[str, Json] = {}
    if cta is not None:
        meta["cta"] = cta.to_json()
    details: dict[str, Json] = {"code": error.code}
    if error.exit_code is not None:
        details["exitCode"] = error.exit_code
    if error.retryable is not None:
        details["retryable"] = error.retryable
    meta["error"] = details
    return {"_meta": meta, "content": [_text(text)], "isError": True}


def _tool_result(value: Json) -> dict[str, Json]:
    return {"content": [_text(_js.stringify(value))]}


def _tool_error(message: str) -> dict[str, Json]:
    return {"content": [_text(_js.stringify({"error": message}))], "isError": True}


def _search(tools: list[Tool], query: str) -> list[Tool]:
    normalized = _normalize_search(query)
    terms = [t for t in normalized.split(" ") if t]
    scored = [(tool, _score(tool, normalized, terms)) for tool in tools]
    matches = [(tool, score) for tool, score in scored if score > 0]
    matches.sort(key=lambda m: (-m[1], _js.locale_key(m[0].name)))
    return [tool for tool, _ in matches]


def _score(tool: Tool, query: str, terms: list[str]) -> int:
    name = _normalize_search(tool.name)
    description = _normalize_search(tool.description or "")
    if name == query:
        return 1000
    score = 100 if name.startswith(query) else 50 if query in name else 0
    for term in terms:
        if term in name.split(" "):
            score += 20
        elif term in name:
            score += 10
        if term in description:
            score += 2
    return score


def _normalize_search(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower(), flags=re.ASCII).strip(" ")


def _int(name: str, description: str, default: int, low: int, high: int | None = None) -> Field:
    return Field(
        name,
        Type("integer", description=description, default=default, min=low, max=high),
    )


_SEARCH_INPUT = object_type(
    [
        _int("limit", "Maximum matches.", 5, 1, 20),
        _int("offset", "Matches to skip.", 0, 0),
        Field(
            "query",
            Type("string", default="", description="Capability to find. Empty lists all tools."),
        ),
    ]
)
_NAME = Field("name", Type("string", min=1, description="Exact tool name."))
_DETAILS_INPUT = object_type([_NAME])
_CALL_INPUT = object_type(
    [
        _NAME,
        Field(
            "arguments",
            Type("record", default={}, description="Arguments from its schema."),
        ),
    ]
)
_CATALOG: dict[str, Json] = {
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": False,
    "readOnlyHint": True,
}
_READ: dict[str, Json] = {**_CATALOG, "openWorldHint": True}
_WRITE: dict[str, Json] = {
    "destructiveHint": True,
    "idempotentHint": False,
    "openWorldHint": True,
    "readOnlyHint": False,
}


@dataclass
class _Registered:
    """A tool as the server lists and calls it."""

    name: str
    description: str | None
    inputs: Type | None
    run: Callable[[dict[str, Json], Progress | None, Request | None], Awaitable[dict[str, Json]]]
    annotations: dict[str, Json] | None = None
    output: dict[str, Json] | None = None
    meta: dict[str, Json] | None = None


class Server:
    """An MCP server answering JSON-RPC messages for a CLI's tools."""

    def __init__(
        self,
        spec: Spec,
        env: dict[str, str] | None = None,
        *,
        direct: bool = False,
        config: ConfigSection | None = None,
    ) -> None:
        self.spec = spec
        options = spec.mcp or McpOptions()
        filter_ = options.tools
        if direct:
            filter_ = replace(filter_ or ToolFilter(), discovery="direct")
        self.name = options.name or spec.name
        self.title = options.title
        self.instructions = options.instructions
        self.version = spec.version or "0.0.0"
        self.env = env
        self.tools = self._register(collect(spec, filter_, config), filter_)

    def _register(self, tools: list[Tool], filter_: ToolFilter | None) -> dict[str, _Registered]:
        if not tools:
            return {}
        if (filter_.discovery if filter_ else "progressive") == "direct":
            return {tool.name: self._direct(tool) for tool in tools}
        by_name = {tool.name: tool for tool in tools}
        spec = self.spec

        async def search(params: dict[str, Json], *_: object) -> dict[str, Json]:
            matches = _search(tools, str(params["query"]))
            offset = int(typing.cast("int", params["offset"]))
            limit = int(typing.cast("int", params["limit"]))
            page = matches[offset : offset + limit]
            listed: list[Json] = []
            for tool in page:
                item: dict[str, Json] = {"name": tool.name}
                if tool.description:
                    item["description"] = tool.description
                if tool.annotations:
                    item["annotations"] = tool.annotations
                listed.append(item)
            out: dict[str, Json] = {"tools": listed}
            if offset + len(page) < len(matches):
                out["nextOffset"] = offset + len(page)
            return _tool_result(out)

        async def details(params: dict[str, Json], *_: object) -> dict[str, Json]:
            tool = by_name.get(str(params["name"]))
            if tool is None:
                return _tool_error(f"Unknown tool: {params['name']}")
            out: dict[str, Json] = {"name": tool.name}
            if tool.description:
                out["description"] = tool.description
            out["inputSchema"] = tool.details
            if tool.output:
                out["outputSchema"] = tool.output
            if tool.annotations:
                out["annotations"] = tool.annotations
            if tool.instructions:
                out["instructions"] = tool.instructions
            return _tool_result(out)

        def caller(read: bool) -> Callable[..., Awaitable[dict[str, Json]]]:
            async def call(
                params: dict[str, Json], progress: Progress | None, request: Request | None
            ) -> dict[str, Json]:
                name = str(params["name"])
                tool = by_name.get(name)
                if tool is None:
                    return _tool_error(f"Unknown tool: {name}")
                read_only = (tool.annotations or {}).get("readOnlyHint") is True
                if read and not read_only:
                    return _tool_error(f"Tool is not read-only: {name}")
                if not read and read_only:
                    return _tool_error(f"Tool is read-only: {name}")
                arguments = _js.as_object(params["arguments"])
                return await call_tool(
                    spec, tool, arguments, progress=progress, request=request, env=self.env
                )

            return call

        registered = [
            _Registered(
                "search_tools",
                "Search or page through available tools by capability. Returns names and "
                "descriptions without loading their schemas. Inspect a result before calling it.",
                _SEARCH_INPUT,
                search,
                _CATALOG,
            ),
            _Registered(
                "get_tool_details",
                "Inspect one tool returned by search_tools. Returns its complete input schema "
                "and metadata.",
                _DETAILS_INPUT,
                details,
                _CATALOG,
            ),
            _Registered(
                "call_read_tool",
                "Execute a tool marked read-only after inspecting its schema with "
                "get_tool_details.",
                _CALL_INPUT,
                caller(read=True),
                _READ,
            ),
            _Registered(
                "call_write_tool",
                "Execute a writable or unclassified tool after inspecting its schema with "
                "get_tool_details.",
                _CALL_INPUT,
                caller(read=False),
                _WRITE,
            ),
        ]
        return {r.name: r for r in registered}

    def _direct(self, tool: Tool) -> _Registered:
        spec = self.spec

        async def run(
            params: dict[str, Json], progress: Progress | None, request: Request | None
        ) -> dict[str, Json]:
            return await call_tool(
                spec, tool, params, parsed=True, progress=progress, request=request, env=self.env
            )

        return _Registered(
            tool.name,
            tool.description,
            tool.inputs if tool.inputs.fields else None,
            run,
            tool.annotations,
            tool.output,
            {"instructions": tool.instructions} if tool.instructions else None,
        )

    def initialize(self, params: Json) -> dict[str, Json]:
        """Answers `initialize`, negotiating the protocol version."""
        requested = params.get("protocolVersion") if isinstance(params, dict) else None
        version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        info: dict[str, Json] = {"name": self.name}
        if self.title:
            info["title"] = self.title
        info["version"] = self.version
        out: dict[str, Json] = {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": info,
        }
        if self.instructions:
            out["instructions"] = self.instructions
        return out

    def list_tools(self) -> dict[str, Json]:
        """Answers `tools/list`."""
        tools: list[Json] = []
        for tool in self.tools.values():
            item: dict[str, Json] = {"name": tool.name}
            if tool.description is not None:
                item["description"] = tool.description
            if tool.inputs is not None:
                schema = json_schema(tool.inputs, "input")
                item["inputSchema"] = {
                    "type": "object",
                    "$schema": "https://json-schema.org/draft/2020-12/schema",
                    **{k: v for k, v in schema.items() if k != "type"},
                }
            else:
                item["inputSchema"] = {"type": "object", "properties": {}}
            if tool.annotations is not None:
                item["annotations"] = tool.annotations
            if tool.meta is not None:
                item["_meta"] = tool.meta
            if tool.output is not None:
                item["outputSchema"] = tool.output
            tools.append(item)
        return {"tools": tools}

    async def call(
        self, params: dict[str, Json], progress: Progress | None, request: Request | None
    ) -> dict[str, Json]:
        """Answers `tools/call`.

        Raises:
            RpcError: When the tool does not exist.
        """
        name = params.get("name")
        tool = self.tools.get(name) if isinstance(name, str) else None
        if tool is None:
            raise RpcError(-32602, f"Tool {name} not found")
        arguments = params.get("arguments")
        value: dict[str, Json] = arguments if isinstance(arguments, dict) else {}
        if tool.inputs is not None:
            parsed, issues = validate(tool.inputs, value)
            if issues:
                listed = ", ".join(
                    f"{'.'.join(_js.to_string(p) for p in i.path)}: {i.message}"
                    if i.path
                    else i.message
                    for i in issues
                )
                message = f"Input validation error: Invalid arguments for tool {name}: {listed}"
                return {"content": [_text(message)], "isError": True}
            value = parsed
        try:
            result = await tool.run(value, progress, request)
        except Exception as error:
            return {"content": [_text(str(error))], "isError": True}
        if (
            tool.output is not None
            and not result.get("isError")
            and "structuredContent" not in result
        ):
            message = (
                f"Output validation error: Tool {name} has an output schema but no structured "
                "content was provided"
            )
            return {"content": [_text(message)], "isError": True}
        return result

    async def handle(
        self,
        message: dict[str, Json],
        notify: Callable[[dict[str, Json]], Awaitable[None]],
        request: Request | None = None,
    ) -> dict[str, Json] | None:
        """Answers one JSON-RPC request. Returns `None` for notifications and other messages."""
        method = message.get("method")
        if not isinstance(method, str) or "id" not in message:
            return None
        id_ = message["id"]
        params = message.get("params")
        params = params if isinstance(params, dict) else {}
        try:
            if method == "initialize":
                result = self.initialize(params)
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = self.list_tools()
            elif method == "tools/call":
                meta = params.get("_meta")
                token = meta.get("progressToken") if isinstance(meta, dict) else None
                progress = None
                if isinstance(token, (str, int)) and not isinstance(token, bool):
                    count = [0]

                    async def send_progress(value: Json) -> None:
                        count[0] += 1
                        await notify(
                            {
                                "jsonrpc": "2.0",
                                "method": "notifications/progress",
                                "params": {
                                    "progressToken": token,
                                    "progress": count[0],
                                    "message": _js.stringify(value),
                                },
                            }
                        )

                    progress = send_progress
                result = await self.call(params, progress, request)
            else:
                raise RpcError(-32601, "Method not found")
        except RpcError as error:
            return {
                "jsonrpc": "2.0",
                "id": id_,
                "error": {"code": error.code, "message": error.message},
            }
        return {"result": result, "jsonrpc": "2.0", "id": id_}


class RpcError(Exception):
    """A JSON-RPC error response."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


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


async def serve_stdio(server: Server, stdin: TextIO, stdout: TextIO) -> None:
    """Serves MCP over stdio until the input ends: one JSON-RPC message per line."""

    async def write(message: dict[str, Json]) -> None:
        stdout.write(_js.stringify(message) + "\n")
        stdout.flush()

    while True:
        line = await asyncio.to_thread(stdin.readline)
        if not line:
            return
        message = _js.parse_json(line) if _js.json_parse_error(line) is None else None
        if message is None or not is_message(message):
            continue
        assert isinstance(message, dict)
        response = await server.handle(message, write)
        if response is not None:
            await write(response)


def _json_error(status: int, code: int, message: str) -> Response:
    return Response.json(
        {"jsonrpc": "2.0", "error": {"code": code, "message": message}, "id": None},
        status=status,
    )


class HttpTransport:
    """Streamable HTTP for one server, answering with JSON responses."""

    def __init__(self, server: Server, *, sessions: bool) -> None:
        self.server = server
        self.sessions = sessions
        self.session: str | None = None
        self.initialized = False

    def _check_session(self, request: Request) -> Response | None:
        if not self.sessions:
            return None
        if not self.initialized:
            return _json_error(400, -32000, "Bad Request: Server not initialized")
        session = request.headers.get("mcp-session-id")
        if not session:
            return _json_error(400, -32000, "Bad Request: Mcp-Session-Id header is required")
        if session != self.session:
            return _json_error(404, -32001, "Session not found")
        version = request.headers.get("mcp-protocol-version")
        if version is not None and version not in PROTOCOL_VERSIONS:
            return _json_error(
                400,
                -32000,
                f"Bad Request: Unsupported protocol version: {version} "
                f"(supported versions: {', '.join(PROTOCOL_VERSIONS)})",
            )
        return None

    async def handle(self, request: Request) -> Response:
        """Answers an HTTP request."""
        if request.method == "GET":
            if "text/event-stream" not in (request.headers.get("accept") or ""):
                return _json_error(
                    406, -32000, "Not Acceptable: Client must accept text/event-stream"
                )
            return self._check_session(request) or _json_error(405, -32000, "Method not allowed.")
        if request.method == "DELETE":
            failure = self._check_session(request)
            if failure is not None:
                return failure
            self.initialized = False
            self.session = None
            return Response(status=200)
        if request.method != "POST":
            response = _json_error(405, -32000, "Method not allowed.")
            response.headers.set("allow", "GET, POST, DELETE")
            return response
        accept = request.headers.get("accept") or ""
        if "application/json" not in accept or "text/event-stream" not in accept:
            return _json_error(
                406,
                -32000,
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            )
        if "application/json" not in (request.headers.get("content-type") or ""):
            return _json_error(
                415, -32000, "Unsupported Media Type: Content-Type must be application/json"
            )
        text = request.text()
        if _js.json_parse_error(text) is not None:
            return _json_error(400, -32700, "Parse error: Invalid JSON")
        raw = _js.parse_json(text)
        messages: list[Json] = raw if isinstance(raw, list) else [raw]
        if not all(is_message(m) for m in messages):
            return _json_error(400, -32700, "Parse error: Invalid JSON-RPC message")
        typed = [m for m in messages if isinstance(m, dict)]
        initializing = any(m.get("method") == "initialize" and "id" in m for m in typed)
        if initializing:
            if self.initialized and self.session is not None:
                return _json_error(400, -32600, "Invalid Request: Server already initialized")
            if len(typed) > 1:
                return _json_error(
                    400, -32600, "Invalid Request: Only one initialization request is allowed"
                )
            self.session = str(uuid.uuid4()) if self.sessions else None
            self.initialized = True
        else:
            failure = self._check_session(request)
            if failure is not None:
                return failure

        async def drop(_: dict[str, Json]) -> None:
            return None

        responses: list[Json] = []
        for message in typed:
            response = await self.server.handle(message, drop, request)
            if response is not None:
                responses.append(response)
        if not any("method" in m and "id" in m for m in typed):
            return Response(status=202)
        headers = {"mcp-session-id": self.session} if self.session is not None else None
        body = responses[0] if len(responses) == 1 else responses
        return Response.json(body, headers=headers)


class HttpHandler:
    """MCP over HTTP for a CLI: one session, or a fresh server per request when stateless."""

    def __init__(self, spec: Spec) -> None:
        self.spec = spec
        self.transport: HttpTransport | None = None

    async def __call__(self, request: Request) -> Response:
        options = self.spec.mcp or McpOptions()
        if options.stateless:
            if request.method != "POST":
                return Response(status=405, headers={"allow": "POST"})
            return await HttpTransport(Server(self.spec), sessions=False).handle(request)
        if self.transport is None:
            self.transport = HttpTransport(Server(self.spec), sessions=True)
        return await self.transport.handle(request)
