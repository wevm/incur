"""The CLI as an HTTP handler: commands, MCP over HTTP, and OpenAPI and skills discovery."""

from __future__ import annotations

import asyncio
import os
import time
import urllib.parse
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from . import _js, _parser, _skill, _yaml
from ._command import Command, Middleware, Stream, execute
from ._errors import Error, format_cta, unknown
from ._http import Request, Response, call, origin, search_params
from ._js import Json
from ._mcp import spec_context
from ._model import build, to_json
from ._openapi import from_cli as openapi_from_cli
from ._tree import GatewayHit, GroupHelp, NotFound, Spec, resolve, suggest

_CACHE = {"cache-control": "public, max-age=300"}


def _duration(start: float) -> str:
    return f"{round((time.monotonic() - start) * 1000)}ms"


def _failure(code: str, message: str, command: str, start: float, status: int) -> Response:
    body: dict[str, Json] = {
        "ok": False,
        "error": {"code": code, "message": message},
        "meta": {"command": command, "duration": _duration(start)},
    }
    return Response.json(body, status=status)


async def handle(
    spec: Spec, request: Request, mcp: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Answers an HTTP request for a CLI."""
    start = time.monotonic()
    path = urllib.parse.urlsplit(request.url).path
    segments = [s for s in path.split("/") if s]

    if request.method == "GET" and _is_openapi(segments):
        document = openapi_from_cli(spec)
        if segments[0] in ("openapi.yml", "openapi.yaml"):
            headers = {"content-type": "application/yaml", **_CACHE}
            return Response(_yaml.stringify(document), headers=headers)
        return Response(
            _js.stringify(document), headers={"content-type": "application/json", **_CACHE}
        )

    if segments == ["mcp"]:
        return await mcp(request)

    if (
        len(segments) >= 3
        and segments[0] == ".well-known"
        and segments[1] in ("agent-skills", "skills")
        and request.method == "GET"
    ):
        groups: dict[str, str] = {}
        infos = _skill.collect(spec.commands, [], groups, spec.root_command())
        files = _skill.split(spec.name, infos, 1, groups, spec.sync.command if spec.sync else None)
        if segments[2] == "index.json" and len(segments) == 3:
            listed = [(f.dir or spec.name, f.description, f.content) for f in files]
            if segments[1] == "agent-skills":
                index: dict[str, Json] = _skill.discovery(origin(request.url), listed)
            else:
                skills: list[Json] = [
                    {"name": name, "description": description, "files": ["SKILL.md"]}
                    for name, description, _ in listed
                ]
                index = {"skills": skills}
            return Response(
                _js.stringify(index), headers={"content-type": "application/json", **_CACHE}
            )
        if len(segments) == 4 and segments[3] == "SKILL.md":
            found = next((f for f in files if (f.dir or spec.name) == segments[2]), None)
            if found is not None:
                return Response(found.content, headers={"content-type": "text/markdown", **_CACHE})
        return Response("Not Found", status=404)

    inputs: dict[str, Json] = {}
    if request.method == "GET":
        inputs = dict(search_params(urllib.parse.urlsplit(request.url).query))
    elif "application/json" in (request.headers.get("content-type") or ""):
        text = request.text()
        if _js.json_parse_error(text) is None:
            inputs = _js.as_object(_js.parse_json(text))

    if not segments:
        root = spec.root_command()
        if root is None:
            return _failure("COMMAND_NOT_FOUND", "No root command defined.", "/", start, 404)
        return await _run(spec, spec.name, root, [], [], inputs, request, start)

    resolved = resolve(spec.commands, segments)
    if isinstance(resolved, NotFound):
        parent = f"{spec.name} {resolved.path}" if resolved.path else spec.name
        suggestion = suggest(resolved.error, resolved.commands)
        did_you_mean = f" Did you mean '{suggestion}'?" if suggestion else ""
        message = f"'{resolved.error}' is not a command for '{parent}'.{did_you_mean}"
        return _failure("COMMAND_NOT_FOUND", message, resolved.error, start, 404)
    if isinstance(resolved, GroupHelp):
        message = f"'{resolved.path}' is a command group. Specify a subcommand."
        return _failure("COMMAND_NOT_FOUND", message, resolved.path, start, 404)
    if isinstance(resolved, GatewayHit):
        return await call(resolved.gateway.fetch, request)
    return await _run(
        spec,
        resolved.path,
        resolved.command,
        resolved.rest,
        resolved.middleware,
        inputs,
        request,
        start,
    )


def _is_openapi(segments: list[str]) -> bool:
    if len(segments) == 1:
        return segments[0] in ("openapi.json", "openapi.yml", "openapi.yaml")
    return segments == [".well-known", "openapi.json"]


async def _run(
    spec: Spec,
    path: str,
    command: Command,
    rest: list[str],
    middleware: list[Middleware],
    inputs: dict[str, Json],
    request: Request,
    start: float,
) -> Response:
    """Runs a command for an HTTP request and renders its JSON or NDJSON response."""
    globals_: dict[str, Json] = {}
    options = inputs
    if spec.globals is not None:
        keys = {f.name for f in spec.globals.fields}
        raw = {k: v for k, v in inputs.items() if k in keys}
        options = {k: v for k, v in inputs.items() if k not in keys}
        try:
            globals_ = _parser.check(spec.globals, raw)
        except Error as error:
            messages = [f.message for f in error.field_errors or []]
            message = "; ".join(messages) or "Validation failed"
            return _failure("VALIDATION_ERROR", message, path, start, 400)

    name = spec.name
    context = spec_context(spec, path, globals_, request)
    environ = os.environ

    def parse() -> tuple[dict[str, Json], dict[str, Json], dict[str, Json]]:
        args = _parser.parse(rest, command.args, None, None)[0]
        return (
            args,
            _parser.check(command.options, options) if command.options else {},
            _parser.parse_env(command.env, environ.get) if command.env else {},
        )

    def meta(cta: Any = None) -> dict[str, Json]:
        out: dict[str, Json] = {"command": path, "duration": _duration(start)}
        if cta is not None:
            out["cta"] = cta.to_json()
        return out

    def error_record(error: Error) -> bytes:
        record: dict[str, Json] = {
            "type": "error",
            "ok": False,
            "error": error.to_json(),
            "meta": meta(format_cta(name, error.cta)),
        }
        return (_js.stringify(record) + "\n").encode()

    loop = asyncio.get_running_loop()
    handoff: asyncio.Future[Stream] = loop.create_future()
    finished = asyncio.Event()

    async def sink(chunks: Stream) -> None:
        handoff.set_result(chunks)
        await finished.wait()

    async def run() -> Any:
        try:
            if spec.env is not None:
                context.env = build(spec.env, _parser.parse_env(spec.env, environ.get))
        except Error as error:
            return error
        chain = [*spec.middleware, *middleware, *command.middleware]
        return await execute(command, context, chain, parse, sink)

    task = asyncio.ensure_future(run())
    await asyncio.wait({task, handoff}, return_when=asyncio.FIRST_COMPLETED)
    if handoff.done():
        chunks = handoff.result()

        async def records() -> AsyncIterator[bytes]:
            try:
                async for chunk in chunks:
                    record = {"type": "chunk", "data": to_json(chunk)}
                    yield (_js.stringify(record) + "\n").encode()
            except Error as error:
                yield error_record(error)
                return
            except Exception as error:
                yield error_record(unknown(str(error)))
                return
            finally:
                finished.set()
                await task
            final = chunks.final
            done: dict[str, Json] = {
                "type": "done",
                "ok": True,
                "meta": meta(format_cta(name, getattr(final, "cta", None))),
            }
            yield (_js.stringify(done) + "\n").encode()

        return Response(records(), headers={"content-type": "application/x-ndjson"})

    result = task.result()
    if isinstance(result, Error):
        body = {"ok": False, "error": result.to_json(), "meta": meta(format_cta(name, result.cta))}
        status = 400 if (result.code == "VALIDATION_ERROR" or result.parse_error) else 500
        return Response.json(body, status=status)
    body: dict[str, Json] = {"ok": True}
    if result.data is not None:
        body["data"] = result.data
    body["meta"] = meta(format_cta(name, result.cta))
    return Response.json(body)
