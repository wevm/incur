"""Python mirror of the reference CLIs in `langs/_differential/fixtures.ts`."""

from __future__ import annotations

import enum
import json
import sys
import urllib.parse
from collections.abc import AsyncGenerator, Awaitable, Generator
from typing import Annotated, Any, Literal

import incur
from incur import Context, Cta, CtaBlock, Error, Example, Usage, field
from incur._js import json_parse_error  # pyright: ignore[reportPrivateUsage]

Data = dict[str, object]
Stream = Generator[object, None, incur.Outcome | None]
AsyncStream = AsyncGenerator[object, None]

USERS: list[Data] = [
    {"name": "Alice", "email": "alice@example.com", "role": "admin"},
    {"name": "Bob", "email": "bob@example.com", "role": "user"},
    {"name": "Carol", "email": "carol@example.com", "role": "user"},
]

MIXED: Data = {
    "context": {
        "task": "Our favorite hikes together",
        "location": "Boulder",
        "season": "spring_2025",
    },
    "friends": ["ana", "luis", "sam"],
    "hikes": [
        {"id": 1, "name": "Blue Lake Trail", "distanceKm": 7.5, "wasSunny": True},
        {"id": 2, "name": "Ridge Overlook", "distanceKm": 9.2, "wasSunny": False},
    ],
    "matrix": [[1, 2], [3, 4]],
    "nested": [{"a": {"b": 1}}, "x", [1, {"y": 2}]],
    "empty": {},
    "none": [],
    "quoted": ["true", "42", "-dash", "a:b", " pad", "", "comma,here", "null", "05", "1e3"],
    "text": "line one\nline two",
    "long": (
        "This is a fairly long sentence that should exceed the default YAML line width of "
        "eighty characters easily."
    ),
    "unicode": "héllo wörld 日本語",
    "special": {"key with space": 1, "1abc": 2, "dotted.key": 3, "": 4},
    "numbers": [0, -1, 1.5, 1e21, 0.000001, 123456789012],
    "nil": None,
}


def parse_json(text: str) -> object:
    """Parses JSON as `JSON.parse` does, failing with V8's message."""
    message = json_parse_error(text)
    if message is not None:
        raise ValueError(message)
    return json.loads(text)


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class AppEnv:
    app_user: Annotated[str | None, field("Acting user")] = None


@incur.schema
class UserVars:
    user: str = "anonymous"


@incur.schema
class InstallArgs:
    package: Annotated[str | None, field("Package name")] = None


class Tag(enum.Enum):
    LATEST = "latest"
    NEXT = "next"


@incur.schema(rename_all="camelCase")
class InstallOptions:
    save_dev: Annotated[bool | None, field("Save as dev dependency", alias="D")] = None
    registry: Annotated[str | None, field("Registry URL", alias="r")] = None
    retries: Annotated[float, field("Retry count", min=0, max=10)] = 3
    tag: Annotated[Tag, field("Dist tag")] = Tag.LATEST


@incur.schema
class GreetArgs:
    name: Annotated[str, field("Name to greet")]


@incur.schema
class GreetOptions:
    loud: Annotated[bool, field("Shout")] = False
    times: Annotated[int | None, field("Repeat count", min=1, max=5)] = None
    suffix: Annotated[str | None, field("Suffix", min=1, max=3)] = None


@incur.schema
class GreetOutput:
    message: Annotated[str, field("The greeting")]


@incur.schema
class ListArgs:
    state: Annotated[Literal["open", "closed"], field("Item state")] = "open"


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class DeployEnv:
    deploy_token: Annotated[str, field("Deploy token")]
    deploy_region: Annotated[str, field("Region")] = "us"
    deploy_retries: Annotated[int | None, field("Retries")] = None
    deploy_dry: Annotated[bool | None, field("Dry run")] = None


@incur.schema
class DeployOptions:
    zone: Annotated[str | None, field("Availability zone", alias="z", deprecated=True)] = None
    region: Annotated[str | None, field("Target region")] = None
    force: Annotated[bool | None, field("Force deploy", alias="f")] = None


@incur.schema
class CountOptions:
    verbose: Annotated[int, field("Verbosity", alias="v", count=True)]
    quiet: Annotated[bool | None, field("Quiet", alias="q")] = None
    level: Annotated[int | None, field("Level")] = None


@incur.schema
class TagsArgs:
    target: Annotated[str, field("Target")]
    files: Annotated[list[str] | None, field("Files", min=1, max=3)] = None


@incur.schema
class TagsOptions:
    tag: Annotated[list[str], field("Tags", alias="t")] = []


@incur.schema
class UsageArgs:
    file: Annotated[str, field("File")]


@incur.schema
class UsageOptions:
    lines: Annotated[float | None, field("Lines")] = None


@incur.schema
class UserRow:
    name: Annotated[str, field("Name")]
    email: Annotated[str, field("Email")]
    role: Annotated[str, field("Role")]


@incur.schema
class PageInfo:
    total: Annotated[float, field("Total")]


@incur.schema
class UsersOutput:
    users: Annotated[list[UserRow], field("Users")]
    page: Annotated[PageInfo | None, field("Paging")] = None


@incur.schema
class Empty:
    pass


@incur.schema
class VariadicArgs:
    files: Annotated[list[str], field("Files")]
    last: Annotated[str, field("Last")]


@incur.schema
class DataArgs:
    json: Annotated[str, field("JSON value")]


async def prefix_user(c: incur.MiddlewareContext[UserVars], next_: incur.Next) -> None:
    """Prefixes the acting user for pull request commands."""
    c.var.user = f"pr:{c.var.user}"
    await next_()


class PrList(incur.Command, name="list"):
    """List pull requests"""

    state: Annotated[Literal["open", "closed", "all"], field("State")] = "open"


class PrView(incur.Command, name="view"):
    """View a pull request"""

    number: Annotated[float, incur.arg("PR number", coerce=False)]


class Pr(incur.Group[PrList | PrView], middleware=[prefix_user]):
    """Pull request commands"""


def pr(command: PrList | PrView, c: incur.Context[None, None, None, UserVars]) -> Data:
    match command:
        case PrList(state=state):
            return {"prs": [], "state": state, "user": c.var.user}
        case PrView(number=number):
            return {"number": number}


@incur.schema
class DbArgs:
    table: Annotated[str | None, field("Table")] = None


def app() -> incur.Cli:
    db = incur.Cli("db", description="Database commands", output_policy="agent-only")

    @db.root()
    def db_root(c: Context[DbArgs]) -> Data:
        return {"tables": [c.args.table] if c.args.table else ["users", "posts"]}

    @db.command("migrate", description="Run migrations")
    def migrate(c: Context) -> Data:
        return {"migrated": True}

    hi = incur.Cli("hi", description="Leaf CLI", aliases=["hey"])

    @hi.root()
    def hi_root(c: Context) -> Data:
        return {"hi": True}

    cli = incur.Cli(
        "app",
        description="A differential test CLI",
        version="1.2.3",
        update=False,
        env=AppEnv,
        vars=UserVars,
    )

    @cli.use
    def acting_user(
        c: incur.MiddlewareContext[UserVars, AppEnv], next_: incur.Next
    ) -> Awaitable[None]:
        if c.env.app_user:
            c.set("user", c.env.app_user)
        return next_()

    @cli.command("status", description="Show repo status", examples=[Example("", "Show status")])
    def status(c: Context) -> Data:
        return {"clean": True, "branch": "main"}

    @cli.command("install", description="Install a package")
    def install(c: Context[InstallArgs, InstallOptions]) -> Data:
        return {"added": 1, "package": c.args.package, **incur.dump(c.options)}

    @cli.command(
        "greet",
        description="Greet someone",
        output=GreetOutput,
        examples=[Example("world", "Greet the world"), Example("bob --loud true")],
        hint="Names are case-sensitive.",
    )
    async def greet(c: Context[GreetArgs, GreetOptions]) -> Data:
        message = f"hello {c.args.name}{c.options.suffix or ''}"
        if c.options.loud:
            message = message.upper()
        return {"message": " ".join([message] * (c.options.times or 1))}

    @cli.command("users", description="List users", output=UsersOutput)
    def users(c: Context) -> Data:
        return {"users": USERS}

    @cli.command("list", description="List items")
    def list_items(c: Context[ListArgs]) -> incur.Outcome:
        return incur.ok(
            {"items": [{"id": 1, "title": "Fix bug"}], "state": c.args.state},
            cta=CtaBlock(
                [
                    Cta("get 1", "View item"),
                    Cta("list", "View closed", args={"state": "closed"}),
                    Cta("search", options={"query": True}),
                    "status",
                    Cta("app whoami", "Who am I"),
                    Cta("tags", args={"target": True}, options={"tag": "x"}),
                ],
                description="Next steps:",
            ),
        )

    @cli.command("fail", description="Fail with a code")
    def fail(c: Context) -> Data:
        raise Error(
            "NOT_AUTHENTICATED",
            "GitHub token not found",
            hint="Tokens expire after 30 days.",
            retryable=True,
            exit_code=3,
            cta=CtaBlock([Cta("auth login", "Log in to GitHub"), "status"]),
        )

    @cli.command("throw", description="Throw an error")
    def throw(c: Context) -> Data:
        raise RuntimeError("boom")

    @cli.command("throw-incur", description="Throw an incur error")
    def throw_incur(c: Context) -> Data:
        raise Error("RATE_LIMITED", "Slow down", retryable=True)

    @cli.command(
        "deploy",
        description="Deploy the app",
        aliases=["ship"],
        destructive=True,
        hint="Requires a deploy token.",
    )
    def deploy(c: Context[None, DeployOptions, DeployEnv]) -> Data:
        return {
            "deployed": True,
            "region": c.options.region if c.options.region is not None else c.env.deploy_region,
            "retries": c.env.deploy_retries,
            "dry": c.env.deploy_dry,
        }

    @cli.command("logs", description="Tail logs")
    async def logs(c: Context) -> AsyncStream:
        yield "connecting..."
        yield {"progress": 50}
        yield {"progress": 100}
        yield incur.ok(cta=CtaBlock(["status"]))

    @cli.command("stream-fail", description="Stream then fail")
    async def stream_fail(c: Context) -> AsyncStream:
        yield {"step": 1}
        raise Error("STREAM_BROKE", "stream broke", cta=CtaBlock(["status"]))

    @cli.command(
        "nuke",
        description="Delete everything",
        destructive=True,
        hint="Confirm with the user before executing this destructive command.",
    )
    def nuke(c: Context) -> Data:
        return {"nuked": True}

    @cli.command("scalar", description="Return a string", output=str)
    def scalar(c: Context) -> str:
        return "hello world"

    @cli.command("number", description="Return a number")
    def number(c: Context) -> int:
        return 42

    @cli.command("nothing", description="Return nothing", output=Empty)
    def nothing(c: Context) -> None:
        return None

    @cli.command("json-string", description="Return JSON text")
    def json_string(c: Context) -> str:
        return '{"b":1,"a":[1,2]}'

    @cli.command("array", description="Return an array")
    def array(c: Context) -> list[int]:
        return [1, 2, 3]

    @cli.command("objects", description="Return objects", output=Any)
    def objects(c: Context) -> list[Data]:
        return USERS

    @cli.command("mixed", description="Return mixed data")
    def mixed(c: Context) -> Data:
        return MIXED

    @cli.command("data", description="Return parsed JSON")
    def data(c: Context[DataArgs]) -> object:
        return parse_json(c.args.json)

    @cli.command("secret", description="Agent-only output", output_policy="agent-only")
    def secret(c: Context) -> Data:
        return {"token": "abc"}

    @cli.command("count", description="Count flags")
    def count(c: Context[None, CountOptions]) -> Data:
        return {
            "verbose": c.options.verbose,
            "quiet": bool(c.options.quiet),
            "level": c.options.level,
        }

    @cli.command("tags", description="Collect values")
    def tags(c: Context[TagsArgs, TagsOptions]) -> Data:
        return {"target": c.args.target, "files": c.args.files or [], "tag": c.options.tag}

    @cli.command("variadic", description="Variadic arg first")
    def variadic(c: Context[VariadicArgs]) -> Data:
        return {"ok": True}

    @cli.command("whoami", description="Show the acting user")
    def whoami(c: Context[None, None, None, UserVars]) -> Data:
        return {"user": c.var.user}

    def root_only(c: incur.MiddlewareContext[UserVars], next_: incur.Next) -> None:
        if c.var.user != "root":
            raise Error("FORBIDDEN", "admin only")
        next_()

    @cli.command("admin", description="Admin only", destructive=True, middleware=[root_only])
    def admin(c: Context) -> Data:
        return {"admin": True}

    @cli.command("fmt", description="Defaults to JSON", format="json")
    def fmt(c: Context) -> Data:
        return {"a": 1}

    @cli.command(
        "usage",
        description="Custom usage",
        usage=[Usage(args=["file"]), Usage(options=["lines"], prefix="cat x |", suffix="| head")],
    )
    def usage(c: Context[UsageArgs, UsageOptions]) -> Data:
        return {"ok": True}

    return cli.group(incur.Cli(Pr).handle(pr)).group(db).group(hi)


class Greet(incur.Command, name="greet"):
    """A greeting CLI"""

    name: Annotated[str, incur.arg("Name to greet")]
    loud: Annotated[bool | None, field("Shout")] = None


def greet() -> incur.Cli[Greet]:
    return incur.Cli(
        Greet, update=False, banner=lambda: "Greet banner", banner_mode="agent"
    ).handle(lambda g, _: {"message": f"HELLO {g.name}" if g.loud else f"hello {g.name}"})


@incur.schema
class Globals:
    verbose: Annotated[bool | None, field("Verbose output", alias="V")] = None
    profile: Annotated[str, field("Profile name", alias="P")] = "dev"
    debug: Annotated[float, field("Debug level", alias="D", count=True)]


@incur.schema
class ShowOptions:
    name: Annotated[str | None, field("Name", alias="n")] = None
    all: Annotated[bool | None, field("All", alias="a")] = None


@incur.schema
class PickOptions:
    color: Annotated[Literal["red", "green"] | None, field("Color")] = None
    mode: Annotated[Literal["fast"] | None, field("Mode")] = None


def load_config(file: str | None) -> object:
    name = file or ""
    if name.endswith("none.json"):
        return None
    if name.endswith("array.json"):
        return [1]
    if name.endswith("throw.json"):
        message = "loader failed"
        raise RuntimeError(message)
    return {"commands": {"show": {"options": {"name": "loaded"}}}}


async def glob_banner() -> str:
    return "Glob banner"


def globals_cli() -> incur.Cli:
    cli = incur.Cli(
        "glob",
        description="Global options",
        update=False,
        banner=glob_banner,
        banner_mode="human",
        config=incur.Config(flag="config", loader=load_config),
        globals=Globals,
    )

    @cli.command("show", description="Show globals")
    def show(c: Context[None, ShowOptions, None, Any, Globals]) -> Data:
        return {"globals": incur.dump(c.globals), "name": c.options.name}

    @cli.command("pick", description="Pick a color")
    def pick(c: Context[None, PickOptions]) -> Data:
        return {"color": c.options.color}

    return cli


@incur.schema
class EchoArgs:
    text: Annotated[str, field("Text")]


@incur.schema
class Meta:
    a: Annotated[str, field("A")]


@incur.schema
class EchoOptions:
    upper: Annotated[bool | None, field("Uppercase")] = None
    prefix: Annotated[str, field("Prefix")] = ">"
    tags: Annotated[list[str] | None, field("Tags")] = None
    meta: Annotated[Meta | None, field("Meta")] = None
    extra: Annotated[Any | None, field("Extra")] = None


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class CfgEnv:
    cfg_limit: Annotated[float | None, field("Limit")] = None


@incur.schema
class CfgGlobals:
    trace: Annotated[bool | None, field("Trace")] = None


@incur.schema
class LimitOptions:
    limit: Annotated[float, field("Limit")] = 10


def cfg() -> incur.Cli:
    cli = incur.Cli(
        "cfg",
        description="Config defaults",
        update=False,
        config=incur.Config(flag="config", files=["config/cfg.json"]),
        env=CfgEnv,
        globals=CfgGlobals,
    )

    @cli.command("echo", description="Echo text")
    def echo(c: Context[EchoArgs, EchoOptions]) -> Data:
        text = c.args.text.upper() if c.options.upper else c.args.text
        return {"out": f"{c.options.prefix} {text}"}

    @cli.command("ping", description="Ping")
    def ping(c: Context) -> str:
        return "pong"

    project = incur.Cli("project", description="Projects")

    @project.command("list", description="List projects")
    def project_list(c: Context[None, LimitOptions]) -> Data:
        return {"limit": c.options.limit}

    return cli.group(project)


class Hello(incur.Command):
    """Say hello"""


class Ping(incur.Command): ...


class HelloLoud(incur.Command, name="Hello"):
    """Say hello loudly"""


class V2(incur.Command):
    """Version two"""


class Pin(incur.Command, name="ピン"):
    """Katakana ping"""


class Plain(incur.Group[Hello | Ping | HelloLoud | V2 | Pin], aliases=["pl", "plain-cli"]):
    """No skills, JSON by default"""


def plain() -> incur.Cli[Hello | Ping | HelloLoud | V2 | Pin]:
    def run(command: Hello | Ping | HelloLoud | V2 | Pin, _: object) -> object:
        match command:
            case Hello():
                return {"hello": "world"}
            case Ping():
                return "pong"
            case HelloLoud():
                return {"hello": "WORLD"}
            case V2():
                return {"v": 2}
            case Pin():
                return "ポン"

    return incur.Cli(
        Plain,
        update=False,
        sync=False,
        format="json",
        config=incur.Config(),
        banner=lambda: "Welcome to plain",
    ).handle(run)


@incur.schema
class RootedArgs:
    query: Annotated[str | None, field("Query")] = None


def rooted() -> incur.Cli:
    cli = incur.Cli(
        "rooted",
        description="Root with subcommands",
        update=False,
        config=incur.Config(files=["config/cfg.json"]),
    )

    @cli.root()
    def root(c: Context[RootedArgs]) -> Data:
        return {"query": c.args.query}

    @cli.command("sub", description="A subcommand")
    def sub(c: Context) -> Data:
        return {"sub": True}

    nest = incur.Cli("nest", description="Nested commands")

    @nest.command("leaf", description="A nested leaf")
    def leaf(c: Context) -> Data:
        return {"leaf": True}

    return cli.group(nest)


@incur.schema
class ShadowSkillArgs:
    id: Annotated[str, field("Skill id")]


def shadow() -> incur.Cli:
    cli = incur.Cli("shadow", description="Commands named like built-ins", update=False)
    mcp = incur.Cli("mcp", description="Manage servers")

    @mcp.command("add", description="Add a server")
    def add(c: Context) -> Data:
        return {"added": True}

    cli.group(mcp)

    @cli.command("skill", description="Show a skill")
    def skill(c: Context[ShadowSkillArgs]) -> Data:
        return {"id": c.args.id}

    @cli.command("shell", description="Show the shell", aliases=["completions"])
    def shell(c: Context) -> Data:
        return {"shell": True}

    return cli


def shadowall() -> incur.Cli:
    cli = incur.Cli("shadowall", description="Every built-in shadowed", update=False, sync=False)

    @cli.root()
    def root(c: Context) -> Data:
        return {"root": True}

    @cli.command("mcp", description="User mcp")
    def mcp(c: Context) -> Data:
        return {"mcp": True}

    @cli.command("completions", description="User completions")
    def completions(c: Context) -> Data:
        return {"completions": True}

    return cli


def network(request: incur.Request) -> incur.Response | Awaitable[incur.Response]:
    """The fake network: `hosted.test` reaches `upstream`, `registry.test` is a fake npm
    registry, and any other host fails like an unreachable server."""
    parts = urllib.parse.urlsplit(request.url)
    if parts.netloc == "hosted.test":
        return upstream(request)
    if parts.netloc == "registry.test":
        name = urllib.parse.unquote(parts.path[1:])
        if name == "missing":
            return incur.Response("Not Found", status=404)
        latest = "0.1.0" if name == "stale" else "2.0.0"
        return incur.Response.json({"name": name, "dist-tags": {"latest": latest}})
    raise TypeError("fetch failed")


incur.set_fetch(network)


def reply(body: object, status: int = 200) -> incur.Response:
    return incur.Response(
        json.dumps(body, separators=(",", ":"), ensure_ascii=False),
        status=status,
        headers={"content-type": "application/json"},
    )


async def upstream(request: incur.Request) -> incur.Response:
    """The upstream API behind fetch-backed and OpenAPI commands. Routes on the last path
    segment; unknown routes echo the request."""
    route = request.path.split("/")[-1]
    if route == "openapi.json":
        return reply(MINI_SPEC)
    if route == "users":
        return reply({"users": USERS})
    if route == "text":
        return incur.Response("plain text body")
    if route == "fail":
        return reply({"error": {"code": "NOT_FOUND", "message": "No such thing"}}, 404)
    if route == "bad":
        return reply({"message": "Bad input", "error": {"code": 7}}, 400)
    if route == "boom":
        return incur.Response("Internal failure", status=500)
    if route == "down":
        return reply({"status": "down"}, 503)
    if route == "empty":
        return incur.Response(status=204)
    if route == "stream":
        return incur.Response(
            '{"n":1}\n\nnot json\n{"n":2}\n{"n":3}',
            headers={"content-type": "application/x-ndjson"},
        )
    if route == "sse":
        return incur.Response('data: {"n":1}\n\n', headers={"content-type": "text/event-stream"})
    text = request.text()
    body: object = None
    if text:
        try:
            body = json.loads(text)
        except ValueError:
            body = text
    return reply(
        {
            "method": request.method,
            "path": urllib.parse.urlsplit(request.url).path,
            "query": request.query,
            "headers": dict(request.headers.items()),
            "body": body,
        }
    )


MINI_SPEC: Data = {
    "openapi": "3.1.0",
    "info": {"title": "Mini", "version": "1.0.0"},
    "paths": {
        "/ping": {"get": {"operationId": "ping", "summary": "Ping the API"}},
        "/ping/{id}": {
            "post": {
                "operationId": "pingOne",
                "parameters": [
                    {"name": "id", "in": "path", "required": True, "schema": {"type": "string"}}
                ],
            }
        },
    },
}

#: Request bodies composed with `oneOf`, `anyOf`, and `allOf`, flattened into options.
COMPOSED_SPEC: Data = {
    "openapi": "3.1.0",
    "info": {"title": "Composed", "version": "1.0.0"},
    "components": {
        "securitySchemes": {},
        "schemas": {
            "Ref": {"type": "object", "properties": {"ref": {"type": "string"}}},
            "Node": {
                "type": "object",
                "properties": {"label": {"type": "string"}},
                "allOf": [{"$ref": "#/components/schemas/Node"}],
            },
            "Left": {
                "properties": {"left": {"type": "string"}},
                "allOf": [{"$ref": "#/components/schemas/Right"}],
            },
            "Right": {
                "properties": {"right": {"type": "string"}},
                "allOf": [{"$ref": "#/components/schemas/Left"}],
            },
        },
    },
    "paths": {
        "/events": {
            "post": {
                "operationId": "createEvent",
                "summary": "Create an event",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "oneOf": [
                                    {
                                        "allOf": [
                                            {"$ref": "#/components/schemas/Ref"},
                                            {
                                                "properties": {
                                                    "kind": {"const": "push"},
                                                    "at": {"type": "string"},
                                                    "version": {"const": 1},
                                                    "meta": {"const": None},
                                                },
                                                "required": ["kind", "ref"],
                                            },
                                        ]
                                    },
                                    {
                                        "type": "object",
                                        "properties": {
                                            "kind": {"const": "tag"},
                                            "name": {"type": "string"},
                                            "at": {"type": "integer"},
                                            "version": {"const": 2},
                                            "meta": {"const": "x"},
                                        },
                                        "required": ["kind", "name"],
                                    },
                                    {"type": "string"},
                                    True,
                                ]
                            }
                        }
                    }
                },
            }
        },
        "/items": {
            "post": {
                "operationId": "createItem",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string", "description": "Item id"},
                                    "qty": {"type": "integer"},
                                },
                                "allOf": [
                                    {
                                        "type": "object",
                                        "properties": {
                                            "id": {"type": "string"},
                                            "qty": {"type": "integer", "minimum": 1},
                                        },
                                        "required": ["id"],
                                    },
                                    {"type": "object", "properties": {"note": {"type": "string"}}},
                                    True,
                                ],
                                "anyOf": [
                                    {
                                        "type": ["object", "None"],
                                        "properties": {"count": {"type": "integer"}},
                                    },
                                    {
                                        "type": "object",
                                        "properties": {"count": {"type": "integer"}},
                                    },
                                ],
                            }
                        }
                    }
                },
            }
        },
        "/policy": {
            "put": {
                "operationId": "setPolicy",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "anyOf": [
                                    {
                                        "type": "object",
                                        "properties": {"enabled": {"const": False}},
                                        "required": ["enabled"],
                                    },
                                    {
                                        "type": "object",
                                        "properties": {
                                            "enabled": {"const": True},
                                            "limit": {"type": "integer", "default": 10},
                                        },
                                        "required": ["enabled", "limit"],
                                    },
                                ]
                            }
                        }
                    }
                },
            }
        },
        "/rpc": {
            "post": {
                "operationId": "rpc",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "anyOf": [
                                    {
                                        "type": "object",
                                        "properties": {
                                            "method": {"type": "string"},
                                            "params": {"type": "array"},
                                        },
                                        "required": ["method"],
                                    },
                                    {"type": "array", "items": {"type": "object"}},
                                ]
                            }
                        }
                    }
                },
            }
        },
        "/nodes": {
            "post": {
                "operationId": "createNode",
                "requestBody": {
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/Node"}}
                    }
                },
            }
        },
        "/pair": {
            "post": {
                "operationId": "createPair",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "allOf": [
                                    {"$ref": "#/components/schemas/Left"},
                                    {"$ref": "#/components/schemas/Right"},
                                    {"$ref": "#/components/schemas/Ref"},
                                    {"$ref": "#/components/schemas/Ref"},
                                ]
                            }
                        }
                    }
                },
            }
        },
        "/raw": {
            "post": {
                "operationId": "raw",
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {"oneOf": [{"type": "array"}, {"type": "string"}]}
                        }
                    }
                },
            }
        },
    },
}

PET_ID: Data = {
    "name": "petId",
    "in": "path",
    "required": True,
    "description": "Pet id",
    "schema": {"type": "integer"},
}

PET_SPEC: Data = {
    "openapi": "3.1.0",
    "info": {"title": "Pets", "version": "1.0.0"},
    "security": [{"apiKey": []}],
    "components": {
        "securitySchemes": {
            "apiKey": {
                "type": "apiKey",
                "in": "header",
                "name": "X-Api-Key",
                "description": "API key",
            },
            "bearer": {"type": "http", "scheme": "bearer"},
            "basic": {"type": "http", "scheme": "Basic", "description": "Basic credentials"},
            "query": {"type": "apiKey", "in": "query", "name": "key"},
            "oauth": {"type": "oauth2"},
        },
        "schemas": {
            "Pet": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Pet name"},
                    "age": {"type": "integer", "minimum": 0},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "owner": {"type": "object", "properties": {"id": {"type": "string"}}},
                },
                "required": ["name"],
            }
        },
        "parameters": {
            "Limit": {
                "name": "limit",
                "in": "query",
                "description": "Max results",
                "schema": {"type": "integer", "minimum": 1, "maximum": 50},
            }
        },
    },
    "paths": {
        "/": {"get": {"operationId": "index", "summary": "API index"}},
        "/pets": {
            "get": {
                "operationId": "listPets",
                "summary": "List pets",
                "description": "Lists every pet in the store.",
                "parameters": [
                    {"$ref": "#/components/parameters/Limit"},
                    {
                        "name": "status",
                        "in": "query",
                        "required": True,
                        "schema": {"type": "string", "enum": ["available", "sold"]},
                    },
                    {"name": "vaccinated", "in": "query", "schema": {"type": "boolean"}},
                    {
                        "name": "X-Trace",
                        "in": "header",
                        "description": "Trace id",
                        "schema": {"type": "string"},
                    },
                ],
            },
            "post": {
                "operationId": "createPet",
                "summary": "Create a pet",
                "security": [{"bearer": []}],
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}
                    },
                },
            },
        },
        "/pets/{petId}": {
            "get": {"operationId": "getPet", "summary": "Get a pet", "parameters": [PET_ID]},
            "delete": {"operationId": "deletePet", "parameters": [PET_ID], "security": []},
            "put": {
                "summary": "Replace a pet",
                "parameters": [PET_ID],
                "security": [{"basic": []}, {"query": []}, {"oauth": []}, {"unknown": []}],
                "requestBody": {
                    "content": {
                        "application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}
                    }
                },
            },
        },
        "/pets/{petId}/fail": {"get": {"operationId": "failPet", "parameters": [PET_ID]}},
        "/store/text": {"get": {"operationId": "storeText", "description": "Plain text"}},
        "/store/bad": {
            "post": {"operationId": "storeBad", "summary": "Rejected", "description": "Rejected"}
        },
        "/store/boom": {"post": {"operationId": "storeBoom"}},
        "/search": {
            "get": {
                "operationId": "search",
                "summary": "Search",
                "parameters": [
                    {
                        "name": "q",
                        "in": "query",
                        "required": True,
                        "schema": {
                            "type": "string",
                            "pattern": f"^{'[a-z]' * 40}$",
                            "example": "abc",
                        },
                    },
                    {
                        "name": "since",
                        "in": "query",
                        "schema": {"type": "string", "format": "date-time"},
                    },
                    {"name": "score", "in": "query", "schema": {"type": ["number", "null"]}},
                ],
            }
        },
        "/v1/users": {"get": {"operationId": "listUsersV1", "summary": "List users (v1)"}},
        "/v2/users": {"get": {"operationId": "listUsersV2", "summary": "List users (v2)"}},
        "/v2/users/{id}": {
            "patch": {
                "operationId": "updateUser",
                "summary": "Update a user",
                "parameters": [
                    {"name": "id", "in": "path", "required": True, "schema": {"type": "string"}},
                    {"name": "limit", "in": "query", "schema": {"type": "integer"}},
                    {
                        "name": "limit",
                        "in": "header",
                        "required": True,
                        "schema": {"type": "string"},
                    },
                    {"name": "Limit", "in": "header", "schema": {"type": "string"}},
                ],
                "requestBody": {
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "properties": {
                                    "header-limit": {"type": "string"},
                                    "active": {"type": "boolean", "description": "Active flag"},
                                },
                                "required": ["active"],
                            }
                        }
                    }
                },
            }
        },
    },
}


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class ToolsEnv:
    tools_region: Annotated[str, field("Region")] = "eu"


@incur.schema
class ToolsGlobals:
    profile: Annotated[str, field("Profile")] = "dev"
    verbose: Annotated[bool | None, field("Verbose output")] = None


@incur.schema
class Trace:
    trace: str = "none"


@incur.schema
class EchoToolArgs:
    text: Annotated[str, field("Text to echo")]


@incur.schema
class EchoToolOptions:
    upper: Annotated[bool, field("Uppercase")] = False
    times: Annotated[int, field("Repeat count", min=1, max=3)] = 1


@incur.schema
class EchoToolOutput:
    text: Annotated[str, field("Echoed text")]


@incur.schema
class LabelOptions:
    label: Annotated[str | None, field("Label")] = None


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class TokenEnv:
    tools_token: Annotated[str | None, field("Token")] = None


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class RequiredTokenEnv:
    tools_token: Annotated[str, field("Token")]


@incur.schema
class NamedArgs:
    profile: Annotated[str, field("Profile argument")]


@incur.schema
class TargetArgs:
    target: Annotated[str | None, field("Target")] = None


@incur.schema
class OpsLimitOptions:
    limit: Annotated[float, field("Limit")] = 2


ToolsContext = incur.MiddlewareContext[Trace, ToolsEnv, ToolsGlobals]


def tool_cli(name: str, mcp: incur.McpOptions) -> incur.Cli:
    """A CLI that exercises MCP tool behaviors. `tools` and `catalog` differ only in `mcp`."""
    cli = incur.Cli(
        name,
        description="MCP tool behaviors",
        version="2.0.0",
        update=False,
        sync=False,
        mcp=mcp,
        config=incur.Config(),
        env=ToolsEnv,
        globals=ToolsGlobals,
        vars=Trace,
    )

    @cli.use
    async def trace(c: ToolsContext, next_: incur.Next) -> None:
        c.var.trace = f"root:{c.command}:{c.env.tools_region}"
        await next_()

    @cli.command(
        "echo",
        description="Echo text back",
        aliases=["say"],
        output=EchoToolOutput,
        mcp=incur.McpTool(
            annotations=incur.ToolAnnotations(
                title="Echo",
                read_only_hint=True,
                destructive_hint=False,
                idempotent_hint=True,
                open_world_hint=False,
            )
        ),
    )
    def echo(c: Context[EchoToolArgs, EchoToolOptions]) -> Data:
        text = c.args.text.upper() if c.options.upper else c.args.text
        return {"text": " ".join([text] * c.options.times)}

    @cli.command("context", description="Show globals, env, and vars")
    def context(c: Context[None, LabelOptions, TokenEnv, Trace, ToolsGlobals]) -> Data:
        return {
            "agent": c.agent,
            "format": c.format,
            "globals": incur.dump(c.globals),
            "label": c.options.label,
            "token": c.env.tools_token,
            "trace": c.var.trace,
        }

    @cli.command("named", description="Positional named like a global")
    def named(c: Context[NamedArgs, None, None, Trace, ToolsGlobals]) -> Data:
        return {"arg": c.args.profile, "global": c.globals.profile}

    @cli.command("deploy", description="Deploy with a required token", destructive=True)
    def deploy(c: Context[None, None, RequiredTokenEnv]) -> Data:
        return {"deployed": c.env.tools_token}

    @cli.command("fail", description="Fail with details")
    def fail(c: Context) -> Data:
        raise Error(
            "QUOTA",
            "Quota exceeded",
            hint="Wait a minute.",
            retryable=True,
            exit_code=4,
            cta=CtaBlock(
                [
                    Cta("echo", "Try again", args={"text": "retry"}),
                    Cta("context", options={"label": True}),
                ]
            ),
        )

    @cli.command("plain-fail", description="Fail without details")
    def plain_fail(c: Context) -> Data:
        raise Error("NOPE", "nope")

    @cli.command("throws", description="Throw an error")
    def throws(c: Context) -> Data:
        raise RuntimeError("kaput")

    @cli.command("suggest", description="Return data with suggestions")
    def suggest(c: Context) -> incur.Outcome:
        return incur.ok(
            {"done": True}, cta=CtaBlock(["echo next", "tools fail"], description="Then:")
        )

    @cli.command("stream", description="Stream chunks")
    async def stream(c: Context) -> AsyncStream:
        yield {"n": 1}
        yield "two"
        yield incur.ok(cta=CtaBlock(["echo done"]))

    @cli.command("stream-plain", description="Stream without suggestions")
    async def stream_plain(c: Context) -> AsyncStream:
        yield {"n": 1}

    @cli.command("stream-fail", description="Stream then fail")
    async def stream_fail(c: Context) -> AsyncStream:
        yield {"n": 1}
        raise Error("BROKEN", "stream broke", cta=CtaBlock(["stream"]))

    @cli.command("stream-throw", description="Stream then throw")
    async def stream_throw(c: Context) -> AsyncStream:
        yield {"n": 1}
        raise RuntimeError("stream threw")

    @cli.command("stream-return-error", description="Stream then return an error")
    async def stream_return_error(c: Context) -> AsyncStream:
        yield {"n": 1}
        raise Error("LATE", "failed at the end")

    @cli.command("scalar", description="Return a string", output=str)
    def scalar(c: Context) -> str:
        return "plain"

    @cli.command("nothing", description="Return nothing")
    def nothing(c: Context) -> None:
        return None

    @cli.command("hidden", description="Hidden from MCP", mcp=False)
    def hidden(c: Context) -> Data:
        return {"hidden": True}

    @cli.command(
        "renamed",
        description="Renamed for MCP",
        mcp=incur.McpTool(
            name="custom_tool", description="A custom tool", instructions="Call sparingly."
        ),
    )
    def renamed(c: Context) -> Data:
        return {"renamed": True}

    async def needs_verbose(c: ToolsContext, next_: incur.Next) -> None:
        if not c.globals.verbose:
            raise Error("NEEDS_VERBOSE", "pass verbose")
        await next_()

    @cli.command("guarded", description="Requires --verbose", middleware=[needs_verbose])
    def guarded(c: Context[None, None, None, Trace]) -> Data:
        return {"trace": c.var.trace}

    ops = incur.Cli("ops", description="Operations", vars=Trace)

    @ops.root()
    def ops_root(c: Context[TargetArgs]) -> Data:
        return {"ops": c.args.target or "all"}

    @ops.use
    async def ops_trace(c: incur.MiddlewareContext[Trace], next_: incur.Next) -> None:
        c.var.trace = f"{c.var.trace}>ops"
        await next_()

    @ops.command("list", description="List operations")
    def ops_list(c: Context[None, OpsLimitOptions, None, Trace]) -> Data:
        return {"limit": c.options.limit, "trace": c.var.trace}

    private = incur.Cli("private", description="Hidden group", mcp=False)

    @private.command("peek", description="Peek")
    def peek(c: Context) -> Data:
        return {"peek": True}

    return cli.group(ops).group(private)


def tools() -> incur.Cli:
    return tool_cli(
        "tools",
        incur.McpOptions(
            instructions="Use echo for testing.",
            title="Tool Box",
            tools=incur.ToolFilter(discovery="direct"),
        ),
    )


def catalog() -> incur.Cli:
    return tool_cli(
        "catalog",
        incur.McpOptions(
            tools=incur.ToolFilter(
                include=["echo", "ops*", "stream*", "fail", "context", "named", "deploy"],
                exclude=["stream-throw"],
            )
        ),
    )


def bare() -> incur.Cli:
    return incur.Cli("bare", update=False, sync=False)


def dupe() -> incur.Cli:
    cli = incur.Cli("dupe", description="Duplicate tool names", update=False, sync=False)

    @cli.command("a_b", description="Underscored")
    def a_b(c: Context) -> int:
        return 1

    group = incur.Cli("a", description="Group")

    @group.command("b")
    def b(c: Context) -> int:
        return 2

    return cli.group(group)


@incur.schema
class WebGlobals:
    region: Annotated[str, field("Region")] = "us"


@incur.schema
class WebArgs:
    name: Annotated[str | None, field("Name")] = None


@incur.schema
class ItemsArgs:
    id: Annotated[float | None, field("Item id")] = None


@incur.schema
class ItemsOptions:
    limit: Annotated[float, field("Limit")] = 10
    tags: Annotated[list[str] | None, field("Tags")] = None
    verbose: Annotated[bool | None, field("Verbose")] = None


@incur.schema
class CreateOptions:
    title: Annotated[str, field("Title", min=1)]
    draft: Annotated[bool, field("Draft")] = False


@incur.schema
class CreateOutput:
    title: str
    draft: bool


def web() -> incur.Cli:
    cli = incur.Cli(
        "web",
        description="HTTP serving",
        version="3.0.0",
        update=False,
        sync=False,
        mcp=incur.McpOptions(stateless=False),
        globals=WebGlobals,
    )

    @cli.root()
    def root(c: Context[WebArgs, None, None, Any, WebGlobals]) -> Data:
        return {"root": True, "name": c.args.name, "region": c.globals.region}

    @cli.command("items", description="List items")
    def items(c: Context[ItemsArgs, ItemsOptions, None, Any, WebGlobals]) -> Data:
        return {"id": c.args.id, **incur.dump(c.options), "region": c.globals.region}

    @cli.command("create", description="Create an item", output=CreateOutput)
    def create(c: Context[None, CreateOptions]) -> Data:
        return {**incur.dump(c.options)}

    @cli.command("request", description="Inspect the HTTP request")
    def request(c: Context) -> Data:
        r = c.request
        return {
            "agent": r.headers.get("x-agent") if r else None,
            "method": r.method if r else None,
            "url": r.url if r else None,
        }

    @cli.command("stream", description="Stream chunks")
    async def stream(c: Context) -> AsyncStream:
        yield {"n": 1}
        yield {"n": 2}
        yield incur.ok(cta=CtaBlock(["items"]))

    @cli.command("stream-plain", description="Stream without suggestions")
    async def stream_plain(c: Context) -> AsyncStream:
        yield "only"

    @cli.command("stream-fail", description="Stream then fail")
    async def stream_fail(c: Context) -> AsyncStream:
        yield {"n": 1}
        raise Error("BROKEN", "stream broke", cta=CtaBlock(["stream"]))

    @cli.command("stream-throw", description="Stream then throw")
    async def stream_throw(c: Context) -> AsyncStream:
        yield {"n": 1}
        raise RuntimeError("stream threw")

    @cli.command("stream-return-error", description="Stream then return an error")
    async def stream_return_error(c: Context) -> AsyncStream:
        yield {"n": 1}
        raise Error("LATE", "failed at the end")

    @cli.command("fail", description="Fail with suggestions")
    def fail(c: Context) -> Data:
        raise Error("NOPE", "nope", retryable=False, cta=CtaBlock(["items"]))

    @cli.command("throws", description="Throw an error")
    def throws(c: Context) -> Data:
        raise RuntimeError("kaput")

    admin = incur.Cli("admin", description="Admin commands")

    @admin.use
    def eu_only(c: incur.MiddlewareContext[Any, Any, WebGlobals], next_: incur.Next) -> None:
        if c.globals.region != "eu":
            raise Error("REGION", "eu only")
        next_()

    @admin.command("stats", description="Show stats")
    def stats(c: Context) -> Data:
        return {"users": 3}

    return cli.group(admin)


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class GatewayEnv:
    gateway_mode: Annotated[str | None, field("Mode")] = None


def gateway() -> incur.Cli:
    cli = incur.Cli(
        "gateway", description="Fetch gateways", update=False, sync=False, env=GatewayEnv
    )

    @cli.use
    async def mode(c: incur.MiddlewareContext[Any, GatewayEnv], next_: incur.Next) -> None:
        if c.env.gateway_mode == "deny":
            raise Error("DENIED", "gateway denied", cta=CtaBlock(["status"]))
        if c.env.gateway_mode == "throw":
            raise RuntimeError("middleware threw")
        await next_()

    cli.gateway("api", upstream, description="Upstream API")
    cli.gateway("v1", upstream, base_path="/v1")
    cli.gateway(
        "hosted",
        incur.from_request(
            "http://hosted.test/base/",
            headers={"authorization": "Bearer hosted", "x-default": "yes"},
        ),
        description="Hosted API",
    )
    cli.gateway("offline", incur.from_request("http://offline.test"), description="Unreachable API")
    cli.gateway("secret", upstream, description="Agent-only API", output_policy="agent-only")

    @cli.command("status", description="Local command")
    def status(c: Context) -> Data:
        return {"ok": True}

    nested = incur.Cli("nested", description="Nested gateways")
    nested.gateway("api", upstream, description="Nested API")
    return cli.group(nested)


def proxy() -> incur.Cli:
    cli = incur.Cli(
        "proxy", description="Root fetch with commands", update=False, sync=False, fetch=upstream
    )

    @cli.command("local", description="Local command")
    def local(c: Context) -> Data:
        return {"local": True}

    return cli


def raw() -> incur.Cli:
    return incur.Cli("raw", description="Root fetch only", update=False, sync=False, fetch=upstream)


def oa() -> incur.Cli:
    cli = incur.Cli(
        "oa", description="OpenAPI commands", update=False, sync=False, config=incur.Config()
    )
    cli.gateway("ops", upstream, description="Operation mode", openapi=PET_SPEC)
    cli.gateway(
        "ns",
        upstream,
        description="Namespace mode",
        base_path="/base",
        openapi=PET_SPEC,
        openapi_config=incur.OpenapiConfig(
            mode="namespace",
            groups={
                "pets": "Pet operations",
                "v2 users": "Users (v2)",
                "missing": "Ignored",
                "pets petId get": "Leaf",
            },
            forward_headers=["x-forward", "x-api-key"],
        ),
    )
    cli.gateway(
        "latest",
        upstream,
        description="Latest versions only",
        openapi=PET_SPEC,
        openapi_config=incur.OpenapiConfig(
            mode="namespace",
            versions="latest",
            security=False,
            include=lambda o: o.method != "delete" and not o.path.startswith("/store"),
        ),
    )
    cli.gateway(
        "compact",
        upstream,
        description="Compact schemas",
        openapi=PET_SPEC,
        openapi_config=incur.OpenapiConfig(compact=True, include=lambda o: o.path == "/search"),
        mcp=False,
    )
    cli.gateway("composed", upstream, description="Composed request bodies", openapi=COMPOSED_SPEC)
    cli.gateway(
        "url", upstream, description="Spec from a URL", openapi="http://hosted.test/openapi.json"
    )
    cli.gateway(
        "rel",
        incur.from_request("http://hosted.test/svc"),
        description="Spec relative to a hosted source",
        openapi="openapi.json",
        output_policy="agent-only",
    )
    return cli


def oaroot() -> incur.Cli:
    return incur.Cli(
        "oaroot",
        description="Root OpenAPI commands",
        version="0.1.0",
        update=False,
        sync=False,
        fetch=upstream,
        openapi=MINI_SPEC,
        openapi_config=incur.OpenapiConfig(mode="namespace"),
    )


FAKE_TOOLS: list[object] = [
    {
        "name": "structured",
        "description": "Structured result",
        "inputSchema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "Count"},
                "label": {"type": "string"},
                "on": {"type": "boolean"},
                "ratio": {"type": ["number", "null"]},
                "tags": {"type": ["array", "null"], "items": {"type": "string"}},
            },
            "required": ["count"],
        },
        "outputSchema": {"type": "object", "properties": {"total": {"type": "number"}}},
        "annotations": {"readOnlyHint": True},
    },
    {"name": "headers", "description": "Echo MCP headers"},
    {"name": "texts", "description": "Two text items", "outputSchema": {"type": "string"}},
    {"name": "words", "description": "Non-JSON text"},
    {"name": "none", "description": "No content"},
    {"name": "tool-error", "description": "Tool error result"},
    {"name": "silent-error", "description": "Tool error without text"},
    {"name": "rpc-error", "description": "JSON-RPC error"},
    {"name": "http-error", "description": "HTTP error"},
    {"name": "sse", "description": "SSE response"},
    {"name": "sse-other", "description": "SSE without a matching message"},
    {"name": "empty-body", "description": "Empty response body"},
]


def compact(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


async def fake_mcp(request: incur.Request) -> incur.Response:
    """A fake streamable-HTTP MCP server with canned tool results."""
    message: dict[str, Any] = json.loads(request.text())
    head = {"jsonrpc": "2.0", **({"id": message["id"]} if "id" in message else {})}

    def answer(result: object, headers: dict[str, str] | None = None) -> incur.Response:
        return incur.Response(
            compact({**head, "result": result}),
            headers={"content-type": "application/json", **(headers or {})},
        )

    def text(*items: str) -> incur.Response:
        return answer({"content": [{"type": "text", "text": t} for t in items]})

    method = message["method"]
    if method == "initialize":
        return answer(
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake", "version": "1.0.0"},
            },
            {"mcp-session-id": "fake-session"},
        )
    if method == "notifications/initialized":
        return incur.Response(status=202)
    if method == "tools/list":
        return answer({"tools": FAKE_TOOLS})
    params: dict[str, Any] = message.get("params") or {}
    args: dict[str, Any] = params.get("arguments") or {}
    name = params.get("name")
    if name == "structured":
        total = args["count"] * 2 if isinstance(args.get("count"), (int, float)) else None
        return answer(
            {
                "content": [{"type": "text", "text": "ignored"}],
                "structuredContent": {"total": total, "args": args},
            }
        )
    if name == "headers":
        return text(
            compact(
                {
                    "session": request.headers.get("mcp-session-id"),
                    "version": request.headers.get("mcp-protocol-version"),
                    "custom": request.headers.get("x-custom"),
                    "accept": request.headers.get("accept"),
                }
            )
        )
    if name == "texts":
        return text("first", "second")
    if name == "words":
        return text("just words")
    if name == "none":
        return answer({})
    if name == "tool-error":
        return answer({"content": [{"type": "text", "text": "remote failed"}], "isError": True})
    if name == "silent-error":
        return answer({"content": [{"type": "image", "data": ""}], "isError": True})
    if name == "rpc-error":
        return incur.Response(
            compact({**head, "error": {"code": -32000, "message": "rpc failed"}}),
            headers={"content-type": "application/json"},
        )
    if name == "http-error":
        return incur.Response("unavailable", status=503)
    if name == "sse":
        result = {**head, "result": {"content": [{"type": "text", "text": '{"via":"sse"}'}]}}
        return incur.Response(
            'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
            f"data: {compact(result)}\n\n",
            headers={"content-type": "text/event-stream"},
        )
    if name == "sse-other":
        return incur.Response(
            'data: {"jsonrpc":"2.0","id":"other","result":{}}\n\n',
            headers={"content-type": "text/event-stream"},
        )
    return incur.Response("", headers={"content-type": "application/json"})


def remote() -> incur.Cli:
    cli = incur.Cli("remote", description="Remote MCP servers", update=False, sync=False)
    cli.mcp_source(
        "direct", "http://tools.test/mcp", fetch=tools().fetch, description="Direct discovery"
    )
    cli.mcp_source(
        "catalog",
        "http://catalog.test/mcp",
        fetch=catalog().fetch,
        description="Progressive discovery",
    )
    cli.mcp_source(
        "paged",
        "http://app.test/mcp",
        fetch=app().fetch,
        description="Progressive discovery across pages",
    )
    cli.mcp_source(
        "session", "http://web.test/mcp", fetch=web().fetch, description="Stateful server"
    )
    cli.mcp_source(
        "fake",
        "http://fake.test/mcp",
        fetch=fake_mcp,
        headers={"x-custom": "yes"},
        description="Canned server",
        output_policy="agent-only",
    )

    @cli.command("local", description="Local command")
    def local(c: Context) -> Data:
        return {"local": True}

    return cli


@incur.schema
class DeployTargetArgs:
    env: Annotated[Literal["staging", "prod"], field("Target environment")]


def kit_cli(
    name: str,
    *,
    command: str | None = None,
    cwd: str | None = None,
    mcp: incur.McpOptions | None = None,
    package: str | None = None,
    version: str = "1.4.0",
) -> incur.Cli:
    """A CLI that syncs skills and registers MCP servers."""
    cli = incur.Cli(
        name,
        description="Skill and MCP sync",
        version=version,
        update=False,
        package=package,
        mcp=mcp,
        sync=incur.Sync(
            command=command,
            cwd=cwd,
            include=["skills/*", "_root"],
            body="Run `kit auth login` to finish setup.",
            suggestions=["Show my status", "Deploy the app"],
        ),
    )

    @cli.command("status", description="Show status", examples=[Example("", "Show status")])
    def status(c: Context) -> Data:
        return {"ok": True}

    @cli.command("deploy", description="Deploy the app", destructive=True)
    def deploy(c: Context[DeployTargetArgs]) -> Data:
        return {"deployed": c.args.env}

    auth = incur.Cli("auth", description="Authentication")

    @auth.command("login", description="Log in")
    def login(c: Context) -> Data:
        return {"ok": True}

    @auth.command("logout", description="Log out", hint="Clears tokens.")
    def logout(c: Context) -> Data:
        return {"ok": True}

    return cli.group(auth)


def report(label: str, fields: dict[str, object]) -> None:
    """Writes an update callback's context to stderr, as the reference fixtures do."""
    present = {key: value for key, value in fields.items() if value is not None}
    sys.stderr.write(f"{label} {compact(present)}\n")


def status_cli(name: str, update: incur.Update, description: str | None = None) -> incur.Cli:
    cli = incur.Cli(name, description=description, version="1.0.0", update=update)

    @cli.command("status", description="Show status" if description else None)
    def status(c: Context) -> Data:
        return {"ok": True}

    return cli


def upd() -> incur.Cli:
    def check(c: incur.UpdateCheck) -> str | None:
        report("check", {"current": c.current, "name": c.name, "package": c.package})
        return "1.2.0" if c.current == "1.0.0" else None

    def install(c: incur.UpdateInstall) -> None:
        report(
            "install",
            {"current": c.current, "latest": c.latest, "name": c.name, "package": c.package},
        )

    return status_cli("upd", incur.Update(check=check, install=install), "Custom updates")


def updbeta() -> incur.Cli:
    def install(c: incur.UpdateInstall) -> None:
        raise RuntimeError("installer failed")

    cli = incur.Cli(
        "updbeta",
        description="Prerelease updates",
        version="1.0.0-beta.2",
        sync=False,
        update=incur.Update(check=lambda c: "not-a-version", deferred=True, install=install),
    )

    @cli.command("status", description="Show status")
    def status(c: Context) -> Data:
        return {"ok": True}

    return cli


def updcheck() -> incur.Cli:
    def check(c: incur.UpdateCheck) -> str | None:
        raise RuntimeError("check failed")

    cli = incur.Cli(
        "updcheck",
        version="1.0.0",
        sync=False,
        update=incur.Update(check=check, deferred=True, install=lambda c: None),
    )

    @cli.command("status")
    def status(c: Context) -> Data:
        return {"ok": True}

    return cli


def updnone() -> incur.Cli:
    cli = incur.Cli(
        "updnone", version="1.0.0", sync=False, update=incur.Update(check=lambda c: "9.0.0")
    )

    @cli.command("status")
    def status(c: Context) -> Data:
        return {"ok": True}

    return cli


def updpkg() -> incur.Cli:
    cli = incur.Cli("updpkg", description="Package updates", sync=False)

    @cli.command("status")
    def status(c: Context) -> Data:
        return {"ok": True}

    return cli


def updbad() -> incur.Cli:
    cli = incur.Cli("updbad", sync=False, update=incur.Update(package="Bad Name!"))

    @cli.command("status")
    def status(c: Context) -> Data:
        return {"ok": True}

    return cli


def cli(name: str) -> incur.Cli:
    """Returns the fixture CLI with the given key from `cases.json`."""
    return {
        "app": app,
        "bare": bare,
        "catalog": catalog,
        "cfg": cfg,
        "dupe": dupe,
        "gateway": gateway,
        "globals": globals_cli,
        "greet": greet,
        "kit": lambda: kit_cli("kit"),
        "kitbad": lambda: kit_cli("kitbad", package="Bad Name", version="1"),
        "kitcmd": lambda: kit_cli(
            "kitcmd", mcp=incur.McpOptions(agents=["cursor", "amp"], command="kit serve --stdio")
        ),
        "kitcwd": lambda: kit_cli("kitcwd", cwd="vendor"),
        "kitpkg": lambda: kit_cli(
            "kitpkg", package="@acme/kit", mcp=incur.McpOptions(name="acme", agents=["amp"])
        ),
        "kitrun": lambda: kit_cli("kitrun", command="bunx @acme/kit"),
        "kitver": lambda: kit_cli("kitver", package="kitver", version="latest"),
        "oa": oa,
        "oaroot": oaroot,
        "plain": plain,
        "proxy": proxy,
        "raw": raw,
        "remote": remote,
        "rooted": rooted,
        "shadow": shadow,
        "shadowall": shadowall,
        "spaced": lambda: kit_cli("kit tool"),
        "tools": tools,
        "upd": upd,
        "updbad": updbad,
        "updbeta": updbeta,
        "updcheck": updcheck,
        "updnone": updnone,
        "updpkg": updpkg,
        "web": web,
    }[name]()
