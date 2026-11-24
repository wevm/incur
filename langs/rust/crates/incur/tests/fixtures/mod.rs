//! Rust mirror of the reference CLIs in `langs/_differential/fixtures.ts`.

mod sandboxed;
mod services;

use std::path::Path;
use std::sync::Arc;

use futures::{StreamExt, stream};
use incur::help::Usage;
use incur::{
    BannerMode, Cli, Command, Config, Context, Cta, CtaBlock, Error, Format, OutputPolicy, Parser,
    Schema,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The acting user, set by middleware.
struct User(String);

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct AppEnv {
    /// Acting user
    #[expect(dead_code, reason = "Middleware reads the raw environment.")]
    app_user: Option<String>,
}

#[derive(Deserialize, Schema)]
struct InstallArgs {
    /// Package name
    package: Option<String>,
}

#[derive(Clone, Copy, Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum Tag {
    Latest,
    Next,
}

#[derive(Deserialize, Schema, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallOptions {
    /// Save as dev dependency
    #[incur(alias = 'D')]
    #[serde(skip_serializing_if = "Option::is_none")]
    save_dev: Option<bool>,
    /// Registry URL
    #[incur(alias = 'r')]
    #[serde(skip_serializing_if = "Option::is_none")]
    registry: Option<String>,
    /// Retry count
    #[incur(min = 0, max = 10)]
    #[serde(default = "three")]
    retries: f64,
    /// Dist tag
    #[serde(default = "latest")]
    tag: Tag,
}

fn three() -> f64 {
    3.0
}

fn latest() -> Tag {
    Tag::Latest
}

#[derive(Deserialize, Schema)]
struct GreetArgs {
    /// Name to greet
    name: String,
}

#[derive(Deserialize, Schema)]
struct GreetOptions {
    /// Shout
    #[serde(default)]
    loud: bool,
    /// Repeat count
    #[incur(min = 1, max = 5)]
    times: Option<i64>,
    /// Suffix
    #[incur(min = 1, max = 3)]
    suffix: Option<String>,
}

#[derive(Schema)]
#[expect(dead_code, reason = "Only the schema is used.")]
struct GreetOutput {
    /// The greeting
    message: String,
}

#[derive(Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum ItemState {
    Open,
    Closed,
}

#[derive(Deserialize, Schema)]
struct ListArgs {
    /// Item state
    #[serde(default = "open")]
    state: ItemState,
}

fn open() -> ItemState {
    ItemState::Open
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[expect(
    clippy::struct_field_names,
    reason = "The names are environment variables."
)]
struct DeployEnv {
    /// Deploy token
    #[expect(dead_code, reason = "Validated, not read.")]
    deploy_token: String,
    /// Region
    #[serde(default = "us")]
    deploy_region: String,
    /// Retries
    deploy_retries: Option<i64>,
    /// Dry run
    deploy_dry: Option<bool>,
}

fn us() -> String {
    "us".into()
}

#[derive(Deserialize, Schema)]
struct DeployOptions {
    /// Availability zone
    #[incur(alias = 'z', deprecated)]
    #[expect(dead_code, reason = "Deprecated and unused.")]
    zone: Option<String>,
    /// Target region
    region: Option<String>,
    /// Force deploy
    #[incur(alias = 'f')]
    #[expect(dead_code, reason = "Unused.")]
    force: Option<bool>,
}

#[derive(Deserialize, Schema)]
struct CountOptions {
    /// Verbosity
    #[incur(count, alias = 'v')]
    verbose: i64,
    /// Quiet
    #[incur(alias = 'q')]
    quiet: Option<bool>,
    /// Level
    level: Option<i64>,
}

#[derive(Deserialize, Schema)]
struct TagsArgs {
    /// Target
    target: String,
    /// Files
    #[incur(min = 1, max = 3)]
    files: Option<Vec<String>>,
}

#[derive(Deserialize, Schema)]
struct TagsOptions {
    /// Tags
    #[incur(alias = 't')]
    #[serde(default)]
    tag: Vec<String>,
}

#[derive(Deserialize, Schema)]
struct UsageArgs {
    /// File
    #[expect(dead_code, reason = "Unused.")]
    file: String,
}

#[derive(Deserialize, Schema)]
struct UsageOptions {
    /// Lines
    #[expect(dead_code, reason = "Unused.")]
    lines: Option<f64>,
}

#[derive(Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum PrState {
    Open,
    Closed,
    All,
}

#[derive(Schema)]
#[expect(dead_code, reason = "Only the schema is used.")]
struct UserRow {
    /// Name
    name: String,
    /// Email
    email: String,
    /// Role
    role: String,
}

#[derive(Schema)]
#[expect(dead_code, reason = "Only the schema is used.")]
struct PageInfo {
    /// Total
    total: f64,
}

#[derive(Schema)]
#[expect(dead_code, reason = "Only the schema is used.")]
struct UsersOutput {
    /// Users
    users: Vec<UserRow>,
    /// Paging
    page: Option<PageInfo>,
}

#[derive(Schema)]
struct Empty {}

#[derive(Deserialize, Schema)]
#[expect(dead_code, reason = "Parsing fails before the handler runs.")]
struct VariadicArgs {
    /// Files
    files: Vec<String>,
    /// Last
    last: String,
}

#[derive(Deserialize, Schema)]
struct DataArgs {
    /// JSON value
    json: String,
}

#[derive(Deserialize, Schema)]
struct DbArgs {
    /// Table
    table: Option<String>,
}

/// Returns a JSON value, as handlers in this fixture do.
#[expect(clippy::unnecessary_wraps, reason = "Handlers return results.")]
fn data(value: Value) -> Result<Value, Error> {
    Ok(value)
}

/// Returns the users list.
fn users() -> Value {
    json!([
        { "name": "Alice", "email": "alice@example.com", "role": "admin" },
        { "name": "Bob", "email": "bob@example.com", "role": "user" },
        { "name": "Carol", "email": "carol@example.com", "role": "user" },
    ])
}

/// Returns the mixed data.
fn mixed() -> Value {
    json!({
        "context": { "task": "Our favorite hikes together", "location": "Boulder", "season": "spring_2025" },
        "friends": ["ana", "luis", "sam"],
        "hikes": [
            { "id": 1, "name": "Blue Lake Trail", "distanceKm": 7.5, "wasSunny": true },
            { "id": 2, "name": "Ridge Overlook", "distanceKm": 9.2, "wasSunny": false },
        ],
        "matrix": [[1, 2], [3, 4]],
        "nested": [{ "a": { "b": 1 } }, "x", [1, { "y": 2 }]],
        "empty": {},
        "none": [],
        "quoted": ["true", "42", "-dash", "a:b", " pad", "", "comma,here", "null", "05", "1e3"],
        "text": "line one\nline two",
        "long": "This is a fairly long sentence that should exceed the default YAML line width of eighty characters easily.",
        "unicode": "héllo wörld 日本語",
        "special": { "key with space": 1, "1abc": 2, "dotted.key": 3, "": 4 },
        "numbers": [0, -1, 1.5, 1e21, 0.000_001, 123_456_789_012_i64],
        "nil": null,
    })
}

/// Pull request commands
#[derive(Parser)]
#[incur(name = "pr", middleware = pr_user)]
enum Pr {
    /// List pull requests
    List {
        /// State
        #[incur(default = PrState::Open)]
        state: PrState,
    },
    /// View a pull request
    View {
        /// PR number
        #[incur(arg, coerce = false)]
        number: f64,
    },
}

/// Prefixes the acting user for pull request commands.
fn pr_user(
    mut c: incur::MiddlewareContext,
    next: incur::Next,
) -> impl Future<Output = Result<(), Error>> + Send + 'static {
    let user = c.var::<User>().map_or("", |u| u.0.as_str()).to_owned();
    c.set(User(format!("pr:{user}")));
    next.run(c)
}

#[derive(Serialize)]
struct PrList {
    prs: Vec<Value>,
    state: PrState,
    user: Option<String>,
}

fn app() -> Cli {
    let pr = Pr::cli().handle(|command, c| match command {
        Pr::List { state } => incur::ok(PrList {
            prs: Vec::new(),
            state,
            user: c.var::<User>().map(|u| u.0.clone()),
        }),
        Pr::View { number } => incur::ok(json!({ "number": number })),
    });
    let db = Cli::new("db")
        .description("Database commands")
        .output_policy(OutputPolicy::AgentOnly)
        .root(Command::new().run(|c: Context<DbArgs>| {
            let tables = match c.args.table {
                Some(table) => vec![table],
                None => vec!["users".into(), "posts".into()],
            };
            data(json!({ "tables": tables }))
        }))
        .command(
            "migrate",
            Command::new()
                .description("Run migrations")
                .run(|_: Context| data(json!({ "migrated": true }))),
        );

    Cli::new("app")
        .update(false)
        .description("A differential test CLI")
        .version("1.2.3")
        .env::<AppEnv>()
        .var(User("anonymous".into()))
        .middleware(|mut c, next| {
            // An empty value is falsy in JavaScript, so it leaves the default user.
            if let Some(user) = c
                .env
                .get("APP_USER")
                .and_then(Value::as_str)
                .filter(|user| !user.is_empty())
            {
                c.set(User(user.to_owned()));
            }
            next.run(c)
        })
        .command(
            "status",
            Command::new()
                .description("Show repo status")
                .example("", Some("Show status"))
                .run(|_: Context| async { data(json!({ "clean": true, "branch": "main" })) }),
        )
        .command(
            "install",
            Command::new().description("Install a package").run(
                |c: Context<InstallArgs, InstallOptions>| {
                    let mut out = json!({ "added": 1, "package": c.args.package });
                    if let (Some(out), Value::Object(options)) =
                        (out.as_object_mut(), serde_json::to_value(&c.options)?)
                    {
                        out.extend(options);
                    }
                    data(out)
                },
            ),
        )
        .command(
            "greet",
            Command::new()
                .description("Greet someone")
                .output::<GreetOutput>()
                .example("world", Some("Greet the world"))
                .example("bob --loud true", None)
                .hint("Names are case-sensitive.")
                .run(|c: Context<GreetArgs, GreetOptions>| {
                    let mut message = format!(
                        "hello {}{}",
                        c.args.name,
                        c.options.suffix.unwrap_or_default()
                    );
                    if c.options.loud {
                        message = message.to_uppercase();
                    }
                    let times = usize::try_from(c.options.times.unwrap_or(1)).unwrap_or(1);
                    data(json!({ "message": vec![message; times].join(" ") }))
                }),
        )
        .command(
            "users",
            Command::new()
                .description("List users")
                .output::<UsersOutput>()
                .run(|_: Context| data(json!({ "users": users() }))),
        )
        .command(
            "list",
            Command::new()
                .description("List items")
                .run(|c: Context<ListArgs>| {
                    incur::ok(json!({ "items": [{ "id": 1, "title": "Fix bug" }], "state": c.args.state }))
                        .cta(CtaBlock::new([
                            Cta::new("get 1").description("View item"),
                            Cta::new("list").arg("state", "closed").description("View closed"),
                            Cta::new("search").option("query", true),
                            Cta::from("status"),
                            Cta::new("app whoami").description("Who am I"),
                            Cta::new("tags").arg("target", true).option("tag", "x"),
                        ])
                        .description("Next steps:"))
                }),
        )
        .command(
            "fail",
            Command::new().description("Fail with a code").run(|_: Context| {
                Err::<Value, _>(
                    Error::new("NOT_AUTHENTICATED", "GitHub token not found")
                        .hint("Tokens expire after 30 days.")
                        .retryable(true)
                        .exit_code(3)
                        .cta(CtaBlock::new([
                            Cta::new("auth login").description("Log in to GitHub"),
                            Cta::from("status"),
                        ])),
                )
            }),
        )
        .command(
            "throw",
            Command::new()
                .description("Throw an error")
                .run(|_: Context| Err::<Value, _>(Error::from("boom"))),
        )
        .command(
            "throw-incur",
            Command::new().description("Throw an incur error").run(|_: Context| {
                Err::<Value, _>(Error::new("RATE_LIMITED", "Slow down").retryable(true))
            }),
        )
        .command(
            "deploy",
            Command::new()
                .description("Deploy the app")
                .aliases(["ship"])
                .destructive()
                .hint("Requires a deploy token.")
                .run(|c: Context<(), DeployOptions, DeployEnv>| {
                    data(json!({
                        "deployed": true,
                        "region": c.options.region.unwrap_or(c.env.deploy_region),
                        "retries": c.env.deploy_retries,
                        "dry": c.env.deploy_dry,
                    }))
                }),
        )
        .command(
            "logs",
            Command::new().description("Tail logs").run(|_: Context| {
                // Chunks may arrive after awaiting.
                let connecting = stream::once(async { Ok(json!("connecting...")) });
                let progress = stream::iter([50, 100]).then(|n| async move {
                    Ok(json!({ "progress": n }))
                });
                incur::stream(connecting.chain(progress)).cta(CtaBlock::new(["status"]))
            }),
        )
        .command(
            "stream-fail",
            Command::new().description("Stream then fail").run(|_: Context| {
                incur::stream(stream::iter([
                    Ok(json!({ "step": 1 })),
                    Err(Error::new("STREAM_BROKE", "stream broke").cta(CtaBlock::new(["status"]))),
                ]))
            }),
        )
        .command(
            "nuke",
            Command::new()
                .description("Delete everything")
                .destructive()
                .hint("Confirm with the user before executing this destructive command.")
                .run(|_: Context| data(json!({ "nuked": true }))),
        )
        .command(
            "scalar",
            Command::new()
                .description("Return a string")
                .output::<String>()
                .run(|_: Context| data(json!("hello world"))),
        )
        .command(
            "number",
            Command::new()
                .description("Return a number")
                .run(|_: Context| data(json!(42))),
        )
        .command(
            "nothing",
            Command::new()
                .description("Return nothing")
                .output::<Empty>()
                .run(|_: Context| Ok::<_, Error>(())),
        )
        .command(
            "json-string",
            Command::new()
                .description("Return JSON text")
                .run(|_: Context| data(json!("{\"b\":1,\"a\":[1,2]}"))),
        )
        .command(
            "array",
            Command::new()
                .description("Return an array")
                .run(|_: Context| data(json!([1, 2, 3]))),
        )
        .command(
            "objects",
            Command::new()
                .description("Return objects")
                .output::<Value>()
                .run(|_: Context| data(users())),
        )
        .command(
            "mixed",
            Command::new()
                .description("Return mixed data")
                .run(|_: Context| data(mixed())),
        )
        .command(
            "data",
            Command::new()
                .description("Return parsed JSON")
                .run(|c: Context<DataArgs>| data(incur::json::parse(&c.args.json)?)),
        )
        .command(
            "secret",
            Command::new()
                .description("Agent-only output")
                .output_policy(OutputPolicy::AgentOnly)
                .run(|_: Context| data(json!({ "token": "abc" }))),
        )
        .command(
            "count",
            Command::new()
                .description("Count flags")
                .run(|c: Context<(), CountOptions>| {
                    data(json!({
                        "verbose": c.options.verbose,
                        "quiet": c.options.quiet.unwrap_or(false),
                        "level": c.options.level,
                    }))
                }),
        )
        .command(
            "tags",
            Command::new()
                .description("Collect values")
                .run(|c: Context<TagsArgs, TagsOptions>| {
                    data(json!({
                        "target": c.args.target,
                        "files": c.args.files.unwrap_or_default(),
                        "tag": c.options.tag,
                    }))
                }),
        )
        .command(
            "variadic",
            Command::new()
                .description("Variadic arg first")
                .run(|_: Context<VariadicArgs>| data(json!({ "ok": true }))),
        )
        .command(
            "whoami",
            Command::new()
                .description("Show the acting user")
                .run(|c: Context| async move {
                    data(json!({ "user": c.var::<User>().map(|u| u.0.clone()) }))
                }),
        )
        .command(
            "admin",
            Command::new()
                .description("Admin only")
                .destructive()
                .middleware(|c, next| async move {
                    if c.var::<User>().map(|u| u.0.as_str()) != Some("root") {
                        return Err(Error::new("FORBIDDEN", "admin only"));
                    }
                    next.run(c).await
                })
                .run(|_: Context| data(json!({ "admin": true }))),
        )
        .command(
            "fmt",
            Command::new()
                .description("Defaults to JSON")
                .format(Format::Json)
                .run(|_: Context| data(json!({ "a": 1 }))),
        )
        .command(
            "usage",
            Command::new()
                .description("Custom usage")
                .usage(Usage {
                    args: vec!["file".into()],
                    ..Usage::default()
                })
                .usage(Usage {
                    options: vec!["lines".into()],
                    prefix: Some("cat x |".into()),
                    suffix: Some("| head".into()),
                    ..Usage::default()
                })
                .run(|_: Context<UsageArgs, UsageOptions>| data(json!({ "ok": true }))),
        )
        .group(pr)
        .group(db)
        .group(
            Cli::new("hi")
                .description("Leaf CLI")
                .aliases(["hey"])
                .root(Command::new().run(|_: Context| data(json!({ "hi": true })))),
        )
}

/// A greeting CLI
#[derive(Parser)]
#[incur(name = "greet")]
pub(crate) struct Greet {
    /// Name to greet
    #[incur(arg)]
    pub(crate) name: String,
    /// Shout
    pub(crate) loud: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct Greeting {
    pub(crate) message: String,
}

fn greet() -> Cli {
    Greet::cli()
        .update(false)
        .banner(BannerMode::Agent, || Some("Greet banner".into()))
        .handle(|Greet { name, loud }, _| Greeting {
            message: if loud == Some(true) {
                format!("HELLO {name}")
            } else {
                format!("hello {name}")
            },
        })
}

#[derive(Deserialize, Schema)]
struct Globals {
    /// Verbose output
    #[incur(alias = 'V')]
    verbose: Option<bool>,
    /// Profile name
    #[incur(alias = 'P')]
    #[serde(default = "dev")]
    profile: String,
    /// Debug level
    #[incur(count, alias = 'D')]
    debug: f64,
}

fn dev() -> String {
    "dev".into()
}

#[derive(Deserialize, Schema)]
struct ShowOptions {
    /// Name
    #[incur(alias = 'n')]
    #[serde(default)]
    name: Option<String>,
    /// All
    #[incur(alias = 'a')]
    #[expect(dead_code, reason = "Unused.")]
    all: Option<bool>,
}

#[derive(Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum Color {
    Red,
    Green,
}

#[derive(Deserialize, Schema)]
struct PickOptions {
    /// Color
    color: Option<Color>,
    /// Mode
    #[expect(dead_code, reason = "Unused.")]
    mode: Option<Mode>,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Fast,
}

fn globals() -> Cli {
    Cli::new("glob")
        .update(false)
        .description("Global options")
        .banner(BannerMode::Human, || Some("Glob banner".into()))
        .config(Config {
            flag: Some("config".into()),
            files: Vec::new(),
            loader: Some(Arc::new(|file| {
                let name = file.and_then(Path::to_str).unwrap_or_default();
                if name.ends_with("none.json") {
                    return Ok(None);
                }
                if name.ends_with("array.json") {
                    return Ok(Some(json!([1])));
                }
                if name.ends_with("throw.json") {
                    return Err(Error::from("loader failed"));
                }
                Ok(Some(
                    json!({ "commands": { "show": { "options": { "name": "loaded" } } } }),
                ))
            })),
        })
        .globals::<Globals>()
        .command(
            "show",
            Command::new()
                .description("Show globals")
                .run(|c: Context<(), ShowOptions>| {
                    let parsed: Globals = c.globals()?;
                    let _ = (parsed.verbose, parsed.profile, parsed.debug);
                    data(json!({ "globals": c.globals, "name": c.options.name }))
                }),
        )
        .command(
            "pick",
            Command::new()
                .description("Pick a color")
                .run(|c: Context<(), PickOptions>| data(json!({ "color": c.options.color }))),
        )
}

#[derive(Deserialize, Schema)]
struct EchoArgs {
    /// Text
    text: String,
}

#[derive(Deserialize, Schema)]
struct EchoOptions {
    /// Uppercase
    upper: Option<bool>,
    /// Prefix
    #[serde(default = "gt")]
    prefix: String,
    /// Tags
    #[expect(dead_code, reason = "Validated, not read.")]
    tags: Option<Vec<String>>,
    /// Meta
    #[expect(dead_code, reason = "Validated, not read.")]
    meta: Option<Meta>,
    /// Extra
    #[expect(dead_code, reason = "Validated, not read.")]
    extra: Option<Value>,
}

#[derive(Deserialize, Schema)]
struct Meta {
    /// A
    #[expect(dead_code, reason = "Validated, not read.")]
    a: String,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
struct CfgEnv {
    /// Limit
    #[expect(dead_code, reason = "Validated, not read.")]
    cfg_limit: Option<f64>,
}

#[derive(Deserialize, Schema)]
struct CfgGlobals {
    /// Trace
    #[expect(dead_code, reason = "Validated, not read.")]
    trace: Option<bool>,
}

fn gt() -> String {
    ">".into()
}

#[derive(Deserialize, Schema)]
struct LimitOptions {
    /// Limit
    #[serde(default = "ten")]
    limit: f64,
}

fn ten() -> f64 {
    10.0
}

fn cfg() -> Cli {
    Cli::new("cfg")
        .update(false)
        .description("Config defaults")
        .config(Config {
            flag: Some("config".into()),
            files: vec!["config/cfg.json".into()],
            loader: None,
        })
        .env::<CfgEnv>()
        .globals::<CfgGlobals>()
        .command(
            "echo",
            Command::new()
                .description("Echo text")
                .run(|c: Context<EchoArgs, EchoOptions>| {
                    let text = if c.options.upper == Some(true) {
                        c.args.text.to_uppercase()
                    } else {
                        c.args.text
                    };
                    data(json!({ "out": format!("{} {text}", c.options.prefix) }))
                }),
        )
        .command(
            "ping",
            Command::new()
                .description("Ping")
                .run(|_: Context| data(json!("pong"))),
        )
        .group(
            Cli::new("project").description("Projects").command(
                "list",
                Command::new()
                    .description("List projects")
                    .run(|c: Context<(), LimitOptions>| data(json!({ "limit": c.options.limit }))),
            ),
        )
}

/// No skills, JSON by default
#[derive(Parser)]
#[incur(name = "plain", aliases = ["pl", "plain-cli"])]
enum Plain {
    /// Say hello
    Hello,
    Ping,
    /// Say hello loudly
    #[incur(name = "Hello")]
    HelloLoud,
    /// Version two
    V2,
    /// Katakana ping
    #[incur(name = "ピン")]
    Pin,
}

fn plain() -> Cli {
    Plain::cli()
        .update(false)
        .sync(false)
        .format(Format::Json)
        .config(Config::default())
        .banner(BannerMode::All, || Some("Welcome to plain".into()))
        .handle(|command, _| match command {
            Plain::Hello => incur::ok(json!({ "hello": "world" })),
            Plain::Ping => incur::ok("pong"),
            Plain::HelloLoud => incur::ok(json!({ "hello": "WORLD" })),
            Plain::V2 => incur::ok(json!({ "v": 2 })),
            Plain::Pin => incur::ok("ポン"),
        })
}

#[derive(Deserialize, Schema)]
struct RootedArgs {
    /// Query
    query: Option<String>,
}

fn rooted() -> Cli {
    Cli::new("rooted")
        .update(false)
        .description("Root with subcommands")
        .config(Config {
            files: vec!["config/cfg.json".into()],
            ..Config::default()
        })
        .root(Command::new().run(|c: Context<RootedArgs>| data(json!({ "query": c.args.query }))))
        .command(
            "sub",
            Command::new()
                .description("A subcommand")
                .run(|_: Context| data(json!({ "sub": true }))),
        )
        .group(
            Cli::new("nest").description("Nested commands").command(
                "leaf",
                Command::new()
                    .description("A nested leaf")
                    .run(|_: Context| data(json!({ "leaf": true }))),
            ),
        )
}

#[derive(Deserialize, Schema)]
struct ShadowSkillArgs {
    /// Skill id
    id: String,
}

fn shadow() -> Cli {
    Cli::new("shadow")
        .update(false)
        .description("Commands named like built-ins")
        .group(
            Cli::new("mcp").description("Manage servers").command(
                "add",
                Command::new()
                    .description("Add a server")
                    .run(|_: Context| data(json!({ "added": true }))),
            ),
        )
        .command(
            "skill",
            Command::new()
                .description("Show a skill")
                .run(|c: Context<ShadowSkillArgs>| data(json!({ "id": c.args.id }))),
        )
        .command(
            "shell",
            Command::new()
                .description("Show the shell")
                .aliases(["completions"])
                .run(|_: Context| data(json!({ "shell": true }))),
        )
}

fn shadowall() -> Cli {
    Cli::new("shadowall")
        .update(false)
        .sync(false)
        .description("Every built-in shadowed")
        .root(Command::new().run(|_: Context| data(json!({ "root": true }))))
        .command(
            "mcp",
            Command::new()
                .description("User mcp")
                .run(|_: Context| data(json!({ "mcp": true }))),
        )
        .command(
            "completions",
            Command::new()
                .description("User completions")
                .run(|_: Context| data(json!({ "completions": true }))),
        )
}

/// Returns the fixture CLI with the given key from `cases.json`.
pub(crate) fn cli(name: &str) -> Cli {
    match name {
        "app" => app(),
        "cfg" => cfg(),
        "globals" => globals(),
        "greet" => greet(),
        "plain" => plain(),
        "rooted" => rooted(),
        "shadow" => shadow(),
        "shadowall" => shadowall(),
        "bare" => sandboxed::bare(),
        "catalog" => sandboxed::catalog(),
        "dupe" => sandboxed::dupe(),
        "gateway" => sandboxed::gateway(),
        "kit" => sandboxed::kit(),
        "kitbad" => sandboxed::kitbad(),
        "kitcmd" => sandboxed::kitcmd(),
        "kitcwd" => sandboxed::kitcwd(),
        "kitpkg" => sandboxed::kitpkg(),
        "kitrun" => sandboxed::kitrun(),
        "kitver" => sandboxed::kitver(),
        "oa" => sandboxed::oa(),
        "oaroot" => sandboxed::oaroot(),
        "proxy" => sandboxed::proxy(),
        "raw" => sandboxed::raw(),
        "remote" => sandboxed::remote(),
        "spaced" => sandboxed::spaced(),
        "tools" => sandboxed::tools(),
        "upd" => sandboxed::upd(),
        "updbad" => sandboxed::updbad(),
        "updbeta" => sandboxed::updbeta(),
        "updcheck" => sandboxed::updcheck(),
        "updnone" => sandboxed::updnone(),
        "updpkg" => sandboxed::updpkg(),
        "web" => sandboxed::web(),
        other => panic!("unknown fixture CLI: {other}"),
    }
}
