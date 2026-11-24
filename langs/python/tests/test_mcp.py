"""MCP server behavior the differential suite does not reach: transport edge cases and tool
failures that need Python-side setup.
"""

from __future__ import annotations

import asyncio
import io
import json
from typing import Any

from inline_snapshot import snapshot

import incur
from incur import Context

_INIT: dict[str, Any] = {
    "jsonrpc": "2.0",
    "id": 0,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}},
}


def mcp(cli: incur.Cli, *lines: object, env: dict[str, str] | None = None) -> list[Any]:
    """Serves `--mcp` over the given input lines and returns every response after `initialize`."""
    messages = [_INIT, {"jsonrpc": "2.0", "method": "notifications/initialized"}, *lines]
    text = "".join((m if isinstance(m, str) else json.dumps(m)) + "\n" for m in messages)
    stdout = io.StringIO()
    cli.serve_with(["--mcp"], env=env, stdin=io.StringIO(text), stdout=stdout)
    return [json.loads(line) for line in stdout.getvalue().splitlines()][1:]


def call(name: str, arguments: dict[str, Any] | None = None, id_: int = 1) -> dict[str, Any]:
    params: dict[str, Any] = {"name": name, "arguments": arguments or {}}
    return {"jsonrpc": "2.0", "id": id_, "method": "tools/call", "params": params}


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class TokenEnv:
    api_token: str


@incur.schema
class Out:
    total: int


class Broken:
    def __init__(self) -> None:
        raise RuntimeError("vars unavailable")


def direct(**options: Any) -> incur.McpOptions:
    return incur.McpOptions(tools=incur.ToolFilter(discovery="direct"), **options)


def test_tool_failures() -> None:
    cli = incur.Cli("tool", update=False, env=TokenEnv, mcp=direct())

    @cli.command("ping", description="Ping")
    def ping(c: Context) -> str:
        return "pong"

    @cli.command("count", output=Out)
    def count(c: Context) -> None:
        return None

    assert mcp(cli, call("ping"), call("count", id_=2), env={}) == snapshot(
        [
            {
                "result": {
                    "_meta": {"error": {"code": "VALIDATION_ERROR"}},
                    "content": [
                        {
                            "type": "text",
                            "text": '{"code":"VALIDATION_ERROR","message":"Invalid input: expected string, received undefined\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"API_TOKEN\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  }\\n]","fieldErrors":[{"code":"invalid_type","missing":true,"path":"API_TOKEN","expected":"string","received":"","message":"Invalid input: expected string, received undefined"}]}',
                        }
                    ],
                    "isError": True,
                },
                "jsonrpc": "2.0",
                "id": 1,
            },
            {
                "result": {
                    "_meta": {"error": {"code": "VALIDATION_ERROR"}},
                    "content": [
                        {
                            "type": "text",
                            "text": '{"code":"VALIDATION_ERROR","message":"Invalid input: expected string, received undefined\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"API_TOKEN\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  }\\n]","fieldErrors":[{"code":"invalid_type","missing":true,"path":"API_TOKEN","expected":"string","received":"","message":"Invalid input: expected string, received undefined"}]}',
                        }
                    ],
                    "isError": True,
                },
                "jsonrpc": "2.0",
                "id": 2,
            },
        ]
    )
    assert mcp(cli, call("ping"), env={"API_TOKEN": "t"}) == snapshot(
        [{"result": {"content": [{"type": "text", "text": '"pong"'}]}, "jsonrpc": "2.0", "id": 1}]
    )
    assert mcp(cli, call("count"), env={"API_TOKEN": "t"}) == snapshot(
        [
            {
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": "Output validation error: Tool count has an output schema but no structured content was provided",
                        }
                    ],
                    "isError": True,
                },
                "jsonrpc": "2.0",
                "id": 1,
            }
        ]
    )


def test_tool_exceptions() -> None:
    cli = incur.Cli("tool", update=False, vars=Broken, mcp=direct())

    @cli.command("ping")
    def ping(c: Context) -> str:
        return "pong"

    assert mcp(cli, call("ping")) == snapshot(
        [
            {
                "result": {
                    "content": [{"type": "text", "text": "vars unavailable"}],
                    "isError": True,
                },
                "jsonrpc": "2.0",
                "id": 1,
            }
        ]
    )


def test_ignores_invalid_lines() -> None:
    cli = incur.Cli("tool", update=False, mcp=direct())

    @cli.command("ping")
    def ping(c: Context) -> str:
        return "pong"

    assert mcp(cli, "1", "{", '{"jsonrpc": "2.0"}', call("ping")) == snapshot(
        [{"result": {"content": [{"type": "text", "text": '"pong"'}]}, "jsonrpc": "2.0", "id": 1}]
    )


def test_search_and_details() -> None:
    cli = incur.Cli("tool", update=False)

    @cli.command("listing", mcp=incur.McpTool(instructions="Call with care."))
    def listing(c: Context) -> str:
        return "ok"

    @cli.command("list_users", description="List all users")
    def users(c: Context) -> str:
        return "ok"

    search = {"query": "list users", "limit": 10, "offset": 0}
    assert mcp(
        cli,
        call("search_tools", search),
        call("get_tool_details", {"name": "listing"}, 2),
    ) == snapshot(
        [
            {
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": '{"tools":[{"name":"list_users","description":"List all users"},{"name":"listing"}]}',
                        }
                    ]
                },
                "jsonrpc": "2.0",
                "id": 1,
            },
            {
                "result": {
                    "content": [
                        {
                            "type": "text",
                            "text": '{"name":"listing","inputSchema":{"type":"object","properties":{}},"instructions":"Call with care."}',
                        }
                    ]
                },
                "jsonrpc": "2.0",
                "id": 2,
            },
        ]
    )


def http(
    cli: incur.Cli, method: str, body: object = None, **headers: str
) -> tuple[int, dict[str, str], Any]:
    """Sends an MCP request over HTTP and returns the status, headers, and parsed body."""

    async def send() -> tuple[int, dict[str, str], Any]:
        sent = {"accept": "application/json, text/event-stream"}
        if body is not None:
            sent["content-type"] = "application/json"
        sent.update({k.replace("_", "-"): v for k, v in headers.items()})
        request = incur.Request(
            "http://localhost/mcp",
            method=method,
            headers=sent,
            body=None if body is None else json.dumps(body),
        )
        response = await cli.fetch(request)
        text = await response.text()
        return response.status, dict(response.headers.items()), json.loads(text) if text else None

    return asyncio.run(send())


def test_http_transport() -> None:
    cli = incur.Cli("tool", update=False, mcp=incur.McpOptions(stateless=False))
    assert http(cli, "POST", [_INIT, {**_INIT, "id": 1}])[2] == snapshot(
        {
            "jsonrpc": "2.0",
            "error": {
                "code": -32600,
                "message": "Invalid Request: Only one initialization request is allowed",
            },
            "id": None,
        }
    )
    assert http(cli, "POST", [1])[2] == snapshot(
        {
            "jsonrpc": "2.0",
            "error": {"code": -32700, "message": "Parse error: Invalid JSON-RPC message"},
            "id": None,
        }
    )
    _, headers, _ = http(cli, "POST", _INIT)
    session = headers["mcp-session-id"]
    assert http(cli, "POST", _INIT)[2] == snapshot(
        {
            "jsonrpc": "2.0",
            "error": {"code": -32600, "message": "Invalid Request: Server already initialized"},
            "id": None,
        }
    )
    ping = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    assert http(cli, "POST", ping, mcp_session_id=session, mcp_protocol_version="1")[::2] == (
        snapshot(
            (
                400,
                {
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32000,
                        "message": "Bad Request: Unsupported protocol version: 1 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)",
                    },
                    "id": None,
                },
            )
        )
    )
    assert http(cli, "GET", mcp_session_id=session, accept="text/event-stream")[::2] == snapshot(
        (
            405,
            {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": "Method not allowed."},
                "id": None,
            },
        )
    )
    assert http(cli, "PUT") == snapshot(
        (
            405,
            {"allow": "GET, POST, DELETE", "content-type": "application/json"},
            {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": "Method not allowed."},
                "id": None,
            },
        )
    )


def test_feature_exceptions() -> None:
    """A failing reader answers with -32603, as the MCP SDK reports handler errors, and the
    connection keeps serving."""
    cli = incur.Cli("kb", update=False)

    @cli.resource("gone", uri="kb://gone")
    def gone() -> str:
        raise FileNotFoundError("gone")

    read = {"jsonrpc": "2.0", "id": 1, "method": "resources/read", "params": {"uri": "kb://gone"}}
    ping = {"jsonrpc": "2.0", "id": 2, "method": "ping"}
    assert mcp(cli, read, ping) == snapshot(
        [
            {"jsonrpc": "2.0", "id": 1, "error": {"code": -32603, "message": "gone"}},
            {"result": {}, "jsonrpc": "2.0", "id": 2},
        ]
    )
