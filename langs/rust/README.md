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

- [**Derive**](#usage): declare a CLI as a struct or enum, then `parse()` it like clap, or `serve()` typed outputs
- [**Agent discovery**](#agent-discovery): built-in Skills and MCP sync (`skills add`, `mcp add`) so agents find your CLI automatically
- [**Call-to-actions**](#call-to-actions): suggest next commands to agents and humans after a run
- **TOON output**: token-efficient default format, with JSON, YAML, Markdown, and JSONL alternatives
- [**`--llms` flag**](#agent-discovery): token-efficient command manifest in Markdown or JSON schema
- **Well-formed I/O**: schemas for arguments, options, environment variables, and `Serialize` outputs
- [**Global options**](#global-options): `--format`, `--full-output`, `--help`, `--json`, `--update`, `--version` on every CLI for free
- [**Async when you need it**](#streaming): sync closures, `async` blocks, and streams; tokio is an optional default feature
- [**Mount APIs**](#mount-apis): HTTP handlers, OpenAPI specs, and MCP servers as commands
- [**Serve over HTTP**](#serve-over-http): commands and MCP as an `http::Request` → `http::Response` handler
- [**Middleware**](#middleware-and-variables): composable before/after hooks with typed variables

## Install

```sh
cargo add incur serde -F serde/derive
```

## Usage

### Single-command CLI

Derive `Parser` on a struct. Fields are options, `#[incur(arg)]` fields positional arguments, and doc comments descriptions. `parse()` handles help, `--version`, `--llms`, completions, `skills add`, and validation errors itself, and returns the typed command.

```rust,no_run
use incur::Parser;

/// A greeting CLI
#[derive(Parser)]
#[incur(name = "greet")]
struct Greet {
    /// Name to greet
    #[incur(arg)]
    name: String,
}

fn main() {
    let greet = Greet::parse();
    println!("hello {}", greet.name);
}
```

```sh
$ greet world
# → hello world
```

To let incur write the output, in TOON, JSON, YAML, Markdown, or JSONL, and serve the same command to agents over MCP and HTTP, `serve` a handler that returns any `Serialize` type instead:

```rust,no_run
# use incur::Parser;
# /// A greeting CLI
# #[derive(Parser)]
# #[incur(name = "greet")]
# struct Greet {
#     /// Name to greet
#     #[incur(arg)]
#     name: String,
# }
#[derive(serde::Serialize)]
struct Greeting {
    message: String,
}

fn main() {
    Greet::serve(|greet, _| Greeting { message: format!("hello {}", greet.name) });
}
```

```sh
$ greet world
# → message: hello world

$ greet world --json
# → {
# →   "message": "hello world"
# → }
```

### Multi-command CLI

Derive `Parser` on an enum: each variant is a command, named in kebab-case, with its fields inline. Matching is exhaustive.

```rust,no_run
use incur::Parser;
use serde::Serialize;

/// My CLI
#[derive(Parser)]
#[incur(name = "my-cli", version)]
enum MyCli {
    /// Show repo status
    Status,
    /// Install a package
    Install {
        /// Package name
        #[incur(arg)]
        package: Option<String>,
        /// Save as dev dependency
        #[incur(alias = 'D')]
        save_dev: bool,
    },
}

#[derive(Serialize)]
struct Status {
    clean: bool,
}

#[derive(Serialize)]
struct Installed {
    added: u32,
    packages: u32,
}

fn main() {
    // Variants return different types, so each becomes an `Outcome` with `incur::ok`.
    MyCli::serve(|command, _| match command {
        MyCli::Status => incur::ok(Status { clean: true }),
        MyCli::Install { .. } => incur::ok(Installed { added: 1, packages: 451 }),
    });
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
# my-cli@0.1.0 — My CLI
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
```

### Sub-command CLI

A tuple variant holding another `Parser` enum nests a command group.

```rust,no_run
use incur::{Parser, Schema};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Schema, Serialize)]
#[serde(rename_all = "lowercase")]
enum State {
    Open,
    Closed,
    All,
}

/// Pull request commands
#[derive(Parser)]
enum Pr {
    /// List pull requests
    List {
        #[incur(default = State::Open)]
        state: State,
    },
}

/// My CLI
#[derive(Parser)]
#[incur(name = "my-cli")]
enum MyCli {
    Pr(Pr),
}

#[derive(Serialize)]
struct Prs {
    prs: Vec<String>,
    state: State,
}

fn main() {
    MyCli::serve(|MyCli::Pr(Pr::List { state }), _| Prs { prs: Vec::new(), state });
}
```

```sh
$ my-cli pr list --state closed
# → prs: []
# → state: closed
```

### Parse or serve

Both entries share one definition. `parse()` returns the command to your code, which writes the output; it hides `--mcp` and `mcp add`, which need something to call. `serve(handler)` writes what the handler returns and also serves `--mcp`, while `T::cli().handle(handler)` returns the `Cli` for HTTP. Customize either through the builder: `MyCli::cli().middleware(..).parse()` or `.handle(..).serve()`. The builder (`Cli::new`, `Command::new().run(..)`) also declares CLIs on its own, for commands known only at run time.

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

Handlers return data, an `incur::Result`, an `async` block of either, or `incur::stream` of any `futures::Stream`. Chunks print as they arrive, as JSONL with `--format jsonl`, and as NDJSON over HTTP.

```rust
use futures::stream::{self, StreamExt};
use incur::Parser;

/// Tail logs
#[derive(Parser)]
struct Logs;

let cli = Logs::cli().handle(|Logs, _| {
    incur::stream(stream::iter(["connecting...", "streaming logs", "done"]).map(Ok))
});
```

With the default `tokio` feature, `serve` and `parse` run on a current-thread tokio runtime, so handlers can await tokio timers and IO; inside a runtime, await `serve_async`, or `Cli::run` with an injected `Io`. Without it (`default-features = false`), a minimal executor runs synchronous handlers and runtime-agnostic futures with no runtime at all.

### Middleware and variables

Middleware wraps every command; `c.set` provides typed variables that handlers read with `c.var`.

```rust
use incur::Parser;

/// Who am I
#[derive(Parser)]
struct Whoami;

struct User(String);

let cli = Whoami::cli()
    .middleware(|mut c, next| {
        c.set(User("alice".into()));
        next.run(c)
    })
    .handle(|Whoami, c| c.var::<User>().map(|u| u.0.clone()));
```

An `async move` middleware can fail before the command runs or run code after `next.run(c).await`. `#[incur(middleware = audit)]` attaches a middleware function to one command, or to every command of an enum; `#[incur(example = "...")]` and `#[incur(usage(...))]` document a command. See [middleware](https://github.com/wevm/incur#middleware).

### Global options

Every CLI gets `--filter-output`, `--format`, `--full-output`, `--help`, `--llms`, `--mcp`, `--json`, `--schema`, `--token-count`, `--token-limit`, `--token-offset`, `--update`, and `--version`. `.globals::<T>()` adds your own, read with `c.globals::<T>()`; `#[incur(env)]` fields read environment variables. See [global options](https://github.com/wevm/incur#global-options).

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
