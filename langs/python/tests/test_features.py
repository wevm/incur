"""Fetch gateways, mounted sources, skills, OpenAPI, and MCP sources: paths the differential suite
does not reach because they need Python-side setup, such as failing handlers or file systems.
"""

from __future__ import annotations

import asyncio
import io
import json
from collections.abc import Generator
from pathlib import Path
from typing import Annotated, Any

import fixtures
import pytest
from inline_snapshot import snapshot

import incur
from incur import Context, field


def serve(cli: incur.Cli, *argv: str, env: dict[str, str] | None = None) -> tuple[int, str]:
    """Serves `argv` and returns the exit code and stdout."""
    stdout = io.StringIO()
    code = cli.serve_with(argv, env=env, stdout=stdout)
    return code, stdout.getvalue()


@incur.schema
class Verbose:
    verbose: Annotated[int | None, field("Verbosity", alias="v")] = None


def echo(request: incur.Request) -> incur.Response:
    return incur.Response.json({"url": request.url})


def test_gateway_globals() -> None:
    cli = incur.Cli("tool", update=False, globals=Verbose)
    cli.gateway("api", echo)
    assert serve(cli, "api", "--verbose", "2", "users") == snapshot(
        (0, 'url: "http://localhost/users"\n')
    )
    assert serve(cli, "api", "--verbose", "x") == snapshot(
        (
            1,
            """\
code: VALIDATION_ERROR
message: "Invalid input: expected number, received NaN\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"number\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"received\\": \\"NaN\\",\\n    \\"path\\": [\\n      \\"verbose\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected number, received NaN\\"\\n  }\\n]"
fieldErrors[1]{code,missing,path,expected,received,message}:
  invalid_type,false,verbose,number,NaN,"Invalid input: expected number, received NaN"
""",
        )
    )


def test_gateway_manifest() -> None:
    cli = incur.Cli("tool", update=False)
    cli.gateway("api", echo)
    cli.gateway("upstream", echo, description="Upstream API")
    assert serve(cli, "--llms", "--format", "json") == snapshot(
        (
            0,
            """\
{
  "version": "incur.v1",
  "commands": [
    {
      "name": "api"
    },
    {
      "name": "upstream",
      "description": "Upstream API"
    }
  ]
}
""",
        )
    )


def test_gateway_handler_exceptions() -> None:
    def broken(request: incur.Request) -> incur.Response:
        raise RuntimeError("upstream unavailable")

    def refusing(request: incur.Request) -> incur.Response:
        raise incur.Error("REFUSED", "upstream refused")

    cli = incur.Cli("tool", update=False)
    cli.gateway("api", broken)
    cli.gateway("refusing", refusing)
    assert serve(cli, "refusing") == snapshot(
        (
            1,
            """\
code: REFUSED
message: upstream refused
""",
        )
    )
    assert serve(cli, "api", "users") == snapshot(
        (
            1,
            """\
code: UNKNOWN
message: upstream unavailable
""",
        )
    )


def test_mounts_lazy_sources() -> None:
    sub = incur.Cli("remote", update=False)
    sub.mcp_source("fake", "http://fake.test/mcp", fetch=fixtures.fake_mcp)
    cli = incur.Cli("tool", update=False)
    cli.group(sub)
    assert serve(cli, "remote", "--help")[0] == 0


def test_skills_add(tmp_path: Path) -> None:
    cli = incur.Cli("tool", update=False, sync=incur.Sync(cwd=str(tmp_path)))

    @cli.command("ping")
    def ping(c: Context) -> str:
        return "pong"

    blocked = tmp_path / "home"
    blocked.write_text("")
    code, out = serve(cli, "skills", "add", env={"HOME": str(blocked)})
    assert (code, out.replace(str(tmp_path), "<tmp>")) == snapshot(
        (
            1,
            """\
Syncing...code: SYNC_SKILLS_FAILED
message: "[Errno 20] Not a directory: '<tmp>/home/.agents'"
""",
        )
    )
    home = tmp_path / "user"
    home.mkdir()
    code, out = serve(cli, "skills", "add", "--full-output", env={"HOME": str(home)})
    assert (code, out.replace(str(tmp_path), "<tmp>").split("\n")[-3:]) == snapshot(
        (
            0,
            [
                "Run `tool --help` to see the full command reference.",
                "skills[1]: <tmp>/user/.agents/skills/tool-ping",
                "",
            ],
        )
    )


def mcp_server(tools: list[dict[str, Any]], calls: dict[str, Any]) -> incur.FetchHandler:
    """A fake MCP server listing `tools` and answering `tools/call` from `calls` by tool name.

    A callable entry receives the arguments; any other entry is the result itself.
    """

    def handle(request: incur.Request) -> incur.Response:
        message = json.loads(request.text())
        method = message["method"]
        if "id" not in message:
            return incur.Response(status=202)
        result: Any = {}
        if method == "tools/list":
            result = {"tools": tools}
        elif method == "tools/call":
            params = message["params"]
            answer = calls[params["name"]]
            result = answer(params["arguments"]) if callable(answer) else answer
        return incur.Response.json({"jsonrpc": "2.0", "id": message["id"], "result": result})

    return handle


def text(value: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value)}]}


_DEFAULT_A = {
    "type": "object",
    "properties": {
        "x": {"type": "string", "default": "a"},
        "w": {"type": "string", "default": "d"},
    },
}
_DEFAULT_B = {"type": "object", "properties": {"x": {"type": "string", "default": "b"}}}
PROBE: dict[str, Any] = {
    "name": "probe",
    "inputSchema": {
        "type": "object",
        "properties": {
            "anything": True,
            "one": {"enum": ["a"]},
            "mixed": {"enum": [1, "a"]},
            "three": {"const": 3},
            "single": {"type": ["string"]},
            "maybe": {"type": ["string", "null"]},
            "untyped": {"description": "Anything"},
            "nested": {
                "type": "object",
                "properties": {
                    "either": {"oneOf": [{"type": "number"}, {"type": "integer"}]},
                    "text": {"type": "string", "anyOf": [{"minLength": 2}]},
                    "merged": {
                        "allOf": [
                            {"type": "object", "properties": {"a": {"type": "string"}}},
                            {"type": "object", "properties": {"b": {"type": "number"}}},
                        ]
                    },
                    "none": {"allOf": []},
                },
            },
            "when": {"type": "string", "format": "date-time", "pattern": "^2"},
            "bag": {"type": "object", "properties": {"a": {"type": "string"}}},
            "count": {"type": "number"},
            "nil": {"const": None},
            "yes": {"const": True},
            "void": {"enum": [None]},
            "clash": {"type": "array", "items": {"allOf": [_DEFAULT_A, _DEFAULT_B]}},
            "pair": {
                "type": "array",
                "items": _DEFAULT_A,
                "allOf": [{"type": "array", "items": _DEFAULT_B}],
            },
        },
    },
}


def probe_cli() -> incur.Cli:
    cli = incur.Cli("tool", update=False)
    fake = mcp_server([PROBE], {"probe": text})
    cli.mcp_source("remote", "http://fake.test/mcp", fetch=fake)
    return cli


def post(cli: incur.Cli, path: str, body: Any) -> tuple[int, Any]:
    async def send() -> tuple[int, Any]:
        request = incur.Request(
            f"http://localhost{path}",
            method="POST",
            headers={"content-type": "application/json"},
            body=json.dumps(body),
        )
        response = await cli.fetch(request)
        return response.status, json.loads(await response.text())

    return asyncio.run(send())


def test_mcp_source_schemas() -> None:
    cli = probe_cli()
    assert serve(cli, "remote", "probe", "--schema", "--format", "json") == snapshot(
        (
            0,
            """\
{
  "options": {
    "type": "object",
    "properties": {
      "anything": {},
      "one": {
        "type": "string",
        "const": "a"
      },
      "mixed": {
        "anyOf": [
          {
            "type": "number",
            "const": 1
          },
          {
            "type": "string",
            "const": "a"
          }
        ]
      },
      "three": {
        "type": "number",
        "const": 3
      },
      "single": {
        "type": "string"
      },
      "maybe": {
        "anyOf": [
          {
            "type": "string"
          },
          {
            "type": "null"
          }
        ]
      },
      "untyped": {
        "description": "Anything"
      },
      "nested": {
        "type": "object",
        "properties": {
          "either": {
            "oneOf": [
              {
                "type": "number"
              },
              {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            ]
          },
          "text": {
            "allOf": [
              {
                "type": "string"
              },
              {
                "anyOf": [
                  {}
                ]
              }
            ]
          },
          "merged": {
            "allOf": [
              {
                "type": "object",
                "properties": {
                  "a": {
                    "type": "string"
                  }
                },
                "additionalProperties": {}
              },
              {
                "type": "object",
                "properties": {
                  "b": {
                    "type": "number"
                  }
                },
                "additionalProperties": {}
              }
            ]
          },
          "none": {}
        },
        "additionalProperties": {}
      },
      "when": {
        "type": "string",
        "allOf": [
          {
            "pattern": "^(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))T(?:(?:[01]\\\\d|2[0-3]):[0-5]\\\\d(?::[0-5]\\\\d(?:\\\\.\\\\d+)?)?(?:Z))$"
          },
          {
            "pattern": "^2"
          }
        ]
      },
      "bag": {
        "type": "object",
        "properties": {
          "a": {
            "type": "string"
          }
        },
        "additionalProperties": {}
      },
      "count": {
        "type": "number"
      },
      "nil": {
        "type": "null",
        "const": null
      },
      "yes": {
        "type": "boolean",
        "const": true
      },
      "void": {
        "type": "null",
        "const": null
      },
      "clash": {
        "type": "array",
        "items": {
          "allOf": [
            {
              "type": "object",
              "properties": {
                "x": {
                  "default": "a",
                  "type": "string"
                },
                "w": {
                  "default": "d",
                  "type": "string"
                }
              },
              "additionalProperties": {}
            },
            {
              "type": "object",
              "properties": {
                "x": {
                  "default": "b",
                  "type": "string"
                }
              },
              "additionalProperties": {}
            }
          ]
        }
      },
      "pair": {
        "allOf": [
          {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "x": {
                  "default": "a",
                  "type": "string"
                },
                "w": {
                  "default": "d",
                  "type": "string"
                }
              },
              "additionalProperties": {}
            }
          },
          {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "x": {
                  "default": "b",
                  "type": "string"
                }
              },
              "additionalProperties": {}
            }
          }
        ]
      }
    },
    "additionalProperties": false
  }
}
""",
        )
    )
    bodies: list[dict[str, Any]] = [
        {"maybe": None, "bag": {"a": "x", "b": 1}, "when": "2024-01-01T00:00:00Z", "count": True},
        {"count": None, "maybe": "m"},
        {"count": False},
        {"maybe": 5, "when": "2024"},
        {"nested": {"either": 1.5, "text": "abc", "merged": {"a": "x", "b": 2}, "none": 1}},
        {"nested": {"either": 1}},
        {"nested": {"either": "s", "text": "a", "merged": {"a": 1}}},
        {"one": "b", "mixed": 2, "three": 4, "single": 1, "untyped": [1]},
        {"mixed": 1, "three": 3.0, "clash": [{"x": "z"}], "pair": [{"x": "z"}]},
        {"clash": [{}]},
        {"pair": [{}]},
        {"nil": None, "yes": True, "void": None},
        {"nil": 0, "yes": 1, "void": False},
    ]
    results: list[object] = []
    for body in bodies:
        status, out = post(cli, "/remote/probe", body)
        error = out.get("error")
        results.append(
            (status, out["data"])
            if error is None
            else (
                status,
                error["message"].split("\n")[0],
                [f["path"] for f in error["fieldErrors"]],
            )
        )
    assert results == snapshot(
        [
            (
                200,
                {
                    "maybe": None,
                    "when": "2024-01-01T00:00:00Z",
                    "bag": {"a": "x", "b": 1},
                    "count": 1,
                },
            ),
            (200, {"maybe": "m", "count": 0}),
            (200, {"count": 0}),
            (400, "Invalid input; Invalid ISO datetime", ["maybe", "when"]),
            (
                200,
                {"nested": {"either": 1.5, "text": "abc", "merged": {"a": "x", "b": 2}, "none": 1}},
            ),
            (400, "Invalid input", ["nested.either"]),
            (
                400,
                "Invalid input; Invalid input: expected string, received number",
                ["nested.either", "nested.merged.a"],
            ),
            (
                400,
                'Invalid input: expected "a"; Invalid input; Invalid input: expected 3; Invalid input: expected string, received number',
                ["one", "mixed", "three", "single"],
            ),
            (
                200,
                {
                    "mixed": 1,
                    "three": 3,
                    "clash": [{"x": "z", "w": "d"}],
                    "pair": [{"x": "z", "w": "d"}],
                },
            ),
            (400, "Validation failed", []),
            (400, "Validation failed", []),
            (200, {"nil": None, "yes": True, "void": None}),
            (
                400,
                "Invalid input: expected null; Invalid input: expected true; Invalid input: expected null",
                ["nil", "yes", "void"],
            ),
        ]
    )


CATALOG = [
    {"name": name}
    for name in ("search_tools", "get_tool_details", "call_read_tool", "call_write_tool")
]


def catalog_cli(results: list[Any], details: Any) -> incur.Cli:
    """A CLI with a progressive MCP source whose `search_tools` returns `results` in turn."""
    cli = incur.Cli("tool", update=False)
    pages = iter(results)

    def search(_: object) -> Any:
        return next(pages)

    fake = mcp_server(CATALOG, {"search_tools": search, "get_tool_details": details})
    cli.mcp_source("remote", "http://fake.test/mcp", fetch=fake)
    return cli


def test_progressive_discovery() -> None:
    pages = [
        text({"tools": [{}, {"name": "x"}], "nextOffset": 1}),
        text({"tools": [], "nextOffset": 1}),
    ]
    cli = catalog_cli(pages, text({"description": "no name"}))
    with pytest.raises(RuntimeError, match="non-advancing offset"):
        serve(cli, "remote", "--help")
    # A failed discovery is not retried.
    with pytest.raises(RuntimeError, match="non-advancing offset"):
        serve(cli, "remote", "--help")
    failing: dict[str, Any] = {"content": [], "isError": True}
    cli = catalog_cli([text({"tools": [{"name": "x"}]})], failing)
    with pytest.raises(RuntimeError, match="MCP tool failed: get_tool_details"):
        serve(cli, "remote", "--help")


SPEC: dict[str, Any] = {
    "openapi": "3.1.0",
    "info": {"title": "api", "version": "1"},
    "x-root": {"$ref": "#"},
    "x-plain": {"$ref": "#/components/plain"},
    "x-alias": {"$ref": "#/components/alias"},
    "components": {
        "plain": "text",
        "alias": {"$ref": "#/components/plain"},
        "schemas": {
            "Thing": {
                "type": "object",
                "example": 1,
                "allOf": [{"type": "object", "examples": [1]}, {"example": 2}],
                "anyOf": [{"example": 1}],
                "additionalProperties": {"type": "string", "format": "date"},
                "properties": {"when": {"type": "string", "format": "date-time"}, "flag": True},
                "$defs": {"long": {"type": "string", "pattern": "a" * 101}},
            }
        },
    },
    "paths": {
        "/v2/items": {
            "get": {
                "parameters": [
                    {"name": "q", "in": "query", "schema": {"$ref": "#/components/schemas/Thing"}},
                    {"name": "h", "in": "header"},
                ]
            }
        },
        "/v1/items": {"get": {}},
        "/files/{name}/meta": {
            "get": {
                "summary": "File metadata",
                "parameters": [{"name": "name", "in": "path", "schema": {}}],
            }
        },
        "/files/{name}": {
            "post": {
                "parameters": [
                    {"name": "name", "in": "path", "description": "File name"},
                    {"name": "t", "in": "query", "schema": {"$ref": "#/components/schemas/Thing"}},
                ],
                "requestBody": {
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/Thing"}}
                    }
                },
            }
        },
    },
}


def test_openapi_compact() -> None:
    config = incur.OpenapiConfig(compact=True, versions="latest", mode="namespace")
    cli = incur.Cli("tool", update=False)
    cli.gateway("api", echo, openapi=SPEC, openapi_config=config)
    assert serve(cli, "api", "--llms", "--format", "json") == snapshot(
        (
            0,
            """\
{
  "version": "incur.v1",
  "commands": [
    {
      "name": "api files name meta",
      "description": "File metadata"
    },
    {
      "name": "api files name post"
    },
    {
      "name": "api items"
    }
  ]
}
""",
        )
    )
    assert serve(cli, "api", "items", "--schema", "--format", "json") == snapshot(
        (
            0,
            """\
{
  "options": {
    "type": "object",
    "properties": {
      "q": {
        "allOf": [
          {
            "type": "object",
            "properties": {
              "when": {
                "type": "string"
              },
              "flag": {}
            },
            "additionalProperties": {
              "type": "string"
            }
          },
          {
            "type": "object",
            "properties": {},
            "additionalProperties": {}
          }
        ]
      },
      "h": {
        "description": "h header",
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
""",
        )
    )
    assert serve(cli, "api", "files", "name", "meta") == snapshot(
        (
            0,
            'url: "http://localhost/files/%7Bname%7D/meta"\n',
        )
    )
    assert serve(cli, "api", "files", "name", "post") == snapshot(
        (
            1,
            """\
code: VALIDATION_ERROR
message: "Invalid input: expected string, received undefined\\n\\nDetails: [\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"name\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  }\\n]"
fieldErrors[1]{code,missing,path,expected,received,message}:
  invalid_type,true,name,string,"","Invalid input: expected string, received undefined"
""",
        )
    )


@pytest.fixture
def outgoing() -> Generator[dict[str, incur.Response], None, None]:
    """Routes outgoing requests to canned responses by URL."""
    responses: dict[str, incur.Response] = {}
    incur.set_fetch(lambda request: responses[request.url])
    yield responses
    incur.set_fetch(fixtures.network)


def test_openapi_documents(outgoing: dict[str, incur.Response]) -> None:
    outgoing["http://api.test/v1/spec.json"] = incur.Response.json(SPEC)
    outgoing["http://api.test/missing.json"] = incur.Response(status=404)
    cli = incur.Cli("tool", update=False)
    cli.gateway("api", incur.from_request("http://api.test/v1/"), openapi="spec.json")
    assert serve(cli, "api", "--help")[0] == 0
    for fetch, source, message in (
        (echo, "spec.json", "requires a fetch URL base"),
        (echo, "http://api.test/missing.json", "Failed to fetch OpenAPI spec"),
        (echo, {"paths": {"/": {"get": {"x": {"$ref": "#/nope"}}}}}, "Cannot resolve"),
    ):
        cli = incur.Cli("tool", update=False)
        cli.gateway("api", fetch, openapi=source)
        with pytest.raises(ValueError, match=message):
            serve(cli, "api")


def test_gateway_streams() -> None:
    def lines(request: incur.Request) -> incur.Response:
        return incur.Response(b'{"a":1}\ntext\n', headers={"content-type": "application/x-ndjson"})

    cli = incur.Cli("tool", update=False)
    cli.gateway("api", lines)
    code, out = serve(cli, "api", "--format", "jsonl")
    assert (code, out.splitlines()[:2]) == snapshot(
        (0, ['{"type":"chunk","data":{"a":1}}', '{"type":"chunk","data":"text"}'])
    )


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class StreamEnv:
    incur_test_stream_token: str


def test_http_stream_env_errors() -> None:
    cli = incur.Cli("tool", update=False, env=StreamEnv)

    @cli.command("ticks")
    def ticks(c: Context) -> Generator[int, None, None]:
        yield 1

    status, body = post(cli, "/ticks", {})
    assert (status, body["error"]) == snapshot(
        (
            400,
            {
                "code": "VALIDATION_ERROR",
                "message": """\
Invalid input: expected string, received undefined

Details: [
  {
    "expected": "string",
    "code": "invalid_type",
    "path": [
      "INCUR_TEST_STREAM_TOKEN"
    ],
    "message": "Invalid input: expected string, received undefined"
  }
]\
""",
                "fieldErrors": [
                    {
                        "code": "invalid_type",
                        "missing": True,
                        "path": "INCUR_TEST_STREAM_TOKEN",
                        "expected": "string",
                        "received": "",
                        "message": "Invalid input: expected string, received undefined",
                    }
                ],
            },
        )
    )
