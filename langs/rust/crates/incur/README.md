# incur

Build CLIs for agents and humans. This crate is the Rust port of the
[`incur`](https://github.com/wevm/incur) TypeScript package. Its output matches the TypeScript
package byte for byte: a differential suite replays the same invocations against both.

A CLI gets TOON, JSON, YAML, Markdown, and JSONL output, `--llms` manifests, `--schema`,
`--filter-output`, token pagination, call-to-action suggestions, middleware, config-file
defaults, and shell completions.

```rust,no_run
use std::time::Duration;

use futures::stream::{self, StreamExt};
use incur::{Cli, Command, Context, Error, Schema};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize, Schema)]
struct Args {
    /// Package name
    package: String,
}

#[derive(Deserialize, Schema)]
#[serde(rename_all = "camelCase")]
struct Options {
    /// Save as a dev dependency
    #[incur(alias = 'D')]
    save_dev: Option<bool>,
    /// Retry count
    #[incur(min = 0, max = 10)]
    #[serde(default = "three")]
    retries: u8,
}

fn three() -> u8 {
    3
}

/// The acting user, set by middleware.
struct User(String);

fn main() {
    Cli::new("pm")
        .description("A package manager")
        .version("1.0.0")
        .middleware(|mut c, next| {
            c.set(User("alice".into()));
            next.run(c)
        })
        .command(
            "install",
            Command::new()
                .description("Install a package")
                .run(|c: Context<Args, Options>| async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    Ok::<_, Error>(json!({
                        "package": c.args.package,
                        "retries": c.options.retries,
                        "user": c.var::<User>().map(|u| u.0.clone()),
                    }))
                }),
        )
        .command(
            "outdated",
            Command::new()
                .description("List outdated packages")
                // Plain closures work too.
                .run(|_: Context| incur::ok(json!({ "outdated": 0 }))),
        )
        .command(
            "logs",
            Command::new().description("Tail logs").run(|_: Context| {
                incur::stream(stream::iter(1..=3).then(|n| async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    Ok::<_, Error>(json!({ "line": n }))
                }))
            }),
        )
        .serve();
}
```

## Schemas

`#[derive(Schema)]` describes a struct or unit enum from the attributes that already shape its
input:

- `serde`: `rename`, `rename_all` (every rule), `default`, `default = "path"`, `skip`, and
  `skip_deserializing`. `flatten` is rejected.
- `incur`: `alias = 'x'`, `count`, `deprecated`, `description = "..."`, `min`, and `max`.
- Doc comments become descriptions. `Option<T>` fields are optional; fields with defaults are not.

## Handlers, middleware, and streams

- A handler returns anything that converts to an [`Outcome`]: a `Result` of serializable data,
  [`ok`], or [`stream`]. It may instead return a future that resolves to one, such as an
  `async move` block. Futures must be `Send`.
- Middleware receives the [`MiddlewareContext`] and [`Next`], and returns a future that
  resolves to `Result<(), Error>`. Returning `next.run(c)` directly needs no `async` block; an
  `async move` block can return an error before the command runs or run code after it. Code
  after `next.run(c).await` runs after a streamed result has been written.
- [`stream`] takes any `futures` [`Stream`](futures_core::Stream) of `Result` chunks.

## Running

| Entry                         | Runs on                          | I/O                     |
| ----------------------------- | -------------------------------- | ----------------------- |
| [`Cli::serve`]                | a current-thread tokio runtime   | the process; exits      |
| [`Cli::serve_with`]           | a current-thread tokio runtime   | an [`Io`]; returns code |
| [`Cli::serve_async`]`.await`  | the caller's runtime             | the process; exits      |
| [`Cli::run`]`.await`          | the caller's runtime             | an [`Io`]; returns code |

The core depends on no runtime: [`Cli::run`] returns a `Send` future that any executor can
drive. The blocking entries start a tokio runtime with every driver your dependency graph
enables, so handlers that use `tokio::time` or tokio IO work once your crate enables those tokio
features. Tokio cannot start a runtime inside another, so code already in a runtime awaits
[`Cli::serve_async`] or [`Cli::run`].

## Differences from TypeScript

- Integers in data keep their exact value: `u64` and `i64` values print in full in every
  format, where JavaScript rounds integers beyond 2^53. Floats print as JavaScript prints them.
  Integer options and arguments keep Zod's safe-integer bounds, so validation, help, and JSON
  Schema match TypeScript.
- Config files parse as V8's `JSON.parse` does, with integers that fit 64 bits kept exact.
  Unpaired surrogate escapes, which Rust strings cannot hold, become U+FFFD, as Node prints
  them, and options that accept any value receive infinities as `null`.
- `--mcp`, `mcp add`, `mcp doctor`, `skills add`, and `skills list` report an `UNSUPPORTED`
  error. Self-update, OpenAPI and fetch sources, and MCP proxy commands are not ported.
