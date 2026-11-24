"""MCP resources, resource templates, prompts, and completion, served next to tools."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from . import _js
from ._errors import unknown
from ._js import Json
from ._model import build, type_of
from ._schema import Type, validate

#: Suggests values for a prompt argument or template variable from its partial value and the
#: values already chosen. Clients receive the first 100.
Completer = Callable[[str, dict[str, str]], list[str]]

#: What a resource read returns: text, one set of contents, or several. Contents are dicts as
#: MCP spells them, with `text` or base64 `blob`; `uri` defaults to the URI read and `mimeType`
#: to the resource's.
ReadResult = str | dict[str, Json] | list[dict[str, Json]]


@dataclass
class Resource:
    """A resource at a fixed URI."""

    uri: str
    """The URI clients read, matched exactly."""
    name: str
    """Programmatic name."""
    read: Callable[[], ReadResult]
    """Reads the contents."""
    title: str | None = None
    """Human-readable title."""
    description: str | None = None
    """Description."""
    mime_type: str | None = None
    """MIME type of the contents."""
    icons: list[Any] | None = None
    """Icons clients may show, as `incur.Icon` values."""


@dataclass
class ResourceTemplate:
    """Resources whose URIs match a template such as `docs://{section}/{page}`.

    Templates support `{name}` expressions, which match one or more characters other than `/`
    and `,`.
    """

    uri_template: str
    """The URI template."""
    name: str
    """Programmatic name."""
    read: Callable[[str, dict[str, str]], ReadResult]
    """Reads the contents of a matching URI, given the URI and its variables."""
    title: str | None = None
    """Human-readable title."""
    description: str | None = None
    """Description."""
    mime_type: str | None = None
    """MIME type of the contents."""
    icons: list[Any] | None = None
    """Icons clients may show, as `incur.Icon` values."""
    complete: dict[str, Completer] = field(default_factory=dict[str, Completer])
    """Completers keyed by template variable."""


@dataclass
class Prompt:
    """A prompt template clients can list and render."""

    name: str
    """Programmatic name."""
    get: Callable[[Any], str | list[Json]]
    """Renders the prompt from its parsed arguments: text becomes one user message, and a list
    holds messages as MCP spells them."""
    title: str | None = None
    """Human-readable title."""
    description: str | None = None
    """Description."""
    icons: list[Any] | None = None
    """Icons clients may show, as `incur.Icon` values."""
    args: type | None = None
    """An `incur.schema` class for the arguments, which clients send as strings. Without one,
    `get` receives the raw arguments dict."""
    complete: dict[str, Completer] = field(default_factory=dict[str, Completer])
    """Completers keyed by argument name."""


class RpcError(Exception):
    """A JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: Json = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


_TEMPLATE = re.compile(r"(?:[^{}]|\{[A-Za-z0-9_]+\})*")
_EXPRESSION = re.compile(r"\{([A-Za-z0-9_]+)\}")

#: The methods features answer.
METHODS = (
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "prompts/list",
    "prompts/get",
    "completion/complete",
)


def _pattern(template: str) -> tuple[list[str], re.Pattern[str]]:
    """Compiles a level 1 URI template.

    Raises:
        Error: When the template has other expressions or stray braces.
    """
    if not _TEMPLATE.fullmatch(template):
        raise unknown(f"Unsupported URI template: {template}")
    names = _EXPRESSION.findall(template)
    parts = _EXPRESSION.split(template)[::2]
    return names, re.compile("([^/,]+)".join(re.escape(part) for part in parts))


def _icons(icons: list[Any] | None) -> list[Json] | None:
    return [icon.to_json() for icon in icons] if icons is not None else None


def _describe(out: dict[str, Json], title: str | None, description: str | None) -> None:
    if title:
        out["title"] = title
    if description:
        out["description"] = description


class Features:
    """The resources, templates, and prompts of one server."""

    def __init__(
        self,
        resources: list[Resource],
        templates: list[ResourceTemplate],
        prompts: list[Prompt],
    ) -> None:
        self.resources = resources
        self.templates = [(template, *_pattern(template.uri_template)) for template in templates]
        self.prompts = prompts
        self.args: dict[str, Type] = {
            p.name: type_of(p.args, p.name) for p in prompts if p.args is not None
        }

    def capabilities(self) -> dict[str, Json]:
        """The capabilities features add, after `tools`."""
        out: dict[str, Json] = {}
        if self.resources or self.templates:
            out["resources"] = {"listChanged": True}
        if self.prompts:
            out["prompts"] = {"listChanged": True}
        if self.prompts or self.templates:
            out["completions"] = {}
        return out

    def handles(self, method: str) -> bool:
        """Whether a configured feature answers a method."""
        if method.startswith("resources/"):
            return bool(self.resources or self.templates)
        if method.startswith("prompts/"):
            return bool(self.prompts)
        return method == "completion/complete" and bool(self.prompts or self.templates)

    def answer(self, method: str, params: dict[str, Json]) -> dict[str, Json]:
        """Answers a feature request.

        Raises:
            RpcError: For unknown resources, prompts, and invalid prompt arguments.
        """
        if method == "resources/list":
            return {"resources": [self._resource(r) for r in self.resources]}
        if method == "resources/templates/list":
            return {"resourceTemplates": [self._template(t) for t, _, _ in self.templates]}
        if method == "resources/read":
            return self._read(str(params.get("uri")))
        if method == "prompts/list":
            return {"prompts": [self._prompt(p) for p in self.prompts]}
        if method == "prompts/get":
            return self._get(params)
        return self._complete(params)

    def _resource(self, resource: Resource) -> Json:
        out: dict[str, Json] = {"uri": resource.uri, "name": resource.name}
        _describe(out, resource.title, resource.description)
        icons = _icons(resource.icons)
        if icons is not None:
            out["icons"] = icons
        return out

    def _template(self, template: ResourceTemplate) -> Json:
        out: dict[str, Json] = {"uriTemplate": template.uri_template, "name": template.name}
        _describe(out, template.title, template.description)
        icons = _icons(template.icons)
        if icons is not None:
            out["icons"] = icons
        return out

    def _prompt(self, prompt: Prompt) -> Json:
        out: dict[str, Json] = {"name": prompt.name}
        _describe(out, prompt.title, prompt.description)
        ty = self.args.get(prompt.name)
        if ty is not None:
            listed: list[Json] = []
            for f in ty.fields:
                item: dict[str, Json] = {"name": f.name}
                if f.ty.description:
                    item["description"] = f.ty.description
                item["required"] = not f.ty.optional and f.ty.default is None
                listed.append(item)
            out["arguments"] = listed
        icons = _icons(prompt.icons)
        if icons is not None:
            out["icons"] = icons
        return out

    def _read(self, uri: str) -> dict[str, Json]:
        for resource in self.resources:
            if resource.uri == uri:
                return {"contents": _contents(resource.read(), uri, resource.mime_type)}
        for template, names, pattern in self.templates:
            match = pattern.fullmatch(uri)
            if match is not None:
                variables = dict(zip(names, match.groups(), strict=True))
                contents = _contents(template.read(uri, variables), uri, template.mime_type)
                return {"contents": contents}
        raise RpcError(-32602, f"Resource not found: {uri}", {"uri": uri})

    def _get(self, params: dict[str, Json]) -> dict[str, Json]:
        name = str(params.get("name"))
        prompt = next((p for p in self.prompts if p.name == name), None)
        if prompt is None:
            raise RpcError(-32602, f"Prompt {name} not found")
        raw = params.get("arguments")
        arguments: dict[str, Json] = raw if isinstance(raw, dict) else {}
        args: Any = arguments
        ty = self.args.get(name)
        if ty is not None:
            parsed, issues = validate(ty, arguments)
            if issues:
                listed = ", ".join(
                    f"{'.'.join(_js.to_string(p) for p in i.path)}: {i.message}"
                    if i.path
                    else i.message
                    for i in issues
                )
                raise RpcError(-32602, f"Invalid arguments for prompt {name}: {listed}")
            args = build(ty, parsed)
        rendered = prompt.get(args)
        out: dict[str, Json] = {}
        if prompt.description:
            out["description"] = prompt.description
        out["messages"] = (
            [{"role": "user", "content": {"type": "text", "text": rendered}}]
            if isinstance(rendered, str)
            else rendered
        )
        return out

    def _complete(self, params: dict[str, Json]) -> dict[str, Json]:
        ref = _js.as_object(params.get("ref"))
        argument = _js.as_object(params.get("argument"))
        context = params.get("context")
        chosen = context.get("arguments") if isinstance(context, dict) else None
        name = str(argument.get("name"))
        completer: Completer | None
        if ref.get("type") == "ref/prompt":
            prompt = next((p for p in self.prompts if p.name == ref.get("name")), None)
            if prompt is None:
                raise RpcError(-32602, f"Prompt {ref.get('name')} not found")
            completer = prompt.complete.get(name)
        else:
            uri = ref.get("uri")
            template = next((t for t, _, _ in self.templates if t.uri_template == uri), None)
            if template is None and not any(r.uri == uri for r in self.resources):
                raise RpcError(-32602, f"Resource template {uri} not found")
            completer = template.complete.get(name) if template is not None else None
        if completer is None:
            return {"completion": {"values": [], "hasMore": False}}
        given = {k: str(v) for k, v in chosen.items()} if isinstance(chosen, dict) else {}
        values = completer(str(argument.get("value")), given)
        listed: list[Json] = [*values[:100]]
        return {
            "completion": {"values": listed, "total": len(values), "hasMore": len(values) > 100}
        }


def _contents(result: ReadResult, uri: str, mime_type: str | None) -> list[Json]:
    """Normalizes what a read returned into `resources/read` contents."""
    items = [{"text": result}] if isinstance(result, str) else result
    out: list[Json] = []
    for item in items if isinstance(items, list) else [items]:
        entry: dict[str, Json] = {"uri": item.get("uri", uri)}
        kind = item.get("mimeType", mime_type)
        if kind:
            entry["mimeType"] = kind
        entry.update((k, v) for k, v in item.items() if k not in ("uri", "mimeType"))
        out.append(entry)
    return out
