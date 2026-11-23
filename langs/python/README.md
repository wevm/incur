<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-light.svg">
  <img alt="incur" src="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-light.svg" width="100%" height="140px">
</picture>

<br/>

<p align="center">
  <a href="https://github.com/wevm/incur/blob/main/LICENSE">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/github/license/wevm/incur?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/github/license/wevm/incur?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="MIT License">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#install">Install</a> · <a href="#usage">Usage</a> · <a href="#walkthrough">Walkthrough</a> · <a href="#license">License</a>
</p>

[incur](https://github.com/wevm/incur) for Python: build CLIs for agents and humans, with output that matches the TypeScript package byte for byte.

## Features

- [**Agent discovery**](#agent-discovery): built-in Skills and MCP sync (`skills add`, `mcp add`) so agents find your CLI automatically
- [**Call-to-actions**](#call-to-actions): suggest next commands to agents and humans after a run
- **TOON output**: token-efficient default format, with JSON, YAML, Markdown, and JSONL alternatives
- [**`--llms` flag**](#agent-discovery): token-efficient command manifest in Markdown or JSON schema
- **Well-formed I/O**: schema classes for arguments, options, environment variables, and output
- **Typed contexts**: `Context[Args, Options, Env, Vars, Globals]` types handlers and middleware under strict pyright
- [**Global options**](#global-options): `--format`, `--full-output`, `--help`, `--json`, `--update`, `--version` on every CLI for free
- [**Mount APIs**](#mount-apis): fetch handlers, OpenAPI documents, and remote MCP servers as commands
- [**Serve over HTTP**](#serve-over-http): every CLI is an ASGI app with an MCP endpoint
- [**Middleware**](#middleware-and-variables): composable before/after hooks with typed variables via `@cli.use`
- **Async-native**: handlers and middleware may be `async def`, and streams async generators
- **Zero dependencies**: standard library only

## Install

```bash
pip install incur
```

## Usage

### Single-command CLI

Register a root command with `@cli.root()` for CLIs that do one thing.

```python
from typing import Annotated

import incur


@incur.schema
class Args:
    name: Annotated[str, incur.field("Name to greet")]


cli = incur.Cli("greet", description="A greeting CLI")


@cli.root()
def greet(c: incur.Context[Args]) -> dict[str, str]:
    return {"message": f"hello {c.args.name}"}


if __name__ == "__main__":
    cli.serve()
```

```sh
$ greet world
# → message: hello world
```

### Multi-command CLI

Decorate a function per subcommand.

```python
from typing import Annotated

import incur


@incur.schema
class InstallArgs:
    package: Annotated[str | None, incur.field("Package name")] = None


@incur.schema(rename_all="camelCase")
class InstallOptions:
    save_dev: Annotated[bool | None, incur.field("Save as dev dependency", alias="D")] = None


cli = incur.Cli("my-cli", description="My CLI")


@cli.command("status", description="Show repo status")
def status(c: incur.Context) -> dict[str, bool]:
    return {"clean": True}


@cli.command("install", description="Install a package")
def install(c: incur.Context[InstallArgs, InstallOptions]) -> dict[str, int]:
    return {"added": 1, "packages": 451}


if __name__ == "__main__":
    cli.serve()
```

```sh
$ my-cli status
# → clean: true

$ my-cli install express -D
# → added: 1
# → packages: 451
```

### Sub-command CLI

Create a separate `Cli` and mount it with `cli.group(...)` to nest command groups.

```python
from typing import Literal

import incur

cli = incur.Cli("my-cli", description="My CLI")
pr = incur.Cli("pr", description="Pull request commands")


@incur.schema
class ListOptions:
    state: Literal["open", "closed", "all"] = "open"


@pr.command("list", description="List pull requests")
def list_prs(c: incur.Context[None, ListOptions]) -> dict[str, object]:
    return {"prs": [], "state": c.options.state}


cli.group(pr)

if __name__ == "__main__":
    cli.serve()
```

```sh
$ my-cli pr list --state closed
# → prs: []
# → state: closed
```

## Walkthrough

### Agent discovery

Agents can only use your CLI if they know it exists. incur ships three built-in discovery mechanisms:

```sh
# Generate and install agent skill files (recommended – lighter on tokens)
$ my-cli skills add

# Register as an MCP server for your agents
$ my-cli mcp add

# Print a machine-readable manifest
$ my-cli --llms
```

`--mcp` serves the commands as MCP tools over stdio. Set `package=` when the CLI's npm package differs from its name, `mcp=incur.McpOptions(...)` to configure the server, and `sync=False` to drop the skills commands. See [Agent discovery](https://github.com/wevm/incur#agent-discovery).

### Call-to-actions

Return `incur.ok(data, cta=...)` to tell agents which commands to run next. `incur.Error(code, message, cta=...)` carries suggestions too.

```python
import incur

cli = incur.Cli("my-cli")


@cli.command("list")
def list_items(c: incur.Context) -> incur.Outcome:
    items = [{"id": 1, "title": "Fix bug"}]
    return incur.ok({"items": items}, cta=incur.CtaBlock([incur.Cta("get 1", "View item")]))
```

```sh
$ my-cli list
# → items[1]{id,title}:
# →   1,Fix bug
# → cta:
# →   description: "Suggested command:"
# →   commands[1]{command,description}:
# →     my-cli get 1,View item
```

### Streaming

Generators and async generators stream chunks: one line each in TOON, one record each with `--format jsonl`.

```python
from collections.abc import AsyncIterator

import incur

cli = incur.Cli("my-cli")


@cli.command("logs", description="Tail logs")
async def logs(c: incur.Context) -> AsyncIterator[str]:
    for line in ("connecting...", "streaming logs", "done"):
        yield line
```

```sh
$ my-cli logs
# → connecting...
# → streaming logs
# → done
```

### Middleware and variables

`@cli.use` registers onion-style middleware that awaits `next_()`. Declare `vars` as a schema class whose fields have defaults: each run gets a fresh, typed instance as `c.var`.

```python
import incur


@incur.schema
class Vars:
    user: str = "anonymous"


cli = incur.Cli("my-cli", vars=Vars)


@cli.use
async def authenticate(c: incur.MiddlewareContext[Vars], next_: incur.Next) -> None:
    c.var.user = "alice"
    await next_()


@cli.command("whoami")
def whoami(c: incur.Context[None, None, None, Vars]) -> dict[str, str]:
    return {"user": c.var.user}
```

```sh
$ my-cli whoami
# → user: alice
```

Raise `incur.Error` to stop the chain. See [Middleware](https://github.com/wevm/incur#middleware).

### Global options

Every CLI accepts `--filter-output`, `--format`, `--full-output`, `--help`, `--json`, `--llms`, `--mcp`, `--schema`, `--token-count`, `--token-limit`, `--token-offset`, `--update`, and `--version`. Declare your own with `globals=`, a schema class every handler reads as `c.globals`.

### Config file

`config=incur.Config(flag="config", files=["my-cli.json"])` loads option defaults from `{"commands": {"<name>": {"options": {...}}}}`; a `loader` reads other formats. Precedence is argv, then config, then schema defaults. See [Config file](https://github.com/wevm/incur#config-file).

### Mount APIs

`cli.gateway(name, fetch)` forwards curl-style arguments to a fetch handler: any function from `incur.Request` to `incur.Response`, plain or `async def`. `incur.from_request(url)` forwards to a hosted API.

```python
import incur


def app(request: incur.Request) -> incur.Response:
    if request.method == "POST":
        return incur.Response.json({"created": True, **request.json()}, status=201)
    return incur.Response.json({"users": [{"id": 1, "name": "Alice"}]})


cli = incur.Cli("my-cli")
cli.gateway("api", app)
```

```sh
$ my-cli api users
# → users[1]{id,name}:
# →   1,Alice

$ my-cli api users -X POST -d '{"name":"Bob"}'
# → created: true
# → name: Bob
```

With `openapi=` (a document or its URL), each operation becomes a typed command; `openapi_config=incur.OpenapiConfig(mode="namespace")` nests them by path. `cli.mcp_source` turns a remote MCP server's tools into commands:

```python
import incur

cli = incur.Cli("my-cli")
cli.gateway("pets", incur.from_request("https://petstore.example/v1/"), openapi="openapi.json")
cli.mcp_source("docs", "https://mcp.tempo.xyz/mcp")
```

See [Mount APIs as CLIs](https://github.com/wevm/incur#mount-apis-as-clis).

### Serve over HTTP

`await cli.fetch(request)` runs the command a path names, and `cli.asgi` is the same as an ASGI 3 app (`uvicorn app:cli.asgi`):

```
GET  /users?limit=5            → my-cli users --limit 5
POST /users {"name": "Bob"}    → my-cli users --name Bob
POST /mcp                      → MCP over HTTP
GET  /openapi.json             → the commands as an OpenAPI document
GET  /.well-known/agent-skills/index.json → Agent Skills discovery
```

Responses use the `--full-output --format json` envelope, and streams are NDJSON. See [Serve CLIs as APIs](https://github.com/wevm/incur#serve-clis-as-apis).

### Update notices

In a terminal, CLIs installed from npm check for updates once a day in a detached process and suggest `my-cli --update`. `update=incur.Update(check=..., install=...)` supplies custom checks and installers, and `update=False` disables both. See [Update notices](https://github.com/wevm/incur#update-notices).

### Filtering and token pagination

`--filter-output` prunes output to key paths, and `--token-count`, `--token-limit`, and `--token-offset` page through large outputs.

```python
import incur

cli = incur.Cli("my-cli")


@cli.command("users")
def users(c: incur.Context) -> dict[str, object]:
    return {"users": [{"name": "Alice", "role": "admin"}, {"name": "Bob", "role": "user"}]}
```

```sh
$ my-cli users --filter-output users[0,2].name
# → users[2]{name}:
# →   Alice
# →   Bob

$ my-cli users --token-count
# → 14
```

## Differences from TypeScript

- Integers in data keep their exact value in every format, where JavaScript rounds beyond 2^53.
- JSON Schema string formats other than `date-time` (such as `email` or `uuid`) are not validated.
- Standalone binaries and file-based commands are not ported.

## License

[MIT](https://github.com/wevm/incur/blob/main/LICENSE)
