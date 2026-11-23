"""OpenAPI documents: commands generated from operations, and the CLI described as one."""

from __future__ import annotations

import re
import urllib.parse
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from . import _gateway, _js
from ._command import Command, Context, ToolMeta
from ._errors import Error
from ._http import FetchHandler, Headers, Request, call, fetch, join_url, parse_json
from ._js import Json
from ._jsonschema import coerce, convert, describe, optional
from ._schema import Field, Type, json_schema, object_type
from ._tree import Alias, Entry, Gateway, Group, Spec

#: An OpenAPI document as parsed JSON, or its URL. A relative URL resolves against the URL of a
#: hosted fetch source.
OpenapiSource = Mapping[str, Any] | str

_METHODS = ("delete", "get", "head", "options", "patch", "post", "put", "trace")
_VERSION = re.compile(r"^/v(\d+)(?=/|$)")
_COMPACT_PATTERN_LIMIT = 100
_DATE_TIME_FORMATS = frozenset({"date", "date-time", "duration", "time"})


@dataclass
class OpenapiOperation:
    """An operation that `OpenapiConfig.include` decides on."""

    method: str
    """The lowercase HTTP method, such as `get`."""
    path: str
    """The path template, such as `/users/{id}`."""
    operation: dict[str, Json]
    """The operation object."""


@dataclass
class OpenapiConfig:
    """How commands are generated from an OpenAPI document.

    >>> OpenapiConfig(mode="namespace", groups={"users": "Manage users"}).versions
    'all'
    """

    compact: bool = False
    """Strips `example(s)`, oversized `pattern` regexes, and date and time formats from schemas,
    shrinking MCP tool listings."""
    forward_headers: list[str] = field(default_factory=list[str])
    """Headers copied from the inbound HTTP request onto upstream requests when not set."""
    groups: dict[str, str] = field(default_factory=dict[str, str])
    """Descriptions of generated groups, keyed by space-separated command path."""
    include: Callable[[OpenapiOperation], bool] | None = None
    """Generates commands only for operations this returns `True` for."""
    mode: Literal["namespace", "operation"] = "operation"
    """`operation` names commands by operation ID; `namespace` nests them by path segment."""
    security: bool = True
    """Whether the document's security requirements generate credential options."""
    versions: Literal["all", "latest"] = "all"
    """`latest` keeps only the highest version of path-versioned operations (`/v2/users`)."""


# --- The CLI as an OpenAPI document ---------------------------------------------------------


def from_cli(spec: Spec) -> dict[str, Json]:
    """Describes a CLI's commands as an OpenAPI 3.2 document."""
    paths: dict[str, Json] = {}
    root = spec.root_command()
    if root is not None:
        _add_command(paths, [], root, spec.globals)
    for name, entry in spec.commands.items():
        _add_entry(paths, name.split(), entry, spec.globals)
    info: dict[str, Json] = {"title": spec.name, "version": spec.version or "0.0.0"}
    if spec.description:
        info["description"] = spec.description
    return {"openapi": "3.2.0", "info": info, "paths": paths}


def _add_entry(
    paths: dict[str, Json], segments: list[str], entry: Entry, globals_: Type | None
) -> None:
    if isinstance(entry, (Alias, Gateway)):
        return
    if isinstance(entry, Group):
        if entry.root is not None:
            _add_command(paths, segments, entry.root, globals_)
        for name, child in entry.commands.items():
            _add_entry(paths, [*segments, *name.split()], child, globals_)
        return
    _add_command(paths, segments, entry, globals_)


def _merge(options: Type | None, globals_: Type | None) -> Type | None:
    """Merges options and globals; a same-named global replaces the option in place."""
    if globals_ is None:
        return options
    fields = {f.name: f for f in options.fields} if options else {}
    fields.update((f.name, f) for f in globals_.fields)
    return object_type(list(fields.values()))


def _add_command(
    paths: dict[str, Json], segments: list[str], command: Command, globals_: Type | None
) -> None:
    options = _merge(command.options, globals_)
    args_schema = json_schema(command.args) if command.args else {}
    options_schema = json_schema(options) if options else None
    args = _js.as_object(args_schema.get("properties", {}))
    required_args = set(_js.as_list(args_schema.get("required", [])))
    method = _infer_method(segments)
    names = list(args)
    count = next((i for i, n in enumerate(names) if n not in required_args), len(names))
    variants = [names[:n] for n in range(count, len(names) + 1)]
    for included in variants:
        parts = [*segments, *(f"{{{n}}}" for n in included)]
        route = "/" + "/".join(_encode_segment(p) for p in parts)
        parameters: list[Json] = [
            {"name": n, "in": "path", "required": True, "schema": args.get(n, {"type": "string"})}
            for n in included
        ]
        if options_schema is not None and method in ("get", "delete"):
            required = _js.as_list(options_schema.get("required", []))
            for name, schema in _js.as_object(options_schema["properties"]).items():
                parameter: dict[str, Json] = {"name": name, "in": "query"}
                if name in required:
                    parameter["required"] = True
                parameter["schema"] = schema
                parameters.append(parameter)
        operation: dict[str, Json] = {"operationId": _operation_id(segments, method, included)}
        if command.description:
            operation["summary"] = command.description
        if parameters:
            operation["parameters"] = parameters
        if options_schema is not None and method not in ("get", "delete"):
            operation["requestBody"] = {
                "required": bool(options_schema.get("required")),
                "content": {"application/json": {"schema": options_schema}},
            }
        output = json_schema(command.output) if command.output else None
        operation["responses"] = _responses(output)
        item = paths.get(route)
        item = item if isinstance(item, dict) else {}
        item[method] = operation
        paths[route] = item


def _infer_method(segments: list[str]) -> str:
    text = " ".join(re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s) for s in segments).lower()
    for method, words in (
        ("delete", "delete|remove|rm|destroy|clear"),
        ("patch", "update|edit|modify|set|enable|disable|rename|patch"),
        ("get", "get|list|show|read|search|find|status|describe|info|health|check"),
    ):
        if re.search(rf"\b(?:{words})\b", text, re.ASCII):
            return method
    return "post"


def _operation_id(segments: list[str], method: str, args: list[str]) -> str:
    raw = " ".join([*segments, *([" ".join(args)] if args else [])])
    pascal = re.sub(r"(?:^|[\s_-]+)(\w)", lambda m: m[1].upper(), raw, flags=re.ASCII)
    return f"{method}{pascal}"


def _encode_segment(segment: str) -> str:
    if segment.startswith("{") and segment.endswith("}"):
        return segment
    return urllib.parse.quote(segment, safe="-_.!~*'()")


def _meta_schema() -> dict[str, Json]:
    return {
        "type": "object",
        "required": ["command", "duration"],
        "properties": {"command": {"type": "string"}, "duration": {"type": "string"}},
    }


def _error_response(description: str) -> dict[str, Json]:
    error: dict[str, Json] = {
        "type": "object",
        "required": ["code", "message"],
        "properties": {
            "code": {"type": "string"},
            "message": {"type": "string"},
            "hint": {"type": "string"},
            "retryable": {"type": "boolean"},
        },
    }
    schema: dict[str, Json] = {
        "type": "object",
        "required": ["ok", "error", "meta"],
        "properties": {"ok": {"const": False}, "error": error, "meta": _meta_schema()},
    }
    return {"description": description, "content": {"application/json": {"schema": schema}}}


def _responses(output: dict[str, Json] | None) -> dict[str, Json]:
    schema: dict[str, Json] = {
        "type": "object",
        "required": ["ok", "data", "meta"],
        "properties": {"ok": {"const": True}, "data": output or {}, "meta": _meta_schema()},
    }
    return {
        "200": {
            "description": "Command completed successfully.",
            "content": {"application/json": {"schema": schema}},
        },
        "400": _error_response("Validation error."),
        "500": _error_response("Command failed."),
    }


# --- Commands generated from an OpenAPI document ---------------------------------------------


async def resolve(source: OpenapiSource, base: str | None) -> dict[str, Json]:
    """Returns an OpenAPI document, fetching it when the source is a URL.

    Raises:
        ValueError: When a relative URL has no base, or the document cannot be fetched.
    """
    if not isinstance(source, str):
        return _js.as_object(_js.normalize(dict(source)))
    if urllib.parse.urlsplit(source).scheme:
        url = source
    else:
        if base is None:
            raise ValueError(f"Relative OpenAPI spec URL requires a fetch URL base: {source}")
        parts = urllib.parse.urlsplit(base)
        if not parts.path.endswith("/"):
            base = urllib.parse.urlunsplit(parts._replace(path=f"{parts.path}/"))
        url = join_url(base, source)
    response = await fetch(Request(url))
    if not response.ok:
        raise ValueError(f"Failed to fetch OpenAPI spec from {source}: {response.status}")
    return _js.as_object(parse_json(await response.text()))


def _dereference(root: Json) -> Json:
    """Replaces local `$ref` pointers with what they point to."""
    cache: dict[str, Json] = {}

    def pointer(ref: str) -> Json:
        current = root
        fragment = ref[1:]
        if fragment in ("", "/"):
            return root
        for raw in fragment[1:].split("/"):
            part = raw.replace("~1", "/").replace("~0", "~")
            if not isinstance(current, dict) or part not in current:
                raise ValueError(f'Cannot resolve $ref "{ref}": "{part}" not found')
            current = current[part]
        return current

    def walk(node: Json) -> Json:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return node
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#"):
            if ref in cache:
                return cache[ref]
            target = pointer(ref)
            if not isinstance(target, dict):
                cache[ref] = walk(target)
                return cache[ref]
            placeholder: dict[str, Json] = {}
            cache[ref] = placeholder
            resolved = walk(target)
            if not isinstance(resolved, dict):
                cache[ref] = resolved
                return resolved
            placeholder.update(resolved)
            return placeholder
        return {key: walk(value) for key, value in node.items()}

    return walk(root)


@dataclass
class _Operation:
    method: str
    path: str
    route: str
    operation: dict[str, Json]


def _params(operation: dict[str, Json], location: str) -> list[dict[str, Json]]:
    listed = operation.get("parameters")
    items = listed if isinstance(listed, list) else []
    return [p for p in items if isinstance(p, dict) and p.get("in") == location]


def _str(value: Json | None) -> str | None:
    return value if isinstance(value, str) else None


def commands(
    document: dict[str, Json],
    fetch: FetchHandler,
    config: OpenapiConfig | None,
    base_path: str | None,
) -> dict[str, Entry]:
    """Generates commands, one per operation, that call `fetch`."""
    config = config or OpenapiConfig()
    resolved = _js.as_object(_dereference(document))
    paths = resolved.get("paths")
    operations = [
        _Operation(method, path, path, _js.as_object(op))
        for path, methods in (paths if isinstance(paths, dict) else {}).items()
        if isinstance(methods, dict)
        for method, op in methods.items()
        if method in _METHODS and isinstance(op, dict)
    ]
    if config.include is not None:
        include = config.include
        operations = [
            o for o in operations if include(OpenapiOperation(o.method, o.path, o.operation))
        ]
    if config.versions == "latest":
        operations = _latest(operations)
    counts: dict[str, int] = {}
    parents: set[str] = set()
    for o in operations:
        counts[o.route] = counts.get(o.route, 0) + 1
        names = [n for n, _ in _namespace(o.route, None)]
        parents.update("/" + "/".join(names[:i]) for i in range(1, len(names)))
    if config.compact:
        for o in operations:
            _compact_operation(o.operation)

    out: dict[str, Entry] = {}
    for o in operations:
        segments = _segments(o, config.mode, counts, parents)
        command = _command(o, resolved, fetch, config, base_path)
        _place(out, segments, command)
    for path, description in config.groups.items():
        entries = out
        group: Group | None = None
        for name in path.split():
            entry = entries.get(name)
            group = entry if isinstance(entry, Group) else None
            if group is None:
                break
            entries = group.commands
        if group is not None:
            group.description = description
    return out


def _latest(operations: list[_Operation]) -> list[_Operation]:
    """Keeps the highest version of each operation; unversioned paths count as version 0."""
    latest: dict[str, tuple[_Operation, int]] = {}
    for o in operations:
        match = _VERSION.match(o.path)
        version = int(match[1]) if match else 0
        route = (o.path[match.end() :] or "/") if match else o.path
        key = f"{o.method} {re.sub(r'{[^}]+}', '{}', route)}"
        existing = latest.get(key)
        if existing is None or version > existing[1]:
            latest[key] = (_Operation(o.method, o.path, route, o.operation), version)
    return [o for o, _ in latest.values()]


def _compact(schema: dict[str, Json], seen: dict[int, dict[str, Json]]) -> dict[str, Json]:
    """Strips examples, oversized patterns, and date and time formats from a schema."""
    if id(schema) in seen:
        return seen[id(schema)]
    out = dict(schema)
    seen[id(schema)] = out
    out.pop("example", None)
    out.pop("examples", None)
    pattern = out.get("pattern")
    if isinstance(pattern, str) and _js.utf16_len(pattern) > _COMPACT_PATTERN_LIMIT:
        del out["pattern"]
    if out.get("format") in _DATE_TIME_FORMATS:
        del out["format"]
    for key in ("allOf", "anyOf", "oneOf", "prefixItems"):
        value = out.get(key)
        if isinstance(value, list):
            entries = [_compact(e, seen) for e in value if isinstance(e, dict)]
            entries = [e for e in entries if e]
            if entries:
                out[key] = list[Json](entries)
            else:
                del out[key]
    for key in ("additionalProperties", "contains", "items", "not", "propertyNames"):
        value = out.get(key)
        if isinstance(value, dict):
            out[key] = _compact(value, seen)
    for key in ("$defs", "patternProperties", "properties"):
        value = out.get(key)
        if isinstance(value, dict):
            out[key] = {
                k: _compact(v, seen) if isinstance(v, dict) else v for k, v in value.items()
            }
    return out


def _compact_operation(operation: dict[str, Json]) -> None:
    seen: dict[int, dict[str, Json]] = {}
    for parameter in (
        _params(operation, "path") + _params(operation, "query") + _params(operation, "header")
    ):
        schema = parameter.get("schema")
        if isinstance(schema, dict):
            parameter["schema"] = _compact(schema, seen)
    body = _body(operation)
    if body is not None:
        body["schema"] = _compact(_js.as_object(body["schema"]), seen)


def _body(operation: dict[str, Json]) -> dict[str, Json] | None:
    """The `application/json` request body media object, when it has a schema."""
    request = operation.get("requestBody")
    content = request.get("content") if isinstance(request, dict) else None
    media = content.get("application/json") if isinstance(content, dict) else None
    if isinstance(media, dict) and isinstance(media.get("schema"), dict):
        return media
    return None


def _namespace(route: str, operation: dict[str, Json] | None) -> list[tuple[str, str | None]]:
    """The command names of a path's segments, with path parameter descriptions."""
    out: list[tuple[str, str | None]] = []
    for segment in route.split("/"):
        if not segment:
            continue
        name = segment[1:-1] if segment.startswith("{") and segment.endswith("}") else segment
        description = None
        if operation is not None:
            found = next((p for p in _params(operation, "path") if p.get("name") == name), None)
            description = _str(found.get("description")) if found else None
        out.append((re.sub(r"[^\w.-]+", "-", name, flags=re.ASCII), description or None))
    return out


def _segments(
    o: _Operation, mode: str, counts: dict[str, int], parents: set[str]
) -> list[tuple[str, str | None]]:
    """Names the command of an operation, with group descriptions along its path."""
    op = o.operation
    if mode == "operation":
        name = _str(op.get("operationId")) or f"{o.method}_{re.sub(r'[/{}]', '_', o.path)}"
        return [(name, None)]
    segments = _namespace(o.route, op)
    path = "/" + "/".join(n for n, _ in segments)
    needs_method = not segments or path in parents or counts.get(o.route, 0) > 1
    description = _str(op.get("summary")) or _str(op.get("description"))
    if description and segments and segments[-1][1] is None:
        segments[-1] = (segments[-1][0], description)
    return [*(segments or [("root", None)]), *([(o.method, None)] if needs_method else [])]


def _place(
    commands: dict[str, Entry], segments: list[tuple[str, str | None]], command: Command
) -> None:
    (name, description), *rest = segments
    if not rest:
        commands[name] = command
        return
    existing = commands.get(name)
    if isinstance(existing, Group):
        if not existing.description and description:
            existing.description = description
        group = existing
    else:
        group = Group({}, description)
        commands[name] = group
    _place(group.commands, rest, command)


def _security_headers(
    document: dict[str, Json], operation: dict[str, Json]
) -> list[dict[str, Json]]:
    """Header parameters for the credentials an operation's security requirements name."""
    components = document.get("components")
    schemes = components.get("securitySchemes") if isinstance(components, dict) else None
    schemes = schemes if isinstance(schemes, dict) else {}
    requirements = operation.get("security", document.get("security"))
    headers: list[dict[str, Json]] = []
    for requirement in requirements if isinstance(requirements, list) else []:
        for name in requirement if isinstance(requirement, dict) else {}:
            scheme = schemes.get(name)
            if not isinstance(scheme, dict):
                continue
            kind, where, header = scheme.get("type"), scheme.get("in"), _str(scheme.get("name"))
            description = _str(scheme.get("description"))
            http = _str(scheme.get("scheme")) or ""
            if kind == "apiKey" and where == "header" and header:
                headers.append(_header(header, description or f"{header} header"))
            elif kind == "http" and http.lower() in ("basic", "bearer"):
                headers.append(
                    _header("authorization", description or f"{name} authorization header")
                )
    return headers


def _header(name: str, description: str) -> dict[str, Json]:
    return {
        "description": description,
        "in": "header",
        "name": name,
        "required": False,
        "schema": {"type": "string"},
    }


def _param_type(parameter: dict[str, Json], required: bool) -> Type:
    schema = parameter.get("schema")
    ty = convert(schema) if isinstance(schema, dict) else Type("string", raw={"type": "string"})
    if not required:
        ty = optional(ty)
    description = _str(parameter.get("description"))
    return describe(ty, description) if description else ty


def _command(
    o: _Operation,
    document: dict[str, Json],
    fetch: FetchHandler,
    config: OpenapiConfig,
    base_path: str | None,
) -> Command:
    op = o.operation
    path_params = _params(op, "path")
    query_params = _params(op, "query")
    declared = _params(op, "header") + (_security_headers(document, op) if config.security else [])
    headers: list[tuple[str, dict[str, Json]]] = []
    seen: set[str] = set()
    for parameter in declared:
        normalized = str(parameter.get("name")).lower()
        if normalized not in seen:
            seen.add(normalized)
            headers.append((normalized, parameter))
    body = _body(op)
    body_schema = _js.as_object(body["schema"]) if body else {}
    body_props = body_schema.get("properties")
    body_props = body_props if isinstance(body_props, dict) else {}
    body_required = body_schema.get("required")
    body_required = body_required if isinstance(body_required, list) else []

    used = {str(p.get("name")) for p in query_params} | set(body_props)
    header_options: list[tuple[str, dict[str, Json]]] = []
    for normalized, parameter in headers:
        option = normalized
        if option in used:
            prefix = f"header-{option}"
            option = prefix
            index = 2
            while option in used:
                option = f"{prefix}-{index}"
                index += 1
        used.add(option)
        header_options.append((option, parameter))

    args = (
        object_type([Field(str(p.get("name")), coerce(_param_type(p, True))) for p in path_params])
        if path_params
        else None
    )
    fields: dict[str, Field] = {}
    for p in query_params:
        name = str(p.get("name"))
        fields[name] = Field(name, coerce(_param_type(p, p.get("required") is True)))
    for key, schema in body_props.items():
        ty = convert(schema)
        fields[key] = Field(key, ty if key in body_required else optional(ty))
    for option, p in header_options:
        ty = _param_type({**p, "description": None}, p.get("required") is True)
        description = _str(p.get("description")) or f"{p.get('name')} header"
        fields[option] = Field(option, coerce(describe(ty, description)))
    options = object_type(list(fields.values())) if fields else None

    summary, description = _str(op.get("summary")), _str(op.get("description"))
    read_only = o.method in ("get", "head", "options", "trace")
    annotations: dict[str, Json] = {
        "destructiveHint": not read_only,
        "idempotentHint": read_only or o.method in ("delete", "put"),
        "openWorldHint": True,
        "readOnlyHint": read_only,
    }
    # Help keeps the short summary; MCP tools surface the full prose.
    prose = (
        f"{summary}\n\n{description}"
        if summary and description and summary != description
        else None
    )
    method = o.method.upper()

    async def handler(c: Context[Any, Any]) -> Json:
        args_in: dict[str, Json] = c.args or {}
        options_in: dict[str, Json] = c.options or {}
        url_path = (base_path or "") + o.path
        for p in path_params:
            name = str(p.get("name"))
            if name in args_in:
                url_path = url_path.replace(f"{{{name}}}", _js.to_string(args_in[name]), 1)
        query: list[tuple[str, str]] = []
        for p in query_params:
            name = str(p.get("name"))
            if options_in.get(name) is not None:
                query.append((name, _js.to_string(options_in[name])))
        payload = {k: options_in[k] for k in body_props if options_in.get(k) is not None}
        request_headers = Headers()
        for option, p in header_options:
            if options_in.get(option) is not None:
                request_headers.set(str(p.get("name")), _js.to_string(options_in[option]))
        incoming = c.request
        for name in config.forward_headers:
            value = incoming.headers.get(name) if incoming is not None else None
            if name not in request_headers and value is not None:
                request_headers.set(name, value)
        data = _gateway.Input(
            url_path,
            method,
            request_headers,
            _js.stringify(payload) if payload else None,
            query,
        )
        response = await call(fetch, _gateway.build_request(data))
        result = await _gateway.read(response)
        if not response.ok:
            raise Error(*_gateway.error_of(result, response.status))
        return result

    return Command(
        handler=handler,
        args=args,
        options=options,
        description=summary or description,
        mcp=ToolMeta(description=prose, annotations=annotations),
    )
