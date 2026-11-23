<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-light.svg">
  <img alt="incur" src="https://raw.githubusercontent.com/wevm/incur/main/.github/logo-light.svg" width="100%" height="140px">
</picture>

<br/>

<p align="center">
  <a href="https://github.com/wevm/incur/blob/main/LICENSE">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/l/incur?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/l/incur?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="MIT License">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#install">Install</a> · <a href="#usage">Usage</a> · <a href="#walkthrough">Walkthrough</a> · <a href="#license">License</a>
</p>

[incur](https://github.com/wevm/incur) for Zig: one CLI definition that serves humans, agents, MCP clients, and HTTP, with output that matches the TypeScript framework byte for byte.

## Features

- [**Agent discovery**](#agent-discovery): built-in Skills and MCP sync (`skills add`, `mcp add`) and `--llms` manifests
- [**Call-to-actions**](#call-to-actions): suggest next commands to agents and humans after a run
- **TOON output**: token-efficient default format, with JSON, YAML, Markdown, and JSONL alternatives
- **Well-formed I/O**: plain structs as schemas for arguments, options, environment variables, and output
- **Inferred types**: handlers receive typed structs, with no casts or manual parsing
- [**Global options**](#global-options): `--format`, `--full-output`, `--help`, `--json`, `--update`, `--version` on every CLI
- [**Middleware**](#middleware-and-variables): composable before/after hooks with typed variables via `cli.use()`
- [**Mount APIs**](#mounting-apis): HTTP handlers, OpenAPI documents, and remote MCP servers become commands
- [**Serve over HTTP**](#serving-over-http): the CLI as an HTTP handler, with MCP over HTTP at `/mcp`
- **`std.Io` throughout**: handlers, middleware, and streams do I/O and run concurrently with `io.async`

## Install

Requires Zig 0.17.1.

```sh
zig fetch --save=incur git+https://github.com/wevm/incur
```

```zig
// build.zig
const incur = b.dependency("incur", .{});
exe.root_module.addImport("incur", b.createModule(.{ .root_source_file = incur.path("langs/zig/src/root.zig") }));
```

## Usage

### Single-command CLI

Pass `root` to `Cli.create()` for CLIs that do one thing. Schemas are plain structs; a `pub const incur` declaration carries field metadata.

```zig
const std = @import("std");
const incur = @import("incur");

const Args = struct {
    name: []const u8,

    pub const incur = .{ .fields = .{ .name = .{ .description = "Name to greet" } } };
};

fn greet(c: *incur.Context(.{ .args = Args })) !incur.Outcome {
    return c.ok(.{ .message = try std.fmt.allocPrint(c.allocator, "hello {s}", .{c.args.name}) });
}

pub fn main(init: std.process.Init) !void {
    const cli = try incur.Cli.create(init.gpa, "greet", .{
        .description = "A greeting CLI",
        .root = .{ .run = incur.handler(greet) },
    });
    defer cli.destroy();
    try cli.serve(init);
}
```

```sh
$ greet world
# → message: hello world
```

### Multi-command CLI

Call `cli.command()` to register subcommands.

```zig
const std = @import("std");
const incur = @import("incur");

const InstallArgs = struct {
    package: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .package = .{ .description = "Package name" } } };
};

const InstallOptions = struct {
    save_dev: bool = false,

    pub const incur = .{
        .rename_all = .camel_case,
        .fields = .{ .save_dev = .{ .description = "Save as dev dependency", .alias = 'D' } },
    };
};

fn status(c: *incur.Context(.{})) !incur.Outcome {
    return c.ok(.{ .clean = true });
}

fn install(c: *incur.Context(.{ .args = InstallArgs, .options = InstallOptions })) !incur.Outcome {
    return c.ok(.{ .added = 1, .packages = 451, .dev = c.options.save_dev });
}

pub fn main(init: std.process.Init) !void {
    const cli = try incur.Cli.create(init.gpa, "my-cli", .{ .description = "My CLI" });
    defer cli.destroy();
    try cli.command("status", .{ .description = "Show repo status", .run = incur.handler(status) });
    try cli.command("install", .{ .description = "Install a package", .run = incur.handler(install) });
    try cli.serve(init);
}
```

```sh
$ my-cli status
# → clean: true

$ my-cli install express -D
# → added: 1
# → packages: 451
# → dev: true
```

### Sub-command CLI

Create a separate `Cli` and mount it with `cli.group()` to nest command groups.

```zig
const std = @import("std");
const incur = @import("incur");

const ListOptions = struct { state: enum { open, closed, all } = .open };

fn list(c: *incur.Context(.{ .options = ListOptions })) !incur.Outcome {
    return c.ok(.{ .prs = [_][]const u8{}, .state = c.options.state });
}

pub fn main(init: std.process.Init) !void {
    const cli = try incur.Cli.create(init.gpa, "my-cli", .{ .description = "My CLI" });
    defer cli.destroy();
    const pr = try incur.Cli.create(init.gpa, "pr", .{ .description = "Pull request commands" });
    try pr.command("list", .{ .description = "List pull requests", .run = incur.handler(list) });
    try cli.group(pr); // `cli` now owns `pr`.
    try cli.serve(init);
}
```

```sh
$ my-cli pr list --state closed
# → prs: []
# → state: closed
```

## Walkthrough

Each section is a short tour; the [TypeScript README](https://github.com/wevm/incur#walkthrough) covers the behavior in depth, and this port matches it.

### Agent discovery

```sh
my-cli skills add   # generate and install skill files for detected agents
my-cli mcp add      # register `my-cli --mcp` with your agents
my-cli --llms       # print a Markdown manifest (--llms-full, --format json)
```

`skills add` writes one `SKILL.md` per command group (`--depth`) and links it for agents such as Claude Code; `Options.sync` adds included skill files, setup text, and suggested prompts. `--mcp` starts a stdio MCP server; `Options.mcp` sets the server name, instructions, and whether tools are listed directly or discovered progressively.

### Call-to-actions

Attach suggested next commands to any outcome:

```zig
return (try c.ok(.{ .items = items })).withCta(.{ .commands = &.{
    .{ .command = "get 1", .description = "View item" },
} });
```

### Streaming

Return `c.stream(iterator)` from a handler. The iterator's `next(self, io, allocator) !?incur.Chunk` may do I/O and wait; human and TOON output prints each chunk as it arrives, JSONL writes one record per chunk, and MCP and HTTP clients receive the stream too.

### Middleware and variables

```zig
fn auth(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try c.set("user", .{ .string = "alice" });
    try next.run(c); // the command runs here
}
```

Register with `cli.use(auth)`, per group, or per command (`.middleware`). Handlers read variables with `c.get("user")`; `Options.vars` sets defaults.

### Global options

Every CLI has `--filter-output`, `--format`, `--full-output`, `--help`, `--json`, `--llms`, `--mcp`, `--schema`, `--token-count`, `--token-limit`, `--token-offset`, `--update`, and `--version`. Add your own with `.globals = incur.schema(Globals)` and read them with `c.globalsAs(Globals)`.

### Config file

`.config = .{ .flag = "config", .files = &.{"~/.my-cli.json"} }` loads option defaults per command from the first file that exists, or from a custom `loader`.

### Mounting APIs

```zig
try cli.gateway("api", .{ .fetch = incur.fetch.fromRequest("https://api.example.com", &.{}) });
try cli.gateway("pets", .{ .fetch = incur.fetch.fromRequest("https://pets.example.com", &.{}), .openapi = .{ .url = "openapi.json" } });
try cli.mcpSource("docs", .{ .url = "https://docs.example.com/mcp" });
```

A fetch gateway turns curl-style argv (`my-cli api users --limit 5 -X POST -d '{}'`) into HTTP requests; with `openapi`, each operation becomes a typed command; an MCP source turns a remote server's tools into commands. `fetch` also takes any `incur.http.Handler` (`.{ .handler = other.handler() }`); hosted URLs go out through `std.http.Client`.

### Serving over HTTP

`cli.fetch(allocator, &process, &request)` answers an `incur.http.Request`, and `incur.http.serveConnection` plugs `cli.handler()` into a `std.http.Server`. Paths map to commands, query parameters and JSON bodies to options, and responses use the `--full-output --format json` envelope. `/mcp` speaks MCP over HTTP (stateless by default, `.mcp = .{ .stateless = false }` for sessions), `/openapi.json` describes every command, and `/.well-known/agent-skills/` serves the skill files.

### Update notices

In a terminal, CLIs installed from npm check for a newer version once a day in a detached process and suggest `my-cli --update`, which installs it with npm, pnpm, or Bun. `.update = .{ .check = ..., .install = ... }` replaces both steps for other distributions, and `.update = null` turns updates off.

### Filtering and token pagination

```sh
my-cli users --filter-output users[0,2].name   # keep only these key paths
my-cli users --token-count                     # count output tokens
my-cli users --token-limit 20 --token-offset 20  # page through long output
```

## Differences from TypeScript

- Integers in data keep their exact value; TypeScript rounds integers beyond 2^53.
- Command options that reuse a global option's name are not rejected at registration; the global wins.
- A config file that cannot be read for a reason other than not existing reports the Zig error name.

## License

[MIT](https://github.com/wevm/incur/blob/main/LICENSE)
