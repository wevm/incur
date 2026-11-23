"""Python mirror of the reference CLIs in `langs/differential/fixtures.ts`."""

from __future__ import annotations

import enum
import json
from collections.abc import Generator
from typing import Annotated, Any, Literal

import incur
from incur import Context, Cta, CtaBlock, Error, Example, Usage, field

Data = dict[str, object]
Stream = Generator[object, None, incur.Outcome | None]

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


@incur.schema(rename_all="SCREAMING_SNAKE_CASE")
class AppEnv:
    app_user: Annotated[str | None, field("Acting user")] = None


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
    deploy_retries: Annotated[float | None, field("Retries")] = None
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
class PrListOptions:
    state: Annotated[Literal["open", "closed", "all"], field("State")] = "open"


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


@incur.schema
class PrViewArgs:
    number: Annotated[float, field("PR number")]


@incur.schema
class DbArgs:
    table: Annotated[str | None, field("Table")] = None


def app() -> incur.Cli:
    pr = incur.Cli("pr", description="Pull request commands", vars={"user": "anonymous"})

    @pr.use
    def prefix_user(c: incur.MiddlewareContext, next_: incur.Next) -> None:
        c.set("user", f"pr:{c.var['user']}")
        next_()

    @pr.command("list", description="List pull requests")
    def pr_list(c: Context[None, PrListOptions]) -> Data:
        return {"prs": [], "state": c.options.state, "user": c.var["user"]}

    @pr.command("view", description="View a pull request")
    def pr_view(c: Context[PrViewArgs]) -> Data:
        return {"number": c.args.number}

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
        env=AppEnv,
        vars={"user": "anonymous"},
    )

    @cli.use
    def acting_user(c: incur.MiddlewareContext, next_: incur.Next) -> None:
        user = c.env.get("APP_USER")
        if user:
            c.set("user", user)
        next_()

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
    def greet(c: Context[GreetArgs, GreetOptions]) -> Data:
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
    def logs(c: Context) -> Stream:
        yield "connecting..."
        yield {"progress": 50}
        yield {"progress": 100}
        return incur.ok(cta=CtaBlock(["status"]))

    @cli.command("stream-fail", description="Stream then fail")
    def stream_fail(c: Context) -> Stream:
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
        return json.loads(c.args.json)

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
    def whoami(c: Context) -> Data:
        return {"user": c.var["user"]}

    def root_only(c: incur.MiddlewareContext, next_: incur.Next) -> None:
        if c.var["user"] != "root":
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

    return cli.group(pr).group(db).group(hi)


@incur.schema
class LoudOptions:
    loud: Annotated[bool | None, field("Shout")] = None


def greet() -> incur.Cli:
    cli = incur.Cli(
        "greet", description="A greeting CLI", banner=lambda: "Greet banner", banner_mode="agent"
    )

    @cli.root()
    def root(c: Context[GreetArgs, LoudOptions]) -> Data:
        name = c.args.name
        return {"message": f"HELLO {name}" if c.options.loud else f"hello {name}"}

    return cli


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


def globals_cli() -> incur.Cli:
    cli = incur.Cli(
        "glob",
        description="Global options",
        banner=lambda: "Glob banner",
        banner_mode="human",
        config=incur.Config(flag="config", loader=load_config),
        globals=Globals,
    )

    @cli.command("show", description="Show globals")
    def show(c: Context[None, ShowOptions]) -> Data:
        return {"globals": c.globals, "name": c.options.name}

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


def plain() -> incur.Cli:
    cli = incur.Cli(
        "plain",
        description="No skills, JSON by default",
        sync=False,
        format="json",
        aliases=["pl", "plain-cli"],
        config=incur.Config(),
        banner=lambda: "Welcome to plain",
    )

    @cli.command("hello", description="Say hello")
    def hello(c: Context) -> Data:
        return {"hello": "world"}

    @cli.command("ping")
    def ping(c: Context) -> str:
        return "pong"

    @cli.command("Hello", description="Say hello loudly")
    def hello_loud(c: Context) -> Data:
        return {"hello": "WORLD"}

    @cli.command("v2", description="Version two")
    def v2(c: Context) -> Data:
        return {"v": 2}

    @cli.command("ピン", description="Katakana ping")
    def katakana(c: Context) -> str:
        return "ポン"

    return cli


@incur.schema
class RootedArgs:
    query: Annotated[str | None, field("Query")] = None


def rooted() -> incur.Cli:
    cli = incur.Cli(
        "rooted",
        description="Root with subcommands",
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


def cli(name: str) -> incur.Cli:
    """Returns the fixture CLI with the given key from `cases.json`."""
    return {
        "app": app,
        "cfg": cfg,
        "globals": globals_cli,
        "greet": greet,
        "plain": plain,
        "rooted": rooted,
    }[name]()
