"""HTTP messages for fetch handlers, the ASGI application, and outgoing requests.

`Request`, `Response`, and `Headers` follow the Fetch API that the TypeScript package builds on:
header names are case-insensitive and list lowercased in name order, and a text body without a
`content-type` is sent as `text/plain;charset=UTF-8`.
"""

from __future__ import annotations

import asyncio
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterable, Iterator
from collections.abc import Mapping as MappingABC
from typing import Any, cast

from . import _js
from ._js import Json

_TEXT = "text/plain;charset=UTF-8"
_STANDARD_METHODS = frozenset({"DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"})


class Headers:
    """Case-insensitive HTTP headers. Iteration yields lowercased names in name order.

    >>> headers = Headers({"Content-Type": "text/plain"})
    >>> headers.get("content-type"), list(headers)
    ('text/plain', ['content-type'])
    """

    def __init__(
        self, init: Headers | MappingABC[str, str] | Iterable[tuple[str, str]] | None = None
    ) -> None:
        """Creates headers from a mapping, pairs, or other headers."""
        self._values: dict[str, str] = {}
        if init is None:
            return
        mapping = isinstance(init, (Headers, MappingABC))
        pairs = cast("Headers | MappingABC[str, str]", init).items() if mapping else init
        for name, value in pairs:
            self.append(name, value)

    def get(self, name: str) -> str | None:
        """Returns a header value, or `None` when absent."""
        return self._values.get(name.lower())

    def set(self, name: str, value: str) -> None:
        """Sets a header, replacing earlier values."""
        self._values[name.lower()] = value.strip()

    def append(self, name: str, value: str) -> None:
        """Adds a value, joining it to an existing one with `, `."""
        key = name.lower()
        current = self._values.get(key)
        self._values[key] = value.strip() if current is None else f"{current}, {value.strip()}"

    def delete(self, name: str) -> None:
        """Removes a header."""
        self._values.pop(name.lower(), None)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name.lower() in self._values

    def __iter__(self) -> Iterator[str]:
        return iter(sorted(self._values))

    def items(self) -> list[tuple[str, str]]:
        """Returns `(name, value)` pairs in name order."""
        return [(name, self._values[name]) for name in self]

    def __repr__(self) -> str:
        return f"Headers({dict(self.items())!r})"


def _body_bytes(body: bytes | str | None, headers: Headers) -> bytes:
    """Encodes a body, defaulting a text body's content type as the Fetch API does."""
    if isinstance(body, str):
        if "content-type" not in headers:
            headers.set("content-type", _TEXT)
        return body.encode()
    return body or b""


class Request:
    """An HTTP request, as a fetch handler or `Cli.fetch` receives it.

    >>> request = Request("http://localhost/users?limit=2", method="post", body="hi")
    >>> request.method, request.path, request.query, request.headers.get("content-type")
    ('POST', '/users', {'limit': '2'}, 'text/plain;charset=UTF-8')
    """

    def __init__(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Headers | MappingABC[str, str] | Iterable[tuple[str, str]] | None = None,
        body: bytes | str | None = None,
    ) -> None:
        """Creates a request.

        Args:
            url: The absolute URL.
            method: The HTTP method. Standard methods are uppercased.
            headers: Request headers.
            body: The body. Text without a `content-type` is sent as `text/plain;charset=UTF-8`.
        """
        self.url = normalize_url(url)
        """The absolute URL."""
        upper = method.upper()
        self.method = upper if upper in _STANDARD_METHODS else method
        """The HTTP method."""
        self.headers = Headers(headers)
        """The request headers."""
        self.body = _body_bytes(body, self.headers)
        """The body bytes."""

    @property
    def path(self) -> str:
        """The URL path."""
        return urllib.parse.urlsplit(self.url).path or "/"

    @property
    def query(self) -> dict[str, str]:
        """The query parameters. A repeated name keeps its last value."""
        return dict(search_params(urllib.parse.urlsplit(self.url).query))

    def text(self) -> str:
        """Returns the body as text."""
        return self.body.decode("utf-8", "replace")

    def json(self) -> Json:
        """Parses the body as JSON. Raises `ValueError` when it is not JSON."""
        return parse_json(self.text())

    def __repr__(self) -> str:
        return f"Request({self.method} {self.url})"


class Response:
    """An HTTP response, as a fetch handler or `Cli.fetch` returns it.

    The body is bytes, text, or an async iterable of byte chunks for streamed responses.

    >>> import asyncio
    >>> response = Response.json({"ok": True}, status=201)
    >>> response.status, response.headers.get("content-type"), asyncio.run(response.text())
    (201, 'application/json', '{"ok":true}')
    """

    def __init__(
        self,
        body: bytes | str | AsyncIterable[bytes] | None = None,
        *,
        status: int = 200,
        headers: Headers | MappingABC[str, str] | Iterable[tuple[str, str]] | None = None,
    ) -> None:
        """Creates a response.

        Args:
            body: The body: bytes, text, an async iterable of byte chunks, or `None`.
            status: The HTTP status code.
            headers: Response headers.
        """
        self.status = status
        """The HTTP status code."""
        self.headers = Headers(headers)
        """The response headers."""
        self.body: bytes | AsyncIterable[bytes] = (
            body if isinstance(body, AsyncIterable) else _body_bytes(body, self.headers)
        )
        """The body bytes, or an async iterable of chunks."""

    @classmethod
    def json(
        cls,
        data: Json,
        *,
        status: int = 200,
        headers: Headers | MappingABC[str, str] | Iterable[tuple[str, str]] | None = None,
    ) -> Response:
        """Creates a JSON response, serialized as `JSON.stringify` does."""
        response = cls(_js.stringify(data).encode(), status=status, headers=headers)
        if "content-type" not in response.headers:
            response.headers.set("content-type", "application/json")
        return response

    @property
    def ok(self) -> bool:
        """Whether the status is in the 200 range."""
        return 200 <= self.status <= 299

    async def chunks(self) -> AsyncIterator[bytes]:
        """Yields the body in chunks, as they arrive for a streamed response."""
        body = self.body
        if isinstance(body, bytes):
            if body:
                yield body
            return
        async for chunk in body:
            yield chunk

    async def read(self) -> bytes:
        """Reads the whole body."""
        return b"".join([chunk async for chunk in self.chunks()])

    async def text(self) -> str:
        """Reads the body as text."""
        return (await self.read()).decode("utf-8", "replace")

    def __repr__(self) -> str:
        return f"Response({self.status})"


#: Handles a request and returns a response: a fetch handler, such as an HTTP client or an
#: in-process application. It may be an `async def` function.
FetchHandler = Callable[[Request], "Awaitable[Response] | Response"]


async def _urllib_fetch(request: Request) -> Response:
    """Sends a request over the network with `urllib`, in a worker thread."""

    def send() -> Response:
        outgoing = urllib.request.Request(
            request.url,
            data=request.body or None,
            headers=dict(request.headers.items()),
            method=request.method,
        )
        try:
            with urllib.request.urlopen(outgoing) as reply:
                return Response(reply.read(), status=reply.status, headers=reply.headers.items())
        except urllib.error.HTTPError as error:
            return Response(error.read(), status=error.code, headers=error.headers.items())
        except (urllib.error.URLError, OSError) as error:
            raise TypeError("fetch failed") from error

    return await asyncio.to_thread(send)


_fetcher: list[FetchHandler] = [_urllib_fetch]


def set_fetch(handler: FetchHandler | None) -> None:
    """Replaces the handler that sends every outgoing request, or restores the network default.

    Hosted fetch sources, OpenAPI document URLs, remote MCP servers without a handler, and
    update checks send requests through it. Tests use it to route requests to fakes.
    """
    _fetcher[0] = handler or _urllib_fetch


async def fetch(request: Request) -> Response:
    """Sends a request through the outgoing handler that `set_fetch` installed."""
    return await call(_fetcher[0], request)


async def call(handler: FetchHandler, request: Request) -> Response:
    """Calls a fetch handler, awaiting it when it is asynchronous."""
    result = handler(request)
    if isinstance(result, Response):
        return result
    return await result


class RequestSource:
    """A hosted API reached over the network: forwards requests to a base URL.

    Create it with `incur.from_request`. Its `url` resolves relative OpenAPI document paths.
    """

    def __init__(self, url: str, headers: MappingABC[str, str] | None = None) -> None:
        """Creates a source that forwards requests under `url` with default `headers`."""
        self.url = normalize_url(url)
        """The base URL."""
        self.headers = dict(headers or {})
        """Headers merged into every forwarded request. Request headers take precedence."""

    async def __call__(self, request: Request) -> Response:
        """Forwards a request: its path joins the base path, and its query replaces the base's."""
        base = urllib.parse.urlsplit(self.url)
        incoming = urllib.parse.urlsplit(request.url)
        prefix = base.path[:-1] if base.path.endswith("/") else base.path
        suffix = incoming.path if incoming.path.startswith("/") else f"/{incoming.path}"
        target = base._replace(path=f"{prefix}{suffix}" or "/", query=incoming.query, fragment="")
        headers = Headers(self.headers)
        for name, value in request.headers.items():
            headers.set(name, value)
        forwarded = Request(urllib.parse.urlunsplit(target), method=request.method, headers=headers)
        forwarded.body = request.body
        return await fetch(forwarded)


def from_request(url: str, *, headers: MappingABC[str, str] | None = None) -> RequestSource:
    """Creates a hosted fetch source that forwards requests under a base URL.

    >>> source = from_request("https://api.example.com/v1/", headers={"authorization": "Bearer t"})
    >>> source.url
    'https://api.example.com/v1/'
    """
    return RequestSource(url, headers)


def normalize_url(url: str) -> str:
    """Normalizes an absolute URL as the WHATWG URL parser does for common inputs."""
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    netloc = parts.netloc.lower()
    path = parts.path or ("/" if scheme in ("http", "https") else "")
    path = urllib.parse.quote(path, safe="/%:@!$&'()*+,;=-._~")
    query = urllib.parse.quote(parts.query, safe="/%:@!$&'()*+,;=-._~?")
    return urllib.parse.urlunsplit((scheme, netloc, path, query, parts.fragment))


def join_url(base: str, reference: str) -> str:
    """Resolves a URL reference against a base URL."""
    return normalize_url(urllib.parse.urljoin(base, reference))


def origin(url: str) -> str:
    """Returns the origin of a URL: scheme, host, and port."""
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def search_params(query: str) -> list[tuple[str, str]]:
    """Parses a query string as `URLSearchParams` does."""
    return urllib.parse.parse_qsl(query, keep_blank_values=True)


def encode_params(params: Iterable[tuple[str, str]]) -> str:
    """Serializes query parameters as `URLSearchParams.toString()` does."""

    def encode(text: str) -> str:
        return urllib.parse.quote_plus(text, safe="*").replace("~", "%7E")

    return "&".join(f"{encode(key)}={encode(value)}" for key, value in params)


def parse_json(text: str) -> Json:
    """Parses JSON text as `JSON.parse` does. Raises `ValueError` when it is not JSON."""
    if _js.json_parse_error(text) is not None:
        raise ValueError(text)
    return _js.parse_json(text)


def asgi(handler: Callable[[Request], Awaitable[Response]]) -> Any:
    """Wraps a fetch handler as an ASGI 3 HTTP application."""

    async def app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                else:
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        body = b""
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        headers = [(k.decode("latin-1"), v.decode("latin-1")) for k, v in scope["headers"]]
        host = next((v for k, v in headers if k.lower() == "host"), None)
        if host is None:
            server = scope.get("server") or ("localhost", None)
            host = server[0] if server[1] in (None, 80, 443) else f"{server[0]}:{server[1]}"
        path = scope.get("raw_path", b"").decode("latin-1") or urllib.parse.quote(scope["path"])
        query = scope.get("query_string", b"").decode("latin-1")
        url = f"{scope.get('scheme', 'http')}://{host}{path}" + (f"?{query}" if query else "")
        request = Request(url, method=scope["method"], headers=headers)
        request.body = body
        response = await handler(request)
        await send(
            {
                "type": "http.response.start",
                "status": response.status,
                "headers": [(k.encode(), v.encode()) for k, v in response.headers.items()],
            }
        )
        async for chunk in response.chunks():
            await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b""})

    return app
