# incur

Build CLIs for agents and humans. This package is the Python port of the
[`incur`](https://github.com/wevm/incur) TypeScript package. Its output matches the TypeScript
package byte for byte: a differential suite replays the same invocations against both.

A CLI gets TOON, JSON, YAML, Markdown, and JSONL output, `--llms` manifests, `--schema`,
`--filter-output`, token pagination, call-to-action suggestions, middleware, config-file
defaults, and shell completions. It has no runtime dependencies.

## Example

Declare inputs as schema classes, register handlers with decorators, and serve:

```python
>>> import sys
>>> from typing import Annotated, Literal
>>> import incur

>>> @incur.schema
... class Args:
...     package: Annotated[str, incur.field("Package name")]

>>> @incur.schema(rename_all="camelCase")
... class Options:
...     save_dev: Annotated[bool | None, incur.field("Save as a dev dependency", alias="D")] = None
...     retries: Annotated[float, incur.field("Retry count", min=0, max=10)] = 3
...     tag: Annotated[Literal["latest", "next"], incur.field("Dist tag")] = "latest"

>>> cli = incur.Cli("pm", description="A package manager", version="1.0.0")

>>> @cli.command("install", description="Install a package")
... def install(c: incur.Context[Args, Options]) -> dict[str, object]:
...     return {"package": c.args.package, "retries": c.options.retries, "tag": c.options.tag}

>>> exit_code = cli.serve_with(["install", "left-pad", "-D", "--retries", "5"], stdout=sys.stdout)
package: left-pad
retries: 5
tag: latest

>>> exit_code = cli.serve_with(["install", "--help"], stdout=sys.stdout)
pm install — Install a package
<BLANKLINE>
Usage: pm install <package> [options]
<BLANKLINE>
Arguments:
  package  Package name
<BLANKLINE>
Options:
  --save-dev, -D       Save as a dev dependency
  --retries <number>   Retry count (default: 3)
  --tag <latest|next>  Dist tag (default: latest)
<BLANKLINE>
Global Options:
  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
  --format <toon|json|yaml|md|jsonl>  Output format
  --full-output                       Show full output envelope
  --help                              Show help
  --llms, --llms-full                 Print LLM-readable manifest
  --schema                            Show JSON Schema for command
  --token-count                       Print token count of output (instead of output)
  --token-limit <n>                   Limit output to n tokens
  --token-offset <n>                  Skip first n tokens of output

```

In a script, end with `cli.serve()`: it reads `sys.argv`, the environment, and whether stdout is
a terminal (human output) or not (agent output), runs the event loop, then exits with the
command's exit code. Inside a running event loop, `await cli.serve_async()` does the same and
returns the exit code, and `await cli.run(argv, stdout=...)` takes the arguments and I/O that
`cli.serve_with` does.

## Async handlers and middleware state

Handlers and middleware may be `async def` functions, and streaming handlers async generators;
plain functions and generators work too. Declare middleware variables as a class whose fields
have defaults: every run gets a fresh instance as `c.var`, typed through the annotations.

```python
>>> import asyncio
>>> from collections.abc import AsyncIterator

>>> @incur.schema
... class Vars:
...     user: str = "anonymous"

>>> app = incur.Cli("app", vars=Vars)

>>> @app.use
... async def authenticate(c: incur.MiddlewareContext[Vars], next_: incur.Next) -> None:
...     c.var.user = "alice"
...     await next_()

>>> @app.command("whoami")
... async def whoami(c: incur.Context[None, None, None, Vars]) -> dict[str, str]:
...     return {"user": c.var.user}

>>> @app.command("count")
... async def count(c: incur.Context) -> AsyncIterator[object]:
...     for n in range(2):
...         yield {"n": n}
...     yield incur.ok(cta=incur.CtaBlock(["whoami"]))

>>> asyncio.run(app.run(["whoami"], stdout=sys.stdout))
user: alice
0
>>> exit_code = app.serve_with(["count"], stdout=sys.stdout)
n: 0
n: 1
<BLANKLINE>
Suggested command:
  app whoami

```

Middleware takes the context and `next`. `async def` middleware awaits `next()`; a plain function
calls it and runs in a worker thread, so it may block. Middleware raises `incur.Error` to stop
the chain.

## Schemas

`@incur.schema` turns a class into a keyword-only dataclass and describes its fields:

- `str`, `bool`, `int` (an integer), `float` (any number), `list[T]`, `Literal["a", "b"]` or a
  string `Enum`, `typing.Any`, and nested schema classes. `T | None` marks a field optional.
- Defaults are ordinary attribute values; a field with a default is not required.
- `incur.field(description, alias=, name=, min=, max=, count=, deprecated=)` in
  `typing.Annotated` adds command-line metadata. `min` and `max` bound numbers, string lengths,
  and list lengths. `count=True` counts repeated flags (`-vvv`).
- `rename_all` renames fields as `serde` does: `camelCase`, `kebab-case`, `lowercase`,
  `PascalCase`, `SCREAMING-KEBAB-CASE`, `SCREAMING_SNAKE_CASE`, `snake_case`, or `UPPERCASE`.
- Declarations incur cannot describe raise `incur.SchemaError` when the class is defined or the
  handler is registered.

Handlers take one parameter annotated `incur.Context[Args, Options, Env, Vars, Globals]`;
omitted input parameters are `None`, and omitted `Vars` and `Globals` are untyped. `c.globals` is
an instance of the CLI's `globals` class, and middleware reads `c.env` as an instance of the CLI's
`env` class (`None` without one). Handlers return JSON-compatible data, schema class instances, or
`incur.ok(data, cta=...)`; generators and async generators stream chunks, and yield
`incur.ok(cta=...)` last to suggest commands; and `raise incur.Error(code, message)` fails with a
code. `@cli.root()` registers a command that runs without a subcommand, `cli.group(other)` mounts
another CLI as a command group, and `@cli.use` adds middleware.

## Differences from TypeScript

- `--mcp`, `mcp add`, `mcp doctor`, `skills add`, and `skills list` report an `UNSUPPORTED`
  error. Self-update, HTTP serving, OpenAPI and fetch sources, and MCP proxy commands are not
  ported.
- Integers in data keep their exact value in every format, where TypeScript rounds numbers
  beyond 2^53. Floats print as JavaScript numbers do. `int` fields still accept only safe
  integers (±(2^53 − 1)) unless `min` or `max` say otherwise, as Zod's `z.int()` does.
- Config files that cannot be read report the operating system's message.

## Development

```sh
uv sync
uv run ruff check && uv run ruff format --check
uv run pyright
uv run coverage run -m pytest && uv run coverage report  # 100% branch coverage, subprocesses included
```

The differential test requires Node.js and the repository's `pnpm install`.
`INCUR_DIFFERENTIAL_DUMP=/tmp/failures.txt` writes every differing case to a file.
