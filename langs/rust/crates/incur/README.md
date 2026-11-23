<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-light.svg">
  <img alt="incur" src="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-light.svg" width="100%" height="140px">
</picture>

<br/>

<p align="center">
  <a href="https://github.com/wevm/incur/blob/main/LICENSE">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/crates/l/incur?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/crates/l/incur?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="MIT License">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#install">Install</a> · <a href="#usage">Usage</a> · <a href="#walkthrough">Walkthrough</a> · <a href="#license">License</a>
</p>

[incur](https://github.com/wevm/incur) for Rust: the same CLIs for agents and humans, with output that matches the TypeScript package byte for byte.

## Features

- [**Agent discovery**](#agent-discovery): built-in Skills and MCP sync (`skills add`, `mcp add`) so agents find your CLI automatically
- [**Call-to-actions**](#call-to-actions): suggest next commands to agents and humans after a run
- **TOON output**: token-efficient default format, with JSON, YAML, Markdown, and JSONL alternatives
- [**`--llms` flag**](#agent-discovery): token-efficient command manifest in Markdown or JSON schema
- **Well-formed I/O**: `#[derive(Schema)]` schemas for arguments, options, environment variables, and output
- [**Global options**](#global-options): `--format`, `--full-output`, `--help`, `--json`, `--update`, `--version` on every CLI for free
- [**Async handlers**](#streaming): sync closures, `async` blocks, and streams, on any executor
- [**Mount APIs**](#mount-apis): HTTP handlers, OpenAPI specs, and MCP servers as commands
- [**Serve over HTTP**](#serve-over-http): commands and MCP as an `http::Request` → `http::Response` handler
- [**Middleware**](#middleware-and-variables): composable before/after hooks with typed variables

## Install

```sh
cargo add incur serde serde_json -F serde/derive
```

## Usage

### Single-command CLI

Pass a `root` command for CLIs that do one thing.

```rust,no_run
use incur::{Cli, Command, Context, Error, Schema};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize, Schema)]
struct Args {
    /// Name to greet
    name: String,
}

fn main() {
    Cli::new("greet")
        .description("A greeting CLI")
        .root(Command::new().run(|c: Context<Args>| {
            Ok::<_, Error>(json!({ "message": format!("hello {}", c.args.name) }))
        }))
        .serve();
}
```

```sh
$ greet world
# → message: hello world
```

### Multi-command CLI

Chain `.command()` calls to register subcommands.

```rust,no_run
use incur::{Cli, Command, Context, Schema};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize, Schema)]
struct InstallArgs {
    /// Package name
    package: Option<String>,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "camelCase")]
struct InstallOptions {
    /// Save as dev dependency
    #[incur(alias = 'D')]
    save_dev: Option<bool>,
}

fn main() {
    Cli::new("my-cli")
        .description("My CLI")
        .command(
            "status",
            Command::new()
                .description("Show repo status")
                .run(|_: Context| incur::ok(json!({ "clean": true }))),
        )
        .command(
            "install",
            Command::new()
                .description("Install a package")
                .run(|_: Context<InstallArgs, InstallOptions>| {
                    incur::ok(json!({ "added": 1, "packages": 451 }))
                }),
        )
        .serve();
}
```

```sh
$ my-cli status
# → clean: true

$ my-cli install express -D
# → added: 1
# → packages: 451
```

```sh
$ my-cli --help
# my-cli — My CLI
#
# Usage: my-cli <command>
#
# Commands:
#   install  Install a package
#   status   Show repo status
#
# Integrations:
#   completions  Generate shell completion script
#   mcp          Register as MCP server (add, doctor)
#   skills       Sync skill files to agents (add, list)
#
# Global Options:
#   --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
#   --format <toon|json|yaml|md|jsonl>  Output format
#   ...
```

### Sub-command CLI

Create a separate `Cli` and mount it with `.group()` to nest command groups.

```rust,no_run
use incur::{Cli, Command, Context, Schema};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Default, Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum State {
    #[default]
    Open,
    Closed,
    All,
}

#[derive(Deserialize, Schema)]
struct ListOptions {
    #[serde(default)]
    state: State,
}

fn main() {
    let pr = Cli::new("pr").description("Pull request commands").command(
        "list",
        Command::new()
            .description("List pull requests")
            .run(|c: Context<(), ListOptions>| incur::ok(json!({ "prs": [], "state": c.options.state }))),
    );

    Cli::new("my-cli").description("My CLI").group(pr).serve();
}
```

```sh
$ my-cli pr list --state closed
# → prs: []
# → state: closed
```

## Walkthrough

Each feature works as in TypeScript; the [root README](https://github.com/wevm/incur#walkthrough) covers them in depth.

### Agent discovery

```sh
# Auto-generate and install agent skill files (recommended – lighter on tokens)
my-cli skills add

# Register as MCP server for your agents
my-cli mcp add

# Output machine-readable manifest
my-cli --llms
```

`.sync(SkillSync::new())` tunes generated skills (depth, include globs, suggestions), `.mcp(Mcp::new())` the MCP server (discovery mode, filters, instructions), and `.package(..)` names the package that generated commands run. See [agent discovery](https://github.com/wevm/incur#agent-discovery).

### Call-to-actions

Attach suggested next commands to data, streams, or errors.

```rust
use incur::{Cta, CtaBlock};
use serde_json::json;

let outcome = incur::ok(json!({ "items": [{ "id": 1, "title": "Fix bug" }] })).cta(CtaBlock::new([
    Cta::new("get 1").description("View item"),
    Cta::new("list").arg("state", "closed").description("View closed"),
]));
```

```sh
$ my-cli list
# → items[1]{id,title}:
# →   1,Fix bug
#
# Suggested commands:
#   my-cli get 1        # View item
#   my-cli list closed  # View closed
```

### Streaming

Handlers may return a value, a `Result`, a future of either, or `incur::stream` of any `futures::Stream`. Chunks print as they arrive, as JSONL with `--format jsonl`, and as NDJSON over HTTP.

```rust
use futures::stream::{self, StreamExt};
use incur::{Command, Context, Error};

let logs = Command::new().run(|_: Context| {
    incur::stream(stream::iter(["connecting...", "streaming logs", "done"]).map(Ok::<_, Error>))
});
```

`Cli::serve` drives the CLI on a current-thread tokio runtime. Inside a runtime, await `Cli::serve_async`, or `Cli::run` with an injected `Io`.

### Middleware and variables

Middleware wraps every command; `c.set` provides typed variables that handlers read with `c.var`.

```rust
use incur::{Cli, Command, Context};

struct User(String);

let cli = Cli::new("my-cli")
    .middleware(|mut c, next| {
        c.set(User("alice".into()));
        next.run(c)
    })
    .command(
        "whoami",
        Command::new().run(|c: Context| incur::ok(c.var::<User>().map(|u| u.0.clone()))),
    );
```

An `async move` middleware can fail before the command runs or run code after `next.run(c).await`. See [middleware](https://github.com/wevm/incur#middleware).

### Global options

Every CLI gets `--filter-output`, `--format`, `--full-output`, `--help`, `--llms`, `--mcp`, `--json`, `--schema`, `--token-count`, `--token-limit`, `--token-offset`, `--update`, and `--version`. `.globals::<T>()` adds your own, read with `c.globals::<T>()`. See [global options](https://github.com/wevm/incur#global-options).

### Config file

Load option defaults from a JSON file, parsed as V8's `JSON.parse` parses it.

```rust
use incur::{Cli, Config};

let cli = Cli::new("my-cli").config(Config { flag: Some("config".into()), ..Config::default() });
```

See [config file](https://github.com/wevm/incur#config-file).

### Mount APIs

`fetch_command` mounts an HTTP API, translating curl-style flags (`my-cli api users -X POST -d '{"name":"Bob"}'`) into requests. A `Fetch` is an async handler from `http::Request` to `http::Response`, or a hosted URL.

```rust
use incur::{Body, Cli, Fetch, FetchCommand, McpSource};

let api = Fetch::new(|request: http::Request<Body>| async move {
    Ok(http::Response::new(Body::from(format!(r#"{{"path":"{}"}}"#, request.uri().path()))))
});

let cli = Cli::new("my-cli")
    .fetch_command("api", FetchCommand::new(api))
    // One command per OpenAPI operation.
    .fetch_command(
        "users",
        FetchCommand::new(Fetch::url("https://api.example.com")).openapi("openapi.json"),
    )
    // One command per remote MCP tool.
    .mcp_source("docs", McpSource::new("https://docs.example.com/mcp"));
```

Hosted URLs need an HTTP client: enable the `client` feature, or set one with `Cli::client`. See [mount APIs as CLIs](https://github.com/wevm/incur#mount-apis-as-clis).

### Serve over HTTP

`Cli::fetch` handles an `http::Request` and returns an `http::Response`, so it plugs into hyper or axum. Paths run commands (`GET /users/42?limit=5` → `my-cli users 42 --limit 5`), `/mcp` serves MCP over HTTP, and `/openapi.json` and `/.well-known/agent-skills/` describe the CLI.

```rust,no_run
use incur::{Body, Cli};

async fn handle(cli: &Cli, request: http::Request<Body>) -> http::Response<Body> {
    cli.fetch(request).await
}
```

See [serve CLIs as APIs](https://github.com/wevm/incur#serve-clis-as-apis).

### Update notices

Human TTY runs check for a newer version in the background and suggest `my-cli --update`, which updates the package with npm, pnpm, or Bun. `.update(Update::new().check(..).install(..))` customizes both, and `.update(false)` disables them. See [update notices](https://github.com/wevm/incur#update-notices).

### Filtering and token pagination

```sh
$ my-cli users --filter-output users.name
# → users[2]{name}:
# →   Alice
# →   Bob

$ my-cli users --token-limit 20 --token-offset 20
```

See [filtering output](https://github.com/wevm/incur#filtering-output) and [token pagination](https://github.com/wevm/incur#token-pagination).

## Differences from TypeScript

- Integers in data keep their exact 64-bit value in every format, where JavaScript rounds beyond 2^53.
- File-based commands (`.fs()`) and standalone binary builds are TypeScript-only; a Rust CLI is already a binary.

## License

[MIT](https://github.com/wevm/incur/blob/main/LICENSE)
