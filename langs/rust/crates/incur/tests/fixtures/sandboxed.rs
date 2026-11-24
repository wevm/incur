//! Mirror of the fixture CLIs that sandboxed cases run: MCP, HTTP, fetch, OpenAPI, MCP sources,
//! skills, and updates.

use std::io::Write as _;

use futures::future::BoxFuture;
use futures::{FutureExt as _, stream};
use incur::mcp::{Annotations, Discovery, Mcp, Tool};
use incur::openapi::{Mode, Openapi, Versions};
use incur::update::{CheckContext, InstallContext};
use incur::{
    Body, Cli, Command, Config, Context, Cta, CtaBlock, Error, Fetch, FetchCommand, McpSource,
    OutputPolicy, Schema, SkillSync, Update,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::services::{composed_spec, fake_mcp, mini_spec, network, pet_spec, upstream};

/// Returns a JSON value.
#[expect(clippy::unnecessary_wraps, reason = "Handlers return results.")]
fn data(value: Value) -> Result<Value, Error> {
    Ok(value)
}

/// Routes outgoing requests through the fake network.
fn client(cli: Cli) -> Cli {
    cli.client(network)
}

/// The middleware trace variable.
struct Trace(String);

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct ToolsEnv {
    /// Region
    #[serde(default = "eu")]
    #[expect(dead_code, reason = "Middleware reads the raw environment.")]
    tools_region: String,
}

fn eu() -> String {
    "eu".into()
}

#[derive(Deserialize, Schema)]
struct ToolGlobals {
    /// Profile
    #[serde(default = "dev")]
    #[expect(dead_code, reason = "Handlers read raw globals.")]
    profile: String,
    /// Verbose output
    #[expect(dead_code, reason = "Handlers read raw globals.")]
    verbose: Option<bool>,
}

fn dev() -> String {
    "dev".into()
}

#[derive(Deserialize, Schema)]
struct EchoArgs {
    /// Text to echo
    text: String,
}

#[derive(Deserialize, Schema)]
struct EchoOptions {
    /// Uppercase
    #[serde(default)]
    upper: bool,
    /// Repeat count
    #[incur(min = 1, max = 3)]
    #[serde(default = "one")]
    times: i64,
}

fn one() -> i64 {
    1
}

#[derive(Schema)]
#[expect(dead_code, reason = "Only the schema is used.")]
struct EchoOutput {
    /// Echoed text
    text: String,
}

#[derive(Deserialize, Schema)]
struct LabelOptions {
    /// Label
    label: Option<String>,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct TokenEnv {
    /// Token
    tools_token: Option<String>,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct RequiredTokenEnv {
    /// Token
    tools_token: String,
}

#[derive(Deserialize, Schema)]
struct NamedArgs {
    /// Profile argument
    profile: String,
}

#[derive(Deserialize, Schema)]
struct TargetArgs {
    /// Target
    target: Option<String>,
}

#[derive(Deserialize, Schema)]
struct LimitOptions {
    /// Limit
    #[serde(default = "two")]
    limit: f64,
}

fn two() -> f64 {
    2.0
}

/// Builds a CLI that exercises MCP tool behaviors.
fn tool_cli(name: &str, mcp: Mcp) -> Cli {
    client(Cli::new(name))
        .description("MCP tool behaviors")
        .version("2.0.0")
        .update(false)
        .sync(false)
        .mcp(mcp)
        .config(Config::default())
        .env::<ToolsEnv>()
        .globals::<ToolGlobals>()
        .var(Trace("none".into()))
        .middleware(|mut c, next| {
            let region = c.env["TOOLS_REGION"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            c.set(Trace(format!("root:{}:{region}", c.command)));
            next.run(c)
        })
        .command(
            "echo",
            Command::new()
                .description("Echo text back")
                .aliases(["say"])
                .output::<EchoOutput>()
                .mcp(Tool::new().annotations(Annotations {
                    title: Some("Echo".into()),
                    read_only_hint: Some(true),
                    destructive_hint: Some(false),
                    idempotent_hint: Some(true),
                    open_world_hint: Some(false),
                }))
                .run(|c: Context<EchoArgs, EchoOptions>| {
                    let text = if c.options.upper {
                        c.args.text.to_uppercase()
                    } else {
                        c.args.text
                    };
                    let times = usize::try_from(c.options.times).unwrap_or(1);
                    data(json!({ "text": vec![text; times].join(" ") }))
                }),
        )
        .command(
            "context",
            Command::new()
                .description("Show globals, env, and vars")
                .run(|c: Context<(), LabelOptions, TokenEnv>| {
                    data(json!({
                        "agent": c.agent,
                        "format": c.format.to_string(),
                        "globals": c.globals,
                        "label": c.options.label,
                        "token": c.env.tools_token,
                        "trace": c.var::<Trace>().map(|t| t.0.clone()),
                    }))
                }),
        )
        .command(
            "named",
            Command::new()
                .description("Positional named like a global")
                .run(|c: Context<NamedArgs>| {
                    data(json!({ "arg": c.args.profile, "global": c.globals["profile"] }))
                }),
        )
        .command(
            "deploy",
            Command::new()
                .description("Deploy with a required token")
                .destructive()
                .run(|c: Context<(), (), RequiredTokenEnv>| {
                    data(json!({ "deployed": c.env.tools_token }))
                }),
        )
        .command(
            "fail",
            Command::new()
                .description("Fail with details")
                .run(|_: Context| {
                    Err::<Value, _>(
                        Error::new("QUOTA", "Quota exceeded")
                            .hint("Wait a minute.")
                            .retryable(true)
                            .exit_code(4)
                            .cta(CtaBlock::new([
                                Cta::new("echo")
                                    .arg("text", "retry")
                                    .description("Try again"),
                                Cta::new("context").option("label", true),
                            ])),
                    )
                }),
        )
        .command(
            "plain-fail",
            Command::new()
                .description("Fail without details")
                .run(|_: Context| Err::<Value, _>(Error::new("NOPE", "nope"))),
        )
        .command(
            "throws",
            Command::new()
                .description("Throw an error")
                .run(|_: Context| Err::<Value, _>(Error::from("kaput"))),
        )
        .command(
            "suggest",
            Command::new()
                .description("Return data with suggestions")
                .run(|_: Context| {
                    incur::ok(json!({ "done": true }))
                        .cta(CtaBlock::new(["echo next", "tools fail"]).description("Then:"))
                }),
        )
        .command(
            "stream",
            Command::new()
                .description("Stream chunks")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok::<_, Error>(json!({ "n": 1 })),
                        Ok(json!("two")),
                    ]))
                    .cta(CtaBlock::new(["echo done"]))
                }),
        )
        .command(
            "stream-plain",
            Command::new()
                .description("Stream without suggestions")
                .run(|_: Context| incur::stream(stream::iter([Ok::<_, Error>(json!({ "n": 1 }))]))),
        )
        .command(
            "stream-fail",
            Command::new()
                .description("Stream then fail")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok(json!({ "n": 1 })),
                        Err(Error::new("BROKEN", "stream broke").cta(CtaBlock::new(["stream"]))),
                    ]))
                }),
        )
        .command(
            "stream-throw",
            Command::new()
                .description("Stream then throw")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok(json!({ "n": 1 })),
                        Err(Error::from("stream threw")),
                    ]))
                }),
        )
        .command(
            "stream-return-error",
            Command::new()
                .description("Stream then return an error")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok(json!({ "n": 1 })),
                        Err(Error::new("LATE", "failed at the end")),
                    ]))
                }),
        )
        .command(
            "scalar",
            Command::new()
                .description("Return a string")
                .output::<String>()
                .run(|_: Context| data(json!("plain"))),
        )
        .command(
            "nothing",
            Command::new()
                .description("Return nothing")
                .run(|_: Context| Ok::<_, Error>(())),
        )
        .command(
            "hidden",
            Command::new()
                .description("Hidden from MCP")
                .mcp(false)
                .run(|_: Context| data(json!({ "hidden": true }))),
        )
        .command(
            "renamed",
            Command::new()
                .description("Renamed for MCP")
                .mcp(
                    Tool::new()
                        .name("custom_tool")
                        .description("A custom tool")
                        .instructions("Call sparingly."),
                )
                .run(|_: Context| data(json!({ "renamed": true }))),
        )
        .command(
            "guarded",
            Command::new()
                .description("Requires --verbose")
                .middleware(|c, next| async move {
                    if c.globals["verbose"] != Value::Bool(true) {
                        return Err(Error::new("NEEDS_VERBOSE", "pass verbose"));
                    }
                    next.run(c).await
                })
                .run(|c: Context| data(json!({ "trace": c.var::<Trace>().map(|t| t.0.clone()) }))),
        )
        .group(
            Cli::new("ops")
                .description("Operations")
                .var(Trace("none".into()))
                .root(Command::new().run(|c: Context<TargetArgs>| {
                    data(json!({ "ops": c.args.target.unwrap_or_else(|| "all".into()) }))
                }))
                .middleware(|mut c, next| {
                    let trace = c.var::<Trace>().map(|t| t.0.clone()).unwrap_or_default();
                    c.set(Trace(format!("{trace}>ops")));
                    next.run(c)
                })
                .command(
                    "list",
                    Command::new().description("List operations").run(
                        |c: Context<(), LimitOptions>| {
                            data(json!({
                                "limit": c.options.limit,
                                "trace": c.var::<Trace>().map(|t| t.0.clone()),
                            }))
                        },
                    ),
                ),
        )
        .group(
            Cli::new("private")
                .description("Hidden group")
                .mcp(false)
                .command(
                    "peek",
                    Command::new()
                        .description("Peek")
                        .run(|_: Context| data(json!({ "peek": true }))),
                ),
        )
}

pub(crate) fn tools() -> Cli {
    tool_cli(
        "tools",
        Mcp::new()
            .instructions("Use echo for testing.")
            .title("Tool Box")
            .discovery(Discovery::Direct),
    )
}

pub(crate) fn catalog() -> Cli {
    tool_cli(
        "catalog",
        Mcp::new()
            .include([
                "echo", "ops*", "stream*", "fail", "context", "named", "deploy",
            ])
            .exclude(["stream-throw"]),
    )
}

pub(crate) fn bare() -> Cli {
    client(Cli::new("bare")).update(false).sync(false)
}

pub(crate) fn dupe() -> Cli {
    client(Cli::new("dupe"))
        .description("Duplicate tool names")
        .update(false)
        .sync(false)
        .command(
            "a_b",
            Command::new()
                .description("Underscored")
                .run(|_: Context| data(json!(1))),
        )
        .group(
            Cli::new("a")
                .description("Group")
                .command("b", Command::new().run(|_: Context| data(json!(2)))),
        )
}

#[derive(Deserialize, Schema)]
struct RegionGlobals {
    /// Region
    #[serde(default = "us")]
    #[expect(dead_code, reason = "Handlers read raw globals.")]
    region: String,
}

fn us() -> String {
    "us".into()
}

#[derive(Deserialize, Schema)]
struct NameArgs {
    /// Name
    name: Option<String>,
}

#[derive(Deserialize, Schema)]
struct ItemArgs {
    /// Item id
    id: Option<f64>,
}

#[derive(Deserialize, Schema, Serialize)]
struct ItemOptions {
    /// Limit
    #[serde(default = "ten")]
    limit: f64,
    /// Tags
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Vec<String>>,
    /// Verbose
    #[serde(skip_serializing_if = "Option::is_none")]
    verbose: Option<bool>,
}

fn ten() -> f64 {
    10.0
}

#[derive(Deserialize, Schema, Serialize)]
struct CreateOptions {
    /// Title
    #[incur(min = 1)]
    title: String,
    /// Draft
    #[serde(default)]
    draft: bool,
}

#[derive(Schema)]
#[expect(dead_code, reason = "Only the schema is used.")]
struct CreateOutput {
    title: String,
    draft: bool,
}

pub(crate) fn web() -> Cli {
    client(Cli::new("web"))
        .description("HTTP serving")
        .version("3.0.0")
        .update(false)
        .sync(false)
        .mcp(Mcp::new().stateless(false))
        .globals::<RegionGlobals>()
        .root(Command::new().run(|c: Context<NameArgs>| {
            data(json!({ "root": true, "name": c.args.name, "region": c.globals["region"] }))
        }))
        .command(
            "items",
            Command::new()
                .description("List items")
                .run(|c: Context<ItemArgs, ItemOptions>| {
                    let mut out = json!({ "id": c.args.id });
                    if let (Some(out), Value::Object(options)) =
                        (out.as_object_mut(), serde_json::to_value(&c.options)?)
                    {
                        out.extend(options);
                        out.insert("region".into(), c.globals["region"].clone());
                    }
                    data(out)
                }),
        )
        .command(
            "create",
            Command::new()
                .description("Create an item")
                .output::<CreateOutput>()
                .run(|c: Context<(), CreateOptions>| data(serde_json::to_value(&c.options)?)),
        )
        .command(
            "request",
            Command::new()
                .description("Inspect the HTTP request")
                .run(|c: Context| {
                    let request = c.request.as_deref();
                    data(json!({
                        "agent": request
                            .and_then(|r| r.headers.get("x-agent"))
                            .and_then(|v| v.to_str().ok()),
                        "method": request.map(|r| r.method.to_string()),
                        "url": request.map(|r| r.uri.to_string()),
                    }))
                }),
        )
        .command(
            "stream",
            Command::new()
                .description("Stream chunks")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok::<_, Error>(json!({ "n": 1 })),
                        Ok(json!({ "n": 2 })),
                    ]))
                    .cta(CtaBlock::new(["items"]))
                }),
        )
        .command(
            "stream-plain",
            Command::new()
                .description("Stream without suggestions")
                .run(|_: Context| incur::stream(stream::iter([Ok::<_, Error>(json!("only"))]))),
        )
        .command(
            "stream-fail",
            Command::new()
                .description("Stream then fail")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok(json!({ "n": 1 })),
                        Err(Error::new("BROKEN", "stream broke").cta(CtaBlock::new(["stream"]))),
                        Ok(json!({ "n": 2 })),
                    ]))
                }),
        )
        .command(
            "stream-throw",
            Command::new()
                .description("Stream then throw")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok(json!({ "n": 1 })),
                        Err(Error::from("stream threw")),
                    ]))
                }),
        )
        .command(
            "stream-return-error",
            Command::new()
                .description("Stream then return an error")
                .run(|_: Context| {
                    incur::stream(stream::iter([
                        Ok(json!({ "n": 1 })),
                        Err(Error::new("LATE", "failed at the end")),
                    ]))
                }),
        )
        .command(
            "fail",
            Command::new()
                .description("Fail with suggestions")
                .run(|_: Context| {
                    Err::<Value, _>(
                        Error::new("NOPE", "nope")
                            .retryable(false)
                            .cta(CtaBlock::new(["items"])),
                    )
                }),
        )
        .command(
            "throws",
            Command::new()
                .description("Throw an error")
                .run(|_: Context| Err::<Value, _>(Error::from("kaput"))),
        )
        .group(
            Cli::new("admin")
                .description("Admin commands")
                .middleware(|c, next| async move {
                    if c.globals["region"] != "eu" {
                        return Err(Error::new("REGION", "eu only"));
                    }
                    next.run(c).await
                })
                .command(
                    "stats",
                    Command::new()
                        .description("Show stats")
                        .run(|_: Context| data(json!({ "users": 3 }))),
                ),
        )
}

/// Returns the upstream API as a fetch source.
fn upstream_fetch() -> Fetch {
    Fetch::new(upstream)
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct GatewayEnv {
    /// Mode
    #[expect(dead_code, reason = "Middleware reads the raw environment.")]
    gateway_mode: Option<String>,
}

pub(crate) fn gateway() -> Cli {
    client(Cli::new("gateway"))
        .description("Fetch gateways")
        .update(false)
        .sync(false)
        .env::<GatewayEnv>()
        .middleware(|c, next| async move {
            match c.env["GATEWAY_MODE"].as_str() {
                Some("deny") => {
                    Err(Error::new("DENIED", "gateway denied").cta(CtaBlock::new(["status"])))
                }
                Some("throw") => Err(Error::from("middleware threw")),
                _ => next.run(c).await,
            }
        })
        .fetch_command(
            "api",
            FetchCommand::new(upstream_fetch()).description("Upstream API"),
        )
        .fetch_command("v1", FetchCommand::new(upstream_fetch()).base_path("/v1"))
        .fetch_command(
            "hosted",
            FetchCommand::new(
                Fetch::url("http://hosted.test/base/")
                    .header("authorization", "Bearer hosted")
                    .header("x-default", "yes"),
            )
            .description("Hosted API"),
        )
        .fetch_command(
            "offline",
            FetchCommand::new(Fetch::url("http://offline.test")).description("Unreachable API"),
        )
        .fetch_command(
            "secret",
            FetchCommand::new(upstream_fetch())
                .description("Agent-only API")
                .output_policy(OutputPolicy::AgentOnly),
        )
        .command(
            "status",
            Command::new()
                .description("Local command")
                .run(|_: Context| data(json!({ "ok": true }))),
        )
        .group(
            Cli::new("nested")
                .description("Nested gateways")
                .fetch_command(
                    "api",
                    FetchCommand::new(upstream_fetch()).description("Nested API"),
                ),
        )
}

pub(crate) fn proxy() -> Cli {
    client(Cli::new("proxy"))
        .description("Root fetch with commands")
        .update(false)
        .sync(false)
        .root_fetch(FetchCommand::new(upstream_fetch()))
        .command(
            "local",
            Command::new()
                .description("Local command")
                .run(|_: Context| data(json!({ "local": true }))),
        )
}

pub(crate) fn raw() -> Cli {
    client(Cli::new("raw"))
        .description("Root fetch only")
        .update(false)
        .sync(false)
        .root_fetch(FetchCommand::new(upstream_fetch()))
}

pub(crate) fn oa() -> Cli {
    client(Cli::new("oa"))
        .description("OpenAPI commands")
        .update(false)
        .sync(false)
        .config(Config::default())
        .fetch_command(
            "ops",
            FetchCommand::new(upstream_fetch())
                .description("Operation mode")
                .openapi(pet_spec()),
        )
        .fetch_command(
            "ns",
            FetchCommand::new(upstream_fetch())
                .description("Namespace mode")
                .base_path("/base")
                .openapi(pet_spec())
                .openapi_config(
                    Openapi::new()
                        .mode(Mode::Namespace)
                        .group("pets", "Pet operations")
                        .group("v2 users", "Users (v2)")
                        .group("missing", "Ignored")
                        .group("pets petId get", "Leaf")
                        .forward_headers(["x-forward", "x-api-key"]),
                ),
        )
        .fetch_command(
            "latest",
            FetchCommand::new(upstream_fetch())
                .description("Latest versions only")
                .openapi(pet_spec())
                .openapi_config(
                    Openapi::new()
                        .mode(Mode::Namespace)
                        .versions(Versions::Latest)
                        .security(false)
                        .include(|op| op.method != "delete" && !op.path.starts_with("/store")),
                ),
        )
        .fetch_command(
            "compact",
            FetchCommand::new(upstream_fetch())
                .description("Compact schemas")
                .openapi(pet_spec())
                .openapi_config(
                    Openapi::new()
                        .compact(true)
                        .include(|op| op.path == "/search"),
                )
                .mcp(false),
        )
        .fetch_command(
            "composed",
            FetchCommand::new(upstream_fetch())
                .description("Composed request bodies")
                .openapi(composed_spec()),
        )
        .fetch_command(
            "url",
            FetchCommand::new(upstream_fetch())
                .description("Spec from a URL")
                .openapi("http://hosted.test/openapi.json"),
        )
        .fetch_command(
            "rel",
            FetchCommand::new(Fetch::url("http://hosted.test/svc"))
                .description("Spec relative to a hosted source")
                .openapi("openapi.json")
                .output_policy(OutputPolicy::AgentOnly),
        )
}

pub(crate) fn oaroot() -> Cli {
    client(Cli::new("oaroot"))
        .description("Root OpenAPI commands")
        .version("0.1.0")
        .update(false)
        .sync(false)
        .root_fetch(
            FetchCommand::new(upstream_fetch())
                .openapi(mini_spec())
                .openapi_config(Openapi::new().mode(Mode::Namespace)),
        )
}

/// Returns a handler that sends requests to another CLI's HTTP handler.
fn route(
    cli: Cli,
) -> impl Fn(http::Request<Body>) -> BoxFuture<'static, Result<http::Response<Body>, Error>>
+ Send
+ Sync
+ 'static {
    move |request| {
        let cli = cli.clone();
        async move { Ok(cli.fetch(request).await) }.boxed()
    }
}

pub(crate) fn remote() -> Cli {
    client(Cli::new("remote"))
        .description("Remote MCP servers")
        .update(false)
        .sync(false)
        .mcp_source(
            "direct",
            McpSource::new("http://tools.test/mcp")
                .description("Direct discovery")
                .fetch(route(tools())),
        )
        .mcp_source(
            "catalog",
            McpSource::new("http://catalog.test/mcp")
                .description("Progressive discovery")
                .fetch(route(catalog())),
        )
        .mcp_source(
            "paged",
            McpSource::new("http://app.test/mcp")
                .description("Progressive discovery across pages")
                .fetch(route(super::cli("app"))),
        )
        .mcp_source(
            "session",
            McpSource::new("http://web.test/mcp")
                .description("Stateful server")
                .fetch(route(web())),
        )
        .mcp_source(
            "fake",
            McpSource::new("http://fake.test/mcp")
                .description("Canned server")
                .output_policy(OutputPolicy::AgentOnly)
                .header("x-custom", "yes")
                .fetch(fake_mcp),
        )
        .command(
            "local",
            Command::new()
                .description("Local command")
                .run(|_: Context| data(json!({ "local": true }))),
        )
}

#[derive(Clone, Copy, Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum Environment {
    Staging,
    Prod,
}

#[derive(Deserialize, Schema)]
struct KitDeployArgs {
    /// Target environment
    env: Environment,
}

/// The skill sync settings of the `kit` CLIs.
fn kit_sync() -> SkillSync {
    SkillSync::new()
        .include(["skills/*", "_root"])
        .body("Run `kit auth login` to finish setup.")
        .suggestions(["Show my status", "Deploy the app"])
}

/// Builds a CLI that syncs skills and registers MCP servers.
fn kit_cli(name: &str, package: Option<&str>, version: Option<&str>, mcp: Option<Mcp>) -> Cli {
    let mut cli = client(Cli::new(name))
        .description("Skill and MCP sync")
        .version(version.unwrap_or("1.4.0"))
        .update(false);
    if let Some(package) = package {
        cli = cli.package(package);
    }
    if let Some(mcp) = mcp {
        cli = cli.mcp(mcp);
    }
    cli.sync(kit_sync())
        .command(
            "status",
            Command::new()
                .description("Show status")
                .example("", Some("Show status"))
                .run(|_: Context| data(json!({ "ok": true }))),
        )
        .command(
            "deploy",
            Command::new()
                .description("Deploy the app")
                .destructive()
                .run(|c: Context<KitDeployArgs>| data(json!({ "deployed": c.args.env }))),
        )
        .group(
            Cli::new("auth")
                .description("Authentication")
                .command(
                    "login",
                    Command::new()
                        .description("Log in")
                        .run(|_: Context| data(json!({ "ok": true }))),
                )
                .command(
                    "logout",
                    Command::new()
                        .description("Log out")
                        .hint("Clears tokens.")
                        .run(|_: Context| data(json!({ "ok": true }))),
                ),
        )
}

pub(crate) fn kit() -> Cli {
    kit_cli("kit", None, None, None)
}

pub(crate) fn kitpkg() -> Cli {
    kit_cli(
        "kitpkg",
        Some("@acme/kit"),
        None,
        Some(Mcp::new().name("acme").agents(["amp"])),
    )
}

pub(crate) fn kitcmd() -> Cli {
    kit_cli(
        "kitcmd",
        None,
        None,
        Some(
            Mcp::new()
                .agents(["cursor", "amp"])
                .command("kit serve --stdio"),
        ),
    )
}

pub(crate) fn kitcwd() -> Cli {
    kit_cli("kitcwd", None, None, None).sync(kit_sync().cwd("vendor"))
}

pub(crate) fn kitrun() -> Cli {
    kit_cli("kitrun", None, None, None).sync(kit_sync().command("bunx @acme/kit"))
}

pub(crate) fn kitbad() -> Cli {
    kit_cli("kitbad", Some("Bad Name"), Some("1"), None)
}

pub(crate) fn kitver() -> Cli {
    kit_cli("kitver", Some("kitver"), Some("latest"), None)
}

pub(crate) fn spaced() -> Cli {
    kit_cli("kit tool", None, None, None)
}

/// Reports an update callback's context on stderr.
fn report(label: &str, context: &impl Serialize) {
    let _ = writeln!(
        std::io::stderr(),
        "{label} {}",
        serde_json::to_string(context).unwrap()
    );
}

/// Returns a command that reports `{ ok: true }`.
fn status(description: Option<&str>) -> Command {
    let command = Command::new().run(|_: Context| data(json!({ "ok": true })));
    match description {
        Some(description) => command.description(description),
        None => command,
    }
}

pub(crate) fn upd() -> Cli {
    client(Cli::new("upd"))
        .description("Custom updates")
        .version("1.0.0")
        .update(
            Update::new()
                .check(|c: CheckContext| {
                    report("check", &c);
                    Ok::<_, Error>((c.current == "1.0.0").then(|| "1.2.0".to_owned()))
                })
                .install(|c: InstallContext| {
                    report("install", &c);
                    Ok::<_, Error>(())
                }),
        )
        .command("status", status(Some("Show status")))
}

pub(crate) fn updbeta() -> Cli {
    client(Cli::new("updbeta"))
        .description("Prerelease updates")
        .version("1.0.0-beta.2")
        .sync(false)
        .update(
            Update::new()
                .check(|_: CheckContext| Ok::<_, Error>(Some("not-a-version".to_owned())))
                .deferred()
                .install(|_: InstallContext| Err::<(), _>(Error::from("installer failed"))),
        )
        .command("status", status(Some("Show status")))
}

pub(crate) fn updcheck() -> Cli {
    client(Cli::new("updcheck"))
        .version("1.0.0")
        .sync(false)
        .update(
            Update::new()
                .check(|_: CheckContext| Err::<Option<String>, _>(Error::from("check failed")))
                .deferred()
                .install(|_: InstallContext| Ok::<_, Error>(())),
        )
        .command("status", status(None))
}

pub(crate) fn updnone() -> Cli {
    client(Cli::new("updnone"))
        .version("1.0.0")
        .sync(false)
        .update(Update::new().check(|_: CheckContext| Ok::<_, Error>(Some("9.0.0".to_owned()))))
        .command("status", status(None))
}

pub(crate) fn updpkg() -> Cli {
    client(Cli::new("updpkg"))
        .description("Package updates")
        .sync(false)
        .command("status", status(None))
}

pub(crate) fn updbad() -> Cli {
    client(Cli::new("updbad"))
        .sync(false)
        .update(Update::new().package("Bad Name!"))
        .command("status", status(None))
}
