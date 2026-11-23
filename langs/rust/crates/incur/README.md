# incur

Build CLIs for agents and humans. This crate is the Rust port of the
[`incur`](https://github.com/wevm/incur) TypeScript package. Its output matches the TypeScript
package byte for byte: a differential suite replays the same invocations against both.

A CLI gets TOON, JSON, YAML, Markdown, and JSONL output, `--llms` manifests, `--schema`,
`--filter-output`, token pagination, call-to-action suggestions, middleware, config-file
defaults, and shell completions.

```rust,no_run
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
    retries: f64,
}

fn three() -> f64 {
    3.0
}

fn main() {
    Cli::new("pm")
        .description("A package manager")
        .version("1.0.0")
        .command(
            "install",
            Command::new()
                .description("Install a package")
                .run(|c: Context<Args, Options>| {
                    Ok::<_, Error>(json!({ "package": c.args.package, "retries": c.options.retries }))
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

## Differences from TypeScript

- The library is synchronous. Streaming handlers return an iterator through `incur::stream`.
- `--mcp`, `mcp add`, `mcp doctor`, `skills add`, and `skills list` report an `UNSUPPORTED`
  error. Self-update, OpenAPI and fetch sources, and MCP proxy commands are not ported.
- Numbers are JavaScript numbers: integers beyond 2^53 print rounded.
- Config files that V8 accepts but `serde_json` rejects, such as numbers beyond the double range,
  report `serde_json`'s parse error.
