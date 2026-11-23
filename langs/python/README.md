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
a terminal (human output) or not (agent output), then exits with the command's exit code.

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

Handlers take one parameter annotated `incur.Context[Args, Options, Env]`; omitted parameters
are `None`. They return JSON-compatible data, schema class instances, or `incur.ok(data, cta=...)`;
generators stream chunks; and `raise incur.Error(code, message)` fails with a code.
`@cli.root()` registers a command that runs without a subcommand, `cli.group(other)` mounts
another CLI as a command group, and `@cli.use` adds middleware that calls `next()`.

## Differences from TypeScript

- The library is synchronous. Streaming handlers are generators.
- `--mcp`, `mcp add`, `mcp doctor`, `skills add`, and `skills list` report an `UNSUPPORTED`
  error. Self-update, OpenAPI and fetch sources, and MCP proxy commands are not ported.
- Numbers are JavaScript numbers: integers beyond 2^53 print rounded.
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
