"""The HTTP types, the default network fetch, and the ASGI application."""

from __future__ import annotations

import asyncio
import http.server
import threading
from collections.abc import Generator
from typing import Any

import fixtures
import pytest
from inline_snapshot import snapshot

import incur


def test_headers() -> None:
    headers = incur.Headers([("Accept", "a"), ("accept", " b ")])
    headers.delete("X-Missing")
    assert ("ACCEPT" in headers, 1 in headers) == (True, False)
    assert repr(incur.Headers(headers)) == snapshot("Headers({'accept': 'a, b'})")
    headers.delete("Accept")
    assert list(headers) == []


def test_request_and_response() -> None:
    request = incur.Request("http://x/y", method="POST", body='{"a": 1}')
    assert (repr(request), request.json()) == snapshot(("Request(POST http://x/y)", {"a": 1}))
    response = incur.Response.json([1], status=201, headers={"content-type": "text/json"})
    assert (repr(response), response.headers.get("content-type")) == snapshot(
        ("Response(201)", "text/json")
    )


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers["content-length"]))
        self.send_response(200 if self.path == "/ok" else 418)
        self.send_header("x-echo", self.headers["x-test"])
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        pass


@pytest.fixture
def server() -> Generator[str, None, None]:
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever)
    thread.start()
    # The fixtures route outgoing requests to fakes; these tests use the network default.
    incur.set_fetch(None)
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    incur.set_fetch(fixtures.network)
    httpd.shutdown()
    httpd.server_close()
    thread.join()


async def _send(base: str, path: str) -> tuple[int, str | None, str]:
    request = incur.Request(f"http://x{path}", method="POST", headers={"x-test": "1"}, body="hi")
    response = await incur.from_request(base)(request)
    return response.status, response.headers.get("x-echo"), await response.text()


def test_fetches_over_the_network(server: str) -> None:
    assert asyncio.run(_send(server, "/ok")) == (200, "1", "hi")
    assert asyncio.run(_send(server, "/teapot")) == (418, "1", "hi")


def test_reports_network_failures(server: str) -> None:
    with pytest.raises(TypeError, match="fetch failed"):
        asyncio.run(_send("http://127.0.0.1:1", "/"))


def _asgi_cli() -> incur.Cli:
    cli = incur.Cli("tool", update=False)

    @cli.command("echo")
    def echo(c: incur.Context) -> str:
        return "ok"

    return cli


async def _call(app: Any, scope: dict[str, Any], *bodies: bytes) -> list[dict[str, Any]]:
    incoming = [
        {"type": "http.request", "body": b, "more_body": i < len(bodies) - 1}
        for i, b in enumerate(bodies)
    ]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return incoming.pop(0)

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await app(scope, receive, send)
    return sent


def test_asgi_lifespan() -> None:
    app = _asgi_cli().asgi
    incoming = [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return incoming.pop(0)

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    asyncio.run(app({"type": "lifespan"}, receive, send))
    assert sent == snapshot(
        [{"type": "lifespan.startup.complete"}, {"type": "lifespan.shutdown.complete"}]
    )


def test_asgi_requests() -> None:
    app = _asgi_cli().asgi
    base: dict[str, Any] = {"type": "http", "method": "POST", "headers": [], "path": "/echo"}
    sent = asyncio.run(_call(app, {**base, "server": ("example.com", 8080)}, b"{", b"}"))
    assert sent[0]["status"] == 200
    assert b"".join(m.get("body", b"") for m in sent[1:]).startswith(b'{"ok":true,"data":"ok"')
    for scope in (
        {**base, "server": ("example.com", 80), "query_string": b"a=1"},
        {**base, "headers": [(b"host", b"h")], "raw_path": b"/echo", "scheme": "https"},
        base,
    ):
        assert asyncio.run(_call(app, scope, b""))[0]["status"] == 200
