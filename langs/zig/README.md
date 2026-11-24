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

- [**Declare once**](#usage): a struct is a command and a `union(enum)` a group; `parse()` returns the typed command to `switch` on, or `serve()` runs a handler
- [**Agent discovery**](#agent-discovery): built-in Skills and MCP sync (`skills add`, `mcp add`) and `--llms` manifests
- [**Call-to-actions**](#call-to-actions): suggest next commands to agents and humans after a run
- **TOON output**: token-efficient default format, with JSON, YAML, Markdown, and JSONL alternatives
- **Well-formed I/O**: plain structs as schemas for arguments, options, environment variables, and output
- [**Global options**](#global-options): `--format`, `--full-output`, `--help`, `--json`, `--update`, `--version` on every CLI
- [**Middleware**](#middleware-and-variables): composable before/after hooks with typed variables
- [**Mount APIs**](#mounting-apis): HTTP handlers, OpenAPI documents, and remote MCP servers become commands
- [**Serve over HTTP**](#serving-over-http): the CLI as an HTTP handler, with MCP over HTTP at `/mcp`
- **`std.Io` throughout**: handlers, middleware, and streams do I/O and run concurrently with `io.async`

## Install

Requires Zig 0.17.1.

```sh
zig fetch --save https://github.com/wevm/incur/releases/download/incur@0.10.0/incur-zig-0.10.0.tar.gz
```

```zig
// build.zig
const incur = b.dependency("incur", .{ .target = target, .optimize = optimize });
exe.root_module.addImport("incur", incur.module("incur"));
```

## Usage

### Single-command CLI

Declare the CLI as a struct. Fields are options, `.arg = true` fields positional arguments, and the `pub const incur` declaration names the CLI and describes its fields. `incur.parse` handles help, `--version`, `--llms`, completions, `skills add`, and validation errors itself, and returns the typed command.

```zig
const std = @import("std");
const incur = @import("incur");

const Greet = struct {
    name: []const u8,

    pub const incur = .{
        .name = "greet",
        .description = "A greeting CLI",
        .fields = .{ .name = .{ .arg = true, .description = "Name to greet" } },
    };
};

pub fn main(init: std.process.Init) !void {
    const greet = try incur.parse(Greet, init);
    const line = try std.fmt.allocPrint(init.arena.allocator(), "hello {s}\n", .{greet.name});
    try std.Io.File.stdout().writeStreamingAll(init.io, line);
}
```

```sh
$ greet world
# → hello world
```

To let incur write the output, in TOON, JSON, YAML, Markdown, or JSONL, and serve the same command to agents over MCP and HTTP, `serve` a handler instead:

```zig
const std = @import("std");
const incur = @import("incur");

const Greet = struct {
    name: []const u8,

    pub const incur = .{
        .name = "greet",
        .description = "A greeting CLI",
        .fields = .{ .name = .{ .arg = true, .description = "Name to greet" } },
    };
};

fn run(c: *incur.Context(.{}), greet: Greet) !incur.Outcome {
    return c.ok(.{ .message = try std.fmt.allocPrint(c.allocator, "hello {s}", .{greet.name}) });
}

pub fn main(init: std.process.Init) !void {
    try incur.serve(Greet, init, run);
}
```

```sh
$ greet world
# → message: hello world

$ greet world --format md
# → | Key     | Value       |
# → |---------|-------------|
# → | message | hello world |
```

### Multi-command CLI

Declare a `union(enum)`: each member is a command, named in kebab-case, with its fields inline. Matching is exhaustive.

```zig
const std = @import("std");
const incur = @import("incur");

const MyCli = union(enum) {
    status,
    install: struct {
        package: ?[]const u8 = null,
        save_dev: bool = false,

        pub const incur = .{ .fields = .{
            .package = .{ .arg = true, .description = "Package name" },
            .save_dev = .{ .alias = 'D', .description = "Save as dev dependency" },
        } };
    },

    pub const incur = .{
        .name = "my-cli",
        .version = "0.1.0",
        .description = "My CLI",
        .fields = .{
            .status = .{ .description = "Show repo status" },
            .install = .{ .description = "Install a package" },
        },
    };
};

fn run(c: *incur.Context(.{}), command: MyCli) !incur.Outcome {
    return switch (command) {
        .status => c.ok(.{ .clean = true }),
        .install => c.ok(.{ .added = 1, .packages = 451 }),
    };
}

pub fn main(init: std.process.Init) !void {
    try incur.serve(MyCli, init, run);
}
```

```sh
$ my-cli status
# → clean: true

$ my-cli install express -D
# → added: 1
# → packages: 451
```

### Sub-command CLI

A member whose type is another union nests a command group.

```zig
const std = @import("std");
const incur = @import("incur");

const Pr = union(enum) {
    list: struct { state: enum { open, closed, all } = .open },

    pub const incur = .{ .description = "Pull request commands", .fields = .{ .list = .{ .description = "List pull requests" } } };
};

const MyCli = union(enum) {
    pr: Pr,

    pub const incur = .{ .name = "my-cli" };
};

fn run(c: *incur.Context(.{}), command: MyCli) !incur.Outcome {
    return switch (command) {
        .pr => |pr| switch (pr) {
            .list => |list| c.ok(.{ .prs = [_][]const u8{}, .state = list.state }),
        },
    };
}

pub fn main(init: std.process.Init) !void {
    try incur.serve(MyCli, init, run);
}
```

```sh
$ my-cli pr list --state closed
# → prs: []
# → state: closed
```

### Parse or serve

Both entries share one definition. `parse` returns the command to your code, which writes the output; it hides `--mcp` and `mcp add`, which need something to call, and exits by itself after help, `--version`, or an error. The command lives in `init.arena`. `serve` writes what the handler returns and also serves `--mcp`. To customize either, create the `Cli` with `incur.cli(T, gpa, options)`, then add middleware or commands and call `cli.parse(T, init)`, or `cli.handle(T, run)` and `cli.serve(init)` or `cli.fetch` for HTTP. Tests call `incur.parseWith(T, arena, argv, process)`, which returns `.{ .command = ... }` or `.{ .exit = code }` and allocates everything, the command included, with the arena.

```zig
const std = @import("std");
const incur = @import("incur");

const MyCli = union(enum) {
    status,

    pub const incur = .{ .name = "my-cli", .version = "0.1.0", .fields = .{ .status = .{ .description = "Show repo status" } } };
};

pub fn main(init: std.process.Init) !void {
    const cli = try incur.cli(MyCli, init.gpa, .{ .update = null });
    defer cli.destroy();
    switch (try cli.parse(MyCli, init)) {
        .status => try std.Io.File.stdout().writeStreamingAll(init.io, "clean\n"),
    }
}
```

```sh
$ my-cli status
# → clean

$ my-cli --version
# → 0.1.0
```

The builder (`incur.Cli.create`, `cli.command`, `incur.handler`) declares CLIs on its own too, for commands known only at run time, and the two compose: `cli.group(declared)` mounts a declared group on a builder CLI, and `cli.command` adds builder commands to a declared one.

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

Register with `cli.use(auth)`, or with `.middleware = &.{auth}` in a declared group's or command's `incur` declaration. Handlers read variables with `c.get("user")`; `Options.vars` sets defaults.

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
