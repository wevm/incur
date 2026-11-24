//! Zig API tests for the agent and network features — skills, MCP, OpenAPI, fetch, HTTP serving,
//! and updates — covering inputs the differential suite does not reach: frontmatter variants,
//! file system failures, malformed protocol messages, and the production network path.

const std = @import("std");
const builtin = @import("builtin");
const incur = @import("incur");

const testing = std.testing;
const Allocator = std.mem.Allocator;
const Context = incur.Context;
const Outcome = incur.Outcome;
const Value = incur.Value;

/// The result of one invocation.
const Served = struct { exit: u8, stdout: []const u8, stderr: []const u8 };

/// How to serve one invocation.
const Options = struct {
    env: []const [2][]const u8 = &.{},
    program: ?[]const u8 = null,
    stdin: ?[]const u8 = null,
    tty: bool = false,
    network: ?incur.http.Handler = null,
};

/// Serves `argv` and returns its exit code and output, allocated with `a`.
fn serve(a: Allocator, cli: *incur.Cli, argv: []const []const u8, options: Options) !Served {
    var env: std.process.Environ.Map = .init(a);
    for (options.env) |v| try env.put(v[0], v[1]);
    var stdout: std.Io.Writer.Allocating = .init(a);
    var stderr: std.Io.Writer.Allocating = .init(a);
    var stdin: std.Io.Reader = .fixed(options.stdin orelse "");
    const exit = try cli.serveWith(argv, .{
        .io = testing.io,
        .env = &env,
        .stdout = &stdout.writer,
        .stderr = &stderr.writer,
        .stdin = if (options.stdin != null) &stdin else null,
        .tty = options.tty,
        .program = options.program,
        .network = options.network,
    });
    return .{ .exit = exit, .stdout = stdout.written(), .stderr = stderr.written() };
}

/// Returns the absolute path of a temporary directory.
fn tmpPath(a: Allocator, dir: testing.TmpDir) ![]const u8 {
    return dir.dir.realPathFileAlloc(testing.io, ".", a);
}

/// Writes files under a temporary directory, creating their parents.
fn seed(dir: testing.TmpDir, files: []const [2][]const u8) !void {
    for (files) |f| {
        if (std.fs.path.dirname(f[0])) |parent| try dir.dir.createDirPath(testing.io, parent);
        try dir.dir.writeFile(testing.io, .{ .sub_path = f[0], .data = f[1] });
    }
}

fn ok(c: *Context(.{})) !Outcome {
    return c.ok(.{ .ok = true });
}

test "reads skill frontmatter with YAML scalars" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    try seed(dir, &.{
        .{ "skills/double/SKILL.md", "---\nname: double\nt: \"\\t\"\ndescription: \"tab\\nquote\\\" \\u00e9 \\/\"\n---\n" },
        .{ "skills/single/SKILL.md", "---\r\n# comment\r\n\r\ndescription: 'it''s \"fine\"'\r\n---\r\n" },
        .{ "skills/literal/SKILL.md", "---\ndescription: |\n  one\n\n  two\n    three\nname: x\n---\n" },
        .{ "skills/folded/SKILL.md", "---\ndescription: >-\n  folded\n  text\n\n  para\n    kept\n  end\n---\n" },
        .{ "skills/kept/SKILL.md", "---\ndescription: >+\n  keep\n\n---\n" },
        .{ "skills/empty-block/SKILL.md", "---\ndescription: |\n---\n" },
        .{ "skills/plain/SKILL.md", "---\ndescription: plain\n  continued\n\n  next\n---\n" },
        .{ "skills/scalars/SKILL.md", "---\ndescription: true\nf: False # c\ni: .inf\nn: -.Inf\nm: .nan\nh: 0x1f\nz: ~\nl: [a]\nc: #c\nq: \"quoted\n  key\"\n\"k\": v\nnested:\n  child: 1\n---\n" },
        .{ "skills/unclosed/SKILL.md", "---\ndescription: never closed\n" },
        .{ "skills/no-frontmatter/SKILL.md", "body only\n" },
        .{ "skills/bad-single/SKILL.md", "---\ndescription: 'a'b'\n---\n" },
        .{ "skills/bad-double/SKILL.md", "---\ndescription: \"a\"b\"\n---\n" },
        .{ "skills/bad-end/SKILL.md", "---\ndescription: \"a\\\"\n---\n" },
        .{ "skills/bad-escape/SKILL.md", "---\ndescription: \"\\\n---\n" },
        .{ "skills/bad-unicode/SKILL.md", "---\ndescription: \"\\uZZZZ\"\n---\n" },
        .{ "skills/bad-short/SKILL.md", "---\ndescription: \"\\u12\"\n---\n" },
        .{ "skills/bad-surrogate/SKILL.md", "---\ndescription: \"\\ud800\"\n---\n" },
        .{ "skills/bad-unterminated/SKILL.md", "---\ndescription: 'open\n---\n" },
        .{ "skills/bad-indent/SKILL.md", "---\n  description: x\n---\n" },
        .{ "skills/bad-pair/SKILL.md", "---\nnot a pair\n---\n" },
        .{ "skills/.hidden/SKILL.md", "---\ndescription: hidden\n---\n" },
    });
    const cwd = try tmpPath(a, dir);
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .sync = .{ .cwd = cwd, .include = &.{ "skills/*", "missing/*", "skills/plain" } } });
    defer cli.destroy();
    try cli.command("status", .{ .description = "Show status", .run = incur.handler(ok) });
    const served = try serve(a, cli, &.{ "skills", "list" }, .{ .env = &.{.{ "HOME", cwd }} });
    try testing.expectEqualStrings(
        \\  ✗ double          tab
        \\quote" é /
        \\  ✗ empty-block
        \\  ✗ folded          folded text
        \\para
        \\  kept
        \\end
        \\  ✗ kept            keep
        \\
        \\
        \\  ✗ literal         one
        \\
        \\two
        \\  three
        \\
        \\  ✗ no-frontmatter
        \\  ✗ plain           plain continued
        \\next
        \\  ✗ scalars
        \\  ✗ single          it's "fine"
        \\  ✗ tool-status     Show status. Run `tool status --help` for usage details.
        \\  ✗ unclosed
        \\
        \\11 skills (0 installed)
        \\
    , served.stdout);
}

/// Returns whether a path exists, without following a final symlink.
fn present(dir: testing.TmpDir, path: []const u8) bool {
    _ = dir.dir.statFile(testing.io, path, .{ .follow_symlinks = false }) catch return false;
    return true;
}

test "installs skills for agents and removes stale ones" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    try seed(dir, &.{
        .{ ".local/share/incur/tool.json", "{\"hash\":\"x\",\"skills\":[\"tool-old\"]}" },
        .{ ".agents/skills/tool-old/SKILL.md", "old\n" },
        .{ "claude/skills/tool-old/SKILL.md", "old\n" },
        .{ ".cursor/settings", "" },
        .{ "SKILL.md", "Root skill without frontmatter\n" },
        .{ "pkg/package.json", "{}" },
        .{ "pkg/bin/tool", "" },
    });
    const home = try tmpPath(a, dir);
    const claude = try std.fmt.allocPrint(a, " {s}/claude ", .{home});
    const env: []const [2][]const u8 = &.{ .{ "HOME", home }, .{ "CLAUDE_CONFIG_DIR", claude }, .{ "TMPDIR", home } };

    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .sync = .{ .cwd = home, .include = &.{"_root"} } });
    defer cli.destroy();
    try cli.command("status", .{ .description = "Show status", .run = incur.handler(ok) });
    // The root skill file and the included root skill share the CLI's name, so one is installed.
    const added = try serve(a, cli, &.{ "skills", "add", "--depth", "0" }, .{ .env = env });
    try testing.expectEqualStrings("Syncing...\r\x1b[K  ✓ tool  Show status. Run `tool --help` for usage details.\n\n1 skill synced\n\nRun `tool --help` to see the full command reference.\n", added.stdout);
    try testing.expect(!present(dir, ".agents/skills/tool-old"));
    try testing.expect(!present(dir, "claude/skills/tool-old"));
    try testing.expect(present(dir, "claude/skills/tool"));
    // Listing groups by the configured depth and includes the root skill file by the CLI's name.
    const listed = try serve(a, cli, &.{ "skills", "list" }, .{ .env = env });
    try testing.expectEqualStrings("  ✓ tool\n  ✗ tool-status  Show status. Run `tool status --help` for usage details.\n\n2 skills (1 installed)\n", listed.stdout);

    // Global installs read `include` patterns from the package that contains the program, or
    // from the working directory.
    const global = try incur.Cli.create(testing.allocator, "tool", .{ .sync = .{ .include = &.{"_root"} } });
    defer global.destroy();
    try global.command("status", .{ .description = "Show status", .run = incur.handler(ok) });
    for ([_][]const u8{ try std.fs.path.join(a, &.{ home, "pkg", "bin", "tool" }), try std.fs.path.join(a, &.{ home, "missing" }) }) |program| {
        const served = try serve(a, global, &.{ "skills", "add" }, .{ .env = env, .program = program });
        try testing.expectEqual(0, served.exit);
    }
}

test "reports skills that cannot be written" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    try seed(dir, &.{.{ "file", "" }});
    const home = try tmpPath(a, dir);
    const file = try std.fs.path.join(a, &.{ home, "file" });
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .sync = .{ .cwd = home } });
    defer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(ok) });
    const staging = try serve(a, cli, &.{ "skills", "add" }, .{ .env = &.{ .{ "HOME", home }, .{ "TMPDIR", file } } });
    try testing.expectEqual(1, staging.exit);
    try testing.expect(std.mem.find(u8, staging.stdout, "code: SYNC_SKILLS_FAILED\nmessage: Cannot write skills to ") != null);
    const metadata = try serve(a, cli, &.{ "skills", "add" }, .{ .env = &.{ .{ "HOME", home }, .{ "TMPDIR", home }, .{ "XDG_DATA_HOME", file } } });
    try testing.expectEqual(1, metadata.exit);
    try testing.expect(std.mem.find(u8, metadata.stdout, try std.fmt.allocPrint(a, "message: Cannot write {s}/incur/tool.json\n", .{file})) != null);
}

test "suggests syncing stale skills" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const home = try tmpPath(a, dir);
    try seed(dir, &.{.{ ".agents/skills/tool-status/SKILL.md", "x\n" }});
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .package = "Bad Name", .update = null });
    defer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(ok) });
    const metadata = [_][]const u8{
        "{\"hash\":\"x\",\"skills\":[\"tool-status\"],\"paths\":[\"<home>/.agents/skills/tool-status\"]}",
        "{\"hash\":1,\"skills\":[\"tool-status\"]}",
        "{\"hash\":\"\",\"skills\":[\"tool-status\"]}",
        "{\"skills\":[\"tool-status\"]}",
        "{\"hash\":\"x\",\"skills\":\"tool-status\"}",
        "{\"hash\":\"x\",\"skills\":[1,\"tool-gone\"]}",
    };
    for (metadata, 0..) |text, i| {
        try seed(dir, &.{.{ ".local/share/incur/tool.json", try std.mem.replaceOwned(u8, a, text, "<home>", home) }});
        const served = try serve(a, cli, &.{"status"}, .{ .env = &.{ .{ "HOME", home }, .{ "npm_config_user_agent", "npm/10" } } });
        // An invalid package falls back to the program name.
        try testing.expectEqualStrings(if (i == 0) "ok: true\ncta:\n  description: \"Skills are out of date:\"\n  commands[1]{command,description}:\n    tool skills add,sync outdated skills\n" else "ok: true\n", served.stdout);
    }
}

/// A stub package runner that prints `STUB_STDOUT` and `STUB_STDERR` and exits with
/// `STUB_EXIT`.
const stub =
    \\#!/bin/sh
    \\printf '%s' "$STUB_STDERR" >&2
    \\printf '%s' "$STUB_STDOUT"
    \\exit "${STUB_EXIT:-0}"
    \\
;

test "registers MCP servers with exact package versions" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    try dir.dir.createDirPath(testing.io, "bin");
    try dir.dir.writeFile(testing.io, .{ .sub_path = "bin/npx", .data = stub, .flags = .{ .permissions = .executable_file } });
    try seed(dir, &.{.{ ".config/amp/settings.json", "[]" }});
    const home = try tmpPath(a, dir);
    const bin = try std.fs.path.join(a, &.{ home, "bin" });

    const valid = try incur.Cli.create(testing.allocator, "tool", .{ .package = "pkg", .version = "1.0.0-beta.1+build.5" });
    defer valid.destroy();
    const added = try serve(a, valid, &.{ "mcp", "add" }, .{ .program = "/x/other", .env = &.{ .{ "HOME", home }, .{ "PATH", bin }, .{ "STUB_STDOUT", "✓ Cursor: ~/.cursor\n✔ \n" } } });
    try testing.expectEqualStrings("Registering MCP server...\r\x1b[K✓ Registered tool as MCP server\n  Agents: Cursor, Amp\n\nAgents can now use tool tools.\n", added.stdout);
    const settings = try dir.dir.readFileAlloc(testing.io, ".config/amp/settings.json", a, .unlimited);
    try testing.expectEqualStrings("{\n  \"amp.mcpServers\": {\n    \"tool\": {\n      \"command\": \"npx\",\n      \"args\": [\n        \"pkg@1.0.0-beta.1+build.5\",\n        \"--mcp\"\n      ]\n    }\n  }\n}\n", settings);

    const failed = try serve(a, valid, &.{ "mcp", "add" }, .{ .program = "/x/other", .env = &.{ .{ "HOME", home }, .{ "PATH", bin }, .{ "STUB_EXIT", "1" } } });
    try testing.expectEqualStrings("Registering MCP server...code: MCP_ADD_FAILED\nmessage: \"Command failed: npx add-mcp npx pkg@1.0.0-beta.1+build.5 --mcp --name tool -y -g\"\n", failed.stdout);
    const missing = try serve(a, valid, &.{ "mcp", "add" }, .{ .program = "/x/other", .env = &.{.{ "HOME", home }} });
    try testing.expectEqualStrings("Registering MCP server...code: MCP_ADD_FAILED\nmessage: spawn npx ENOENT\n", missing.stdout);

    // A dependency's entry that the project does not depend on is expected on `PATH`.
    try seed(dir, &.{ .{ "package.json", "{\"dependencies\":{\"other\":\"1\"}}" }, .{ "node_modules/tool/cli.js", "" } });
    const dependency = try serve(a, valid, &.{ "mcp", "add", "--agent", "amp" }, .{ .program = try std.fs.path.join(a, &.{ home, "node_modules", "tool", "cli.js" }), .env = &.{.{ "HOME", home }} });
    try testing.expect(std.mem.find(u8, dependency.stdout, "Registered tool as MCP server") != null);
    try testing.expect(std.mem.find(u8, try dir.dir.readFileAlloc(testing.io, ".config/amp/settings.json", a, .unlimited), "\"command\": \"tool\"") != null);

    for ([_][]const u8{ "1.0.0-", "1.0.0+", "1.0.0-a..b", "1.0.0-a_b", "1.0", "1.0.0.0", "1.x.0", "1..0" }) |version| {
        const cli = try incur.Cli.create(testing.allocator, "tool", .{ .package = "pkg", .version = version });
        defer cli.destroy();
        const served = try serve(a, cli, &.{ "mcp", "add" }, .{ .env = &.{.{ "HOME", home }} });
        try testing.expectEqualStrings(try std.fmt.allocPrint(a, "Registering MCP server...code: MCP_ADD_FAILED\nmessage: \"Invalid exact package version: {s}\"\n", .{version}), served.stdout);
    }
}

fn alpha(_: *const incur.update.Check) !?[]const u8 {
    return "1.0.0-alpha";
}

test "runs Windows command scripts with every argument intact" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    // Like npm's `npx.cmd`, the script forwards `%*`, which `cmd.exe` parses a second time.
    try seed(dir, &.{
        .{ "record.cjs", "require('fs').writeFileSync(require('path').join(__dirname, 'calls'), JSON.stringify(process.argv.slice(2)))\nconsole.log('\u{2502} \u{2713} Codex: added')\n" },
        .{ "npx.cmd", "@ECHO off\r\nnode \"%~dp0\\record.cjs\" %*\r\n" },
    });
    const home = try tmpPath(a, dir);
    var env = try testing.environ.createMap(a);
    try env.put("HOME", home);
    try env.put("PATH", try std.fmt.allocPrint(a, "{s};{s}", .{ home, env.get("PATH") orelse "" }));
    const agents = [_][]const u8{ "a&b|c<d>e^f", "100%", "%PATH%", "!bang! (x) ;semi, comma", "q\\\"uote", "dir\\" };
    var argv: std.ArrayList([]const u8) = .empty;
    try argv.appendSlice(a, &.{ "mcp", "add" });
    for (agents) |agent| try argv.appendSlice(a, &.{ "--agent", agent });
    const cli = try incur.Cli.create(testing.allocator, "kit", .{});
    defer cli.destroy();
    var stdout: std.Io.Writer.Allocating = .init(a);
    var stderr: std.Io.Writer.Allocating = .init(a);
    const exit = try cli.serveWith(argv.items, .{ .io = testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stderr.writer, .tty = false, .program = "/x/other" });
    try testing.expectEqualStrings("Registering MCP server...\r\x1b[K\u{2713} Registered kit as MCP server\n  Agents: Codex\n\nAgents can now use kit tools.\n", stdout.written());
    try testing.expectEqual(0, exit);
    const calls = try std.json.parseFromSliceLeaky([]const []const u8, a, try dir.dir.readFileAlloc(testing.io, "calls", a, .unlimited), .{});
    try testing.expectEqual(6 + 2 * agents.len, calls.len);
    for (agents, 0..) |agent, i| {
        try testing.expectEqualStrings("-a", calls[6 + 2 * i]);
        try testing.expectEqualStrings(agent, calls[7 + 2 * i]);
    }
}

test "notices prerelease updates and schedules refreshes" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const home = try tmpPath(a, dir);
    const env: []const [2][]const u8 = &.{ .{ "HOME", home }, .{ "XDG_CACHE_HOME", home } };
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .version = "1.0.0-1", .sync = null, .update = .{ .check = alpha, .interval = 0 } });
    defer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(ok) });
    // Without a program path, no refresh starts.
    try testing.expectEqualStrings("ok: true\n", (try serve(a, cli, &.{"status"}, .{ .env = env, .tty = true })).stdout);
    try testing.expect(!present(dir, "incur"));
    // A refresh that cannot start still marks the check.
    try testing.expectEqualStrings("ok: true\n", (try serve(a, cli, &.{"status"}, .{ .env = env, .tty = true, .program = "/nonexistent/tool" })).stdout);
    try testing.expect(present(dir, "incur/updates/tool.json"));
    // Text prerelease identifiers rank above numeric ones.
    _ = try serve(a, cli, &.{"--incur-update-check"}, .{ .env = env });
    try testing.expectEqualStrings("ok: true\n\nUpdate available for tool:\n  tool --update  # upgrade from 1.0.0-1 to 1.0.0-alpha\n", (try serve(a, cli, &.{"status"}, .{ .env = env, .tty = true })).stdout);
}

/// Sends one HTTP request to the CLI's handler.
fn fetch(a: Allocator, cli: *incur.Cli, method: []const u8, url: []const u8, headers: []const [2][]const u8, body: ?[]const u8) !incur.http.Response {
    var env: std.process.Environ.Map = .init(a);
    var out: std.Io.Writer.Discarding = .init(&.{});
    const process: incur.Process = .{ .io = testing.io, .env = &env, .stdout = &out.writer, .stderr = &out.writer, .tty = false };
    var request: incur.http.Request = .{ .method = method, .url = url, .body = body };
    for (headers) |h| try request.headers.set(a, h[0], h[1]);
    return cli.fetch(a, &process, &request);
}

const mcp_headers: []const [2][]const u8 = &.{ .{ "accept", "application/json, text/event-stream" }, .{ "content-type", "application/json" } };
const initialize = "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"c\",\"version\":\"1\"}}}";

test "classifies MCP messages over HTTP" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .mcp = .{ .stateless = false, .tools = .{ .discovery = .direct, .include = &.{ "pi*g", "p*x" } } } });
    defer cli.destroy();
    try cli.command("ping", .{ .description = "Ping", .run = incur.handler(ok) });
    try cli.command("pong", .{ .description = "Hidden by the include patterns", .run = incur.handler(ok) });

    const url = "http://localhost/mcp";
    const initialized = try fetch(a, cli, "POST", url, mcp_headers, initialize);
    try testing.expectEqual(200, initialized.status);
    const session = initialized.headers.get("mcp-session-id").?;
    const with_session: []const [2][]const u8 = &.{ mcp_headers[0], mcp_headers[1], .{ "mcp-session-id", session }, .{ "mcp-protocol-version", "2025-06-18" } };
    const listed = try fetch(a, cli, "POST", url, with_session, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}");
    try testing.expectEqualStrings("{\"result\":{\"tools\":[{\"name\":\"ping\",\"description\":\"Ping\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}]},\"jsonrpc\":\"2.0\",\"id\":1}", listed.body);

    // Responses and errors from the client need no answer; malformed ones are rejected.
    for ([_]struct { []const u8, u16 }{
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}", 202 },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1,\"message\":\"m\"}}", 202 },
        .{ "{\"jsonrpc\":\"2.0\",\"result\":{}}", 400 },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{},\"x\":1}", 400 },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":1}", 400 },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"m\"}}", 400 },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":1}}", 400 },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":\"1\",\"message\":\"m\"}}", 400 },
    }) |case| try testing.expectEqual(case[1], (try fetch(a, cli, "POST", url, with_session, case[0])).status);

    const stream = try fetch(a, cli, "GET", url, &.{ .{ "accept", "text/event-stream" }, .{ "mcp-session-id", session } }, null);
    try testing.expectEqual(405, stream.status);
    const put = try fetch(a, cli, "PUT", url, &.{}, null);
    try testing.expectEqual(405, put.status);
    try testing.expectEqualStrings("GET, POST, DELETE", put.headers.get("allow").?);
    const version = try fetch(a, cli, "POST", url, &.{ mcp_headers[0], mcp_headers[1], .{ "mcp-session-id", session }, .{ "mcp-protocol-version", "1999-01-01" } }, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}");
    try testing.expectEqualStrings("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32000,\"message\":\"Bad Request: Unsupported protocol version: 1999-01-01 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)\"},\"id\":null}", version.body);
}

test "reports MCP tools that cannot be served" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("ping", .{ .run = incur.handler(ok) });
    try cli.command("pong", .{ .mcp = .{ .name = "ping" }, .run = incur.handler(ok) });
    const stdio = try serve(a, cli, &.{"--mcp"}, .{ .stdin = initialize ++ "\n" });
    try testing.expectEqual(1, stdio.exit);
    try testing.expectEqualStrings("Duplicate MCP tool name: ping\n", stdio.stderr);
    const http = try fetch(a, cli, "POST", "http://localhost/mcp", mcp_headers, initialize);
    try testing.expectEqual(500, http.status);
}

fn failRead(_: *std.Io.Reader, _: *std.Io.Writer, _: std.Io.Limit) std.Io.Reader.StreamError!usize {
    return error.ReadFailed;
}

test "ends MCP stdio sessions on unreadable input" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("ping", .{ .run = incur.handler(ok) });
    var env: std.process.Environ.Map = .init(a);
    var out: std.Io.Writer.Allocating = .init(a);
    var buffer: [16]u8 = undefined;
    var stdin: std.Io.Reader = .{ .vtable = &.{ .stream = failRead }, .buffer = &buffer, .seek = 0, .end = 0 };
    try testing.expectEqual(0, try cli.serveWith(&.{"--mcp"}, .{ .io = testing.io, .env = &env, .stdout = &out.writer, .stderr = &out.writer, .stdin = &stdin, .tty = false }));
    try testing.expectEqualStrings("", out.written());
}

/// How the scripted MCP server answers.
const Scenario = enum { list_error, search_http_error, details_error, search_error_flag, sse_garbage, json_garbage };

/// The scenario `scriptedMcp` plays.
var scenario: Scenario = .list_error;

/// The discovery tools a progressive server lists.
const catalog = "[{\"name\":\"search_tools\"},{\"name\":\"get_tool_details\"},{\"name\":\"call_read_tool\"},{\"name\":\"call_write_tool\"}]";

/// A remote MCP server that fails as `scenario` says.
fn scriptedMcp(a: Allocator, _: *const incur.Process, request: *const incur.http.Request) !incur.http.Response {
    var message: []const u8 = undefined;
    const body = try incur.json.parse(a, request.body.?, &message);
    const method = body.get("method").?.string;
    const id = if (body.get("id")) |i| try incur.json.stringify(a, i) else "null";
    if (scenario == .sse_garbage) return incur.http.Response.text(a, "data: {bad\n\n", 200, "text/event-stream");
    if (scenario == .json_garbage) return incur.http.Response.text(a, "{bad", 200, "application/json");
    if (std.mem.eql(u8, method, "notifications/initialized")) return .{ .status = 202 };
    const result: []const u8 = if (std.mem.eql(u8, method, "initialize"))
        "{}"
    else if (std.mem.eql(u8, method, "tools/list")) switch (scenario) {
        .list_error => return incur.http.Response.text(a, try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":1,\"message\":\"list failed\"}}}}", .{id}), 200, "application/json"),
        else => "{\"tools\":" ++ catalog ++ "}",
    } else switch (scenario) {
        .search_http_error => return incur.http.Response.text(a, "", 500, null),
        .search_error_flag => "{\"isError\":1.5,\"content\":[{\"type\":\"text\",\"text\":\"search failed\"}]}",
        else => if (std.mem.find(u8, request.body.?, "search_tools") != null)
            "{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"tools\\\":[{\\\"name\\\":\\\"\\\"},{\\\"name\\\":\\\"t\\\"}]}\"}]}"
        else
            "{\"isError\":\"yes\",\"content\":[]}",
    };
    return incur.http.Response.text(a, try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}", .{ id, result }), 200, "application/json");
}

test "reports remote MCP servers that fail during discovery" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    for ([_]struct { Scenario, []const u8 }{
        .{ .list_error, "list failed" },
        .{ .search_http_error, "MCP HTTP 500" },
        .{ .details_error, "MCP tool failed: get_tool_details" },
        .{ .search_error_flag, "search failed" },
        .{ .sse_garbage, "Expected property name or '}' in JSON at position 1 (line 1 column 2)" },
        .{ .json_garbage, "Expected property name or '}' in JSON at position 1 (line 1 column 2)" },
    }) |case| {
        scenario = case[0];
        const cli = try incur.Cli.create(testing.allocator, "tool", .{});
        defer cli.destroy();
        try cli.mcpSource("remote", .{ .url = "http://remote.test/mcp", .fetch = .of(scriptedMcp) });
        const served = try serve(a, cli, &.{ "remote", "t" }, .{});
        try testing.expectEqual(1, served.exit);
        try testing.expect(std.mem.find(u8, served.stdout, case[1]) != null);
    }
}

/// An API that answers every request with its URL.
fn echoUrl(a: Allocator, _: *const incur.Process, request: *const incur.http.Request) !incur.http.Response {
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "url", .{ .string = request.url });
    return incur.http.Response.json(a, out.finish(), 200);
}

/// A network where every document is not JSON.
fn notJson(a: Allocator, _: *const incur.Process, _: *const incur.http.Request) !incur.http.Response {
    return incur.http.Response.text(a, "nope", 200, "text/plain");
}

const items_spec =
    \\{"openapi":"3.1.0","paths":{"/items":{"post":{"operationId":"create","parameters":[
    \\{"name":"x","in":"query","schema":{"type":"string"}},
    \\{"name":"limit","in":"query","schema":{"type":"string"}},
    \\{"name":"header-limit-2","in":"query","schema":{"type":"string"}},
    \\{"name":"limit","in":"header","schema":{"type":"string"}},
    \\{"name":"tags","in":"query","schema":{"type":"array","items":{"type":["string","null"]}}}],
    \\"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{
    \\"x":{"type":"integer"},"header-limit":{"type":"string"},
    \\"c":{"allOf":"kept","anyOf":[{"example":1},{"type":"string","examples":["a"]}],"oneOf":[{"example":2}],"items":{"example":3},"properties":{"p":{"example":4}}}}}}}}}}}}
;

test "generates OpenAPI commands from parsed documents" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var message: []const u8 = undefined;
    const spec = try incur.json.parse(a, items_spec, &message);
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .fetch = .{ .handler = .of(echoUrl) }, .openapi = .{ .value = spec }, .openapi_config = .{ .compact = true } });
    defer cli.destroy();
    // A body property replaces the query parameter with its name, and the header takes the
    // first free `header-` name.
    const schema = try serve(a, cli, &.{ "create", "--schema", "--format", "json" }, .{});
    try testing.expectEqualStrings(
        \\{
        \\  "options": {
        \\    "type": "object",
        \\    "properties": {
        \\      "x": {
        \\        "type": "integer",
        \\        "minimum": -9007199254740991,
        \\        "maximum": 9007199254740991
        \\      },
        \\      "limit": {
        \\        "type": "string"
        \\      },
        \\      "header-limit-2": {
        \\        "type": "string"
        \\      },
        \\      "tags": {
        \\        "type": "array",
        \\        "items": {
        \\          "anyOf": [
        \\            {
        \\              "type": "string"
        \\            },
        \\            {
        \\              "type": "null"
        \\            }
        \\          ]
        \\        }
        \\      },
        \\      "header-limit": {
        \\        "type": "string"
        \\      },
        \\      "c": {
        \\        "anyOf": [
        \\          {
        \\            "type": "string"
        \\          }
        \\        ]
        \\      },
        \\      "header-limit-3": {
        \\        "description": "limit header",
        \\        "type": "string"
        \\      }
        \\    },
        \\    "additionalProperties": false
        \\  }
        \\}
        \\
    , schema.stdout);
    const called = try fetch(a, cli, "POST", "http://localhost/create", &.{.{ "content-type", "application/json" }}, "{\"tags\":[\"a\",null]}");
    try testing.expect(std.mem.startsWith(u8, called.body, "{\"ok\":true,\"data\":{\"url\":\"http://localhost/items?tags=a%2C\"},\"meta\":{\"command\":\"create\",\"duration\":"));
}

test "reports OpenAPI documents that are not JSON" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const inline_spec = try incur.Cli.create(testing.allocator, "tool", .{ .fetch = .{ .handler = .of(echoUrl) }, .openapi = .{ .json = "{bad" } });
    defer inline_spec.destroy();
    try testing.expectEqualStrings("code: UNKNOWN\nmessage: \"Invalid OpenAPI document: Expected property name or '}' in JSON at position 1 (line 1 column 2)\"\n", (try serve(a, inline_spec, &.{"x"}, .{})).stdout);
    const fetched = try incur.Cli.create(testing.allocator, "tool", .{ .fetch = .{ .handler = .of(echoUrl) }, .openapi = .{ .url = "http://spec.test/openapi.json" } });
    defer fetched.destroy();
    try testing.expectEqualStrings("code: UNKNOWN\nmessage: \"Unexpected token 'o', \\\"nope\\\" is not valid JSON\"\n", (try serve(a, fetched, &.{"x"}, .{ .network = .of(notJson) })).stdout);
}

const LimitOptions = struct { limit: i64 = 1 };

fn limited(c: *Context(.{ .options = LimitOptions })) !Outcome {
    return c.ok(c.options.limit);
}

test "names OpenAPI operations as TypeScript does" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(struct { limit: ?[]const u8 = null }) });
    defer cli.destroy();
    try cli.command("end-", .{ .run = incur.handler(limited) });
    try cli.command("tail-__", .{ .run = incur.handler(ok) });
    const document = try fetch(a, cli, "GET", "http://localhost/openapi.json", &.{}, null);
    try testing.expect(std.mem.find(u8, document.body, "\"operationId\":\"postEnd-\"") != null);
    try testing.expect(std.mem.find(u8, document.body, "\"operationId\":\"postTail_\"") != null);
    // A global replaces the command option with its name.
    try testing.expect(std.mem.find(u8, document.body, "\"properties\":{\"limit\":{\"type\":\"string\"}}") != null);
}

/// An API that answers every request with its URL and JSON body.
fn echoBody(a: Allocator, _: *const incur.Process, request: *const incur.http.Request) !incur.http.Response {
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "url", .{ .string = request.url[std.mem.find(u8, request.url, "/check").?..] });
    var message: []const u8 = undefined;
    try out.put(a, "body", if (request.body) |b| try incur.json.parse(a, b, &message) else .null);
    return incur.http.Response.json(a, out.finish(), 200);
}

const check_spec =
    \\{"openapi":"3.1.0","paths":{"/check":{"post":{"operationId":"check","parameters":[
    \\{"name":"q","in":"query","schema":{"type":"boolean"}},
    \\{"name":"r","in":"query","schema":{"type":"number"}},
    \\{"name":"w","in":"query","schema":{"anyOf":[{"type":"boolean"},{"type":"string"}]}}],
    \\"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{
    \\"u":{"anyOf":[{"type":"string","minLength":2},{"type":"integer"}]},
    \\"e":{"enum":[1,"a"]},
    \\"l":{"const":"x"},
    \\"n":{"type":"null"},
    \\"m":{"type":"object","properties":{"a":{"type":"string"}},"additionalProperties":{"type":"string"}},
    \\"s":{"type":"string","format":"date","pattern":"^2"}}}}}}}}}}
;

test "validates OpenAPI bodies as Zod's JSON Schema conversion does" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .fetch = .{ .handler = .of(echoBody) }, .openapi = .{ .json = check_spec } });
    defer cli.destroy();
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, (try serve(a, cli, &.{ "check", "--schema", "--format", "json" }, .{})).stdout);
    try out.append(a, '\n');
    try out.appendSlice(a, (try serve(a, cli, &.{ "check", "--u", "a", "--l", "y", "--format", "json" }, .{})).stdout);
    try out.append(a, '\n');
    for ([_][]const u8{
        "{\"q\":\"x\",\"r\":[],\"w\":\"s\",\"m\":{\"a\":\"b\",\"extra\":\"c\"},\"e\":1,\"l\":\"x\",\"n\":null,\"s\":\"2020-01-01\",\"u\":5}",
        "{\"q\":0.5,\"r\":[\"5\"]}",
        "{\"r\":[1,2]}",
        "{\"r\":{}}",
        "{\"u\":\"a\",\"e\":2,\"n\":1}",
    }) |body| {
        const response = try fetch(a, cli, "POST", "http://localhost/check", &.{.{ "content-type", "application/json" }}, body);
        const at = std.mem.find(u8, response.body, "\"duration\":\"").? + "\"duration\":\"".len;
        const end = std.mem.findScalarPos(u8, response.body, at, '"').?;
        try out.print(a, "{s}<d>{s}\n", .{ response.body[0..at], response.body[end..] });
    }
    try testing.expectEqualStrings(check_expected, out.items);
}

/// The TypeScript reference output of the test above.
const check_expected =
    \\{
    \\  "options": {
    \\    "type": "object",
    \\    "properties": {
    \\      "q": {
    \\        "type": "boolean"
    \\      },
    \\      "r": {
    \\        "type": "number"
    \\      },
    \\      "w": {
    \\        "type": "boolean"
    \\      },
    \\      "u": {
    \\        "anyOf": [
    \\          {
    \\            "type": "string",
    \\            "minLength": 2
    \\          },
    \\          {
    \\            "type": "integer",
    \\            "minimum": -9007199254740991,
    \\            "maximum": 9007199254740991
    \\          }
    \\        ]
    \\      },
    \\      "e": {
    \\        "anyOf": [
    \\          {
    \\            "type": "number",
    \\            "const": 1
    \\          },
    \\          {
    \\            "type": "string",
    \\            "const": "a"
    \\          }
    \\        ]
    \\      },
    \\      "l": {
    \\        "type": "string",
    \\        "const": "x"
    \\      },
    \\      "n": {
    \\        "type": "null"
    \\      },
    \\      "m": {
    \\        "type": "object",
    \\        "properties": {
    \\          "a": {
    \\            "type": "string"
    \\          }
    \\        },
    \\        "additionalProperties": {
    \\          "type": "string"
    \\        }
    \\      },
    \\      "s": {
    \\        "type": "string",
    \\        "allOf": [
    \\          {
    \\            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$"
    \\          },
    \\          {
    \\            "pattern": "^2"
    \\          }
    \\        ]
    \\      }
    \\    },
    \\    "additionalProperties": false
    \\  }
    \\}
    \\
    \\{
    \\  "code": "VALIDATION_ERROR",
    \\  "message": "Too small: expected string to have >=2 characters; Invalid input: expected \"x\"\n\nDetails: [\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"inclusive\": true,\n    \"path\": [\n      \"u\"\n    ],\n    \"message\": \"Too small: expected string to have >=2 characters\"\n  },\n  {\n    \"code\": \"invalid_value\",\n    \"values\": [\n      \"x\"\n    ],\n    \"path\": [\n      \"l\"\n    ],\n    \"message\": \"Invalid input: expected \\\"x\\\"\"\n  }\n]",
    \\  "fieldErrors": [
    \\    {
    \\      "code": "too_small",
    \\      "missing": false,
    \\      "path": "u",
    \\      "expected": "",
    \\      "received": "",
    \\      "message": "Too small: expected string to have >=2 characters"
    \\    },
    \\    {
    \\      "code": "invalid_value",
    \\      "missing": false,
    \\      "path": "l",
    \\      "expected": "",
    \\      "received": "",
    \\      "message": "Invalid input: expected \"x\""
    \\    }
    \\  ]
    \\}
    \\
    \\{"ok":true,"data":{"url":"/check?q=true&r=0&w=true","body":{"u":5,"e":1,"l":"x","n":null,"m":{"a":"b","extra":"c"},"s":"2020-01-01"}},"meta":{"command":"check","duration":"<d>"}}
    \\{"ok":true,"data":{"url":"/check?q=true&r=5","body":null},"meta":{"command":"check","duration":"<d>"}}
    \\{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"Invalid input: expected number, received NaN\n\nDetails: [\n  {\n    \"expected\": \"number\",\n    \"code\": \"invalid_type\",\n    \"received\": \"NaN\",\n    \"path\": [\n      \"r\"\n    ],\n    \"message\": \"Invalid input: expected number, received NaN\"\n  }\n]","fieldErrors":[{"code":"invalid_type","missing":false,"path":"r","expected":"number","received":"NaN","message":"Invalid input: expected number, received NaN"}]},"meta":{"command":"check","duration":"<d>"}}
    \\{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"Invalid input: expected number, received NaN\n\nDetails: [\n  {\n    \"expected\": \"number\",\n    \"code\": \"invalid_type\",\n    \"received\": \"NaN\",\n    \"path\": [\n      \"r\"\n    ],\n    \"message\": \"Invalid input: expected number, received NaN\"\n  }\n]","fieldErrors":[{"code":"invalid_type","missing":false,"path":"r","expected":"number","received":"NaN","message":"Invalid input: expected number, received NaN"}]},"meta":{"command":"check","duration":"<d>"}}
    \\{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"Too small: expected string to have >=2 characters; Invalid input; Invalid input: expected null, received number\n\nDetails: [\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"inclusive\": true,\n    \"path\": [\n      \"u\"\n    ],\n    \"message\": \"Too small: expected string to have >=2 characters\"\n  },\n  {\n    \"code\": \"invalid_union\",\n    \"errors\": [\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            1\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected 1\"\n        }\n      ],\n      [\n        {\n          \"code\": \"invalid_value\",\n          \"values\": [\n            \"a\"\n          ],\n          \"path\": [],\n          \"message\": \"Invalid input: expected \\\"a\\\"\"\n        }\n      ]\n    ],\n    \"path\": [\n      \"e\"\n    ],\n    \"message\": \"Invalid input\"\n  },\n  {\n    \"expected\": \"null\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"n\"\n    ],\n    \"message\": \"Invalid input: expected null, received number\"\n  }\n]","fieldErrors":[{"code":"too_small","missing":false,"path":"u","expected":"","received":"","message":"Too small: expected string to have >=2 characters"},{"code":"invalid_union","missing":false,"path":"e","expected":"","received":"","message":"Invalid input"},{"code":"invalid_type","missing":false,"path":"n","expected":"null","received":"","message":"Invalid input: expected null, received number"}]},"meta":{"command":"check","duration":"<d>"}}
    \\
;

/// Patterns with a matching and a failing value.
const patterns = [_][3][]const u8{
    .{ "a{x}", "a{x}", "ax" },
    .{ "^a{2,}$", "aaa", "a" },
    .{ "^a{2$", "a{2", "aa" },
    .{ "^[\\b]$", "\x08", "b" },
    .{ "a\\B", "ab", "a b" },
    .{ "\\bfoo\\b", "a foo b", "afoob" },
    .{ "^\\u0041\\x42$", "AB", "ab" },
    .{ "^[\\x41\\n]+$", "A\nA", "B" },
    .{ "^[\\D]+$", "ab", "a1" },
    .{ "^[\\d]+$", "12", "1a" },
    .{ "^a+?b$", "aab", "aa" },
    .{ "^a.c$", "abc", "a\nc" },
    .{ "^(?:x|y)z*$", "yzz", "zz" },
};

test "matches patterns as JavaScript regular expressions do" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    var properties: incur.ObjectBuilder = .{};
    for (patterns, 0..) |p, i| {
        var property: incur.ObjectBuilder = .{};
        try property.put(a, "type", .{ .string = "string" });
        try property.put(a, "pattern", .{ .string = p[0] });
        try properties.put(a, try std.fmt.allocPrint(a, "p{d}", .{i}), property.finish());
    }
    const spec = try std.fmt.allocPrint(a, "{{\"openapi\":\"3.1.0\",\"paths\":{{\"/check\":{{\"post\":{{\"operationId\":\"check\",\"requestBody\":{{\"content\":{{\"application/json\":{{\"schema\":{{\"type\":\"object\",\"properties\":{s}}}}}}}}}}}}}}}}}", .{try incur.json.stringify(a, properties.finish())});
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .fetch = .{ .handler = .of(echoBody) }, .openapi = .{ .json = spec } });
    defer cli.destroy();
    for ([_][]const u8{ "{\"p0\":\"a{x}\",\"p1\":\"aaa\",\"p2\":\"a{2\",\"p3\":\"\\b\",\"p4\":\"ab\",\"p5\":\"a foo b\",\"p6\":\"AB\",\"p7\":\"A\\nA\",\"p8\":\"ab\",\"p9\":\"12\",\"p10\":\"aab\",\"p11\":\"abc\",\"p12\":\"yzz\"}", "[\"p0: Invalid string: must match pattern /a{x}/\",\"p1: Invalid string: must match pattern /^a{2,}$/\",\"p2: Invalid string: must match pattern /^a{2$/\",\"p3: Invalid string: must match pattern /^[\\\\b]$/\",\"p4: Invalid string: must match pattern /a\\\\B/\",\"p5: Invalid string: must match pattern /\\\\bfoo\\\\b/\",\"p6: Invalid string: must match pattern /^\\\\u0041\\\\x42$/\",\"p7: Invalid string: must match pattern /^[\\\\x41\\\\n]+$/\",\"p8: Invalid string: must match pattern /^[\\\\D]+$/\",\"p9: Invalid string: must match pattern /^[\\\\d]+$/\",\"p10: Invalid string: must match pattern /^a+?b$/\",\"p11: Invalid string: must match pattern /^a.c$/\",\"p12: Invalid string: must match pattern /^(?:x|y)z*$/\"]" }, 1..) |expected, k| {
        var body: incur.ObjectBuilder = .{};
        for (patterns, 0..) |p, i| try body.put(a, try std.fmt.allocPrint(a, "p{d}", .{i}), .{ .string = p[k] });
        const response = try fetch(a, cli, "POST", "http://localhost/check", &.{.{ "content-type", "application/json" }}, try incur.json.stringify(a, body.finish()));
        var message: []const u8 = undefined;
        const parsed = try incur.json.parse(a, response.body, &message);
        const summary: Value = if (parsed.get("ok").?.bool) parsed.get("data").?.get("body").? else summary: {
            const field_errors = parsed.get("error").?.get("fieldErrors").?.array;
            const items = try a.alloc(Value, field_errors.len);
            for (field_errors, items) |e, *slot| slot.* = .{ .string = try std.fmt.allocPrint(a, "{s}: {s}", .{ e.get("path").?.string, e.get("message").?.string }) };
            break :summary .{ .array = items };
        };
        try testing.expectEqualStrings(expected, try incur.json.stringify(a, summary));
    }
}

const EchoOptions = struct { x: []const u8 = "" };

fn echoOption(c: *Context(.{ .options = EchoOptions })) !Outcome {
    return c.ok(c.options.x);
}

/// Accepts `count` connections and answers each with the handler.
fn serveConnections(process: *const incur.Process, server: *std.Io.net.Server, handler: incur.http.Handler, count: usize) !void {
    for (0..count) |_| {
        const stream = try server.accept(testing.io);
        defer stream.close(testing.io);
        var read_buffer: [4096]u8 = undefined;
        var write_buffer: [4096]u8 = undefined;
        var reader = stream.reader(testing.io, &read_buffer);
        var writer = stream.writer(testing.io, &write_buffer);
        var http: std.http.Server = .init(&reader.interface, &writer.interface);
        try incur.http.serveConnection(testing.allocator, process, &http, handler);
    }
}

test "serves the CLI over HTTP and calls hosted APIs with std.http" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const upstream = try incur.Cli.create(testing.allocator, "upstream", .{});
    defer upstream.destroy();
    try upstream.command("status", .{ .run = incur.handler(ok) });
    try upstream.command("echo", .{ .run = incur.handler(echoOption) });

    const address: std.Io.net.IpAddress = try .parse("127.0.0.1", 0);
    var server = try address.listen(testing.io, .{ .reuse_address = true });
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{server.socket.address.getPort()});
    var env: std.process.Environ.Map = .init(a);
    var log: std.Io.Writer.Discarding = .init(&.{});
    const process: incur.Process = .{ .io = testing.io, .env = &env, .stdout = &log.writer, .stderr = &log.writer, .tty = false };
    var serving = try testing.io.concurrent(serveConnections, .{ &process, &server, upstream.handler(), 3 });
    defer serving.cancel(testing.io) catch {};

    const client = try incur.Cli.create(testing.allocator, "client", .{ .fetch = incur.fetch.fromRequest(url, &.{.{ .name = "x-api", .value = "k" }}) });
    defer client.destroy();
    // Root fetch prints the upstream CLI's response envelope.
    try testing.expect(std.mem.startsWith(u8, (try serve(a, client, &.{"status"}, .{})).stdout, "ok: true\ndata:\n  ok: true\nmeta:\n  command: status\n"));
    // Query parameters replace those in the path, encoded as forms are.
    try testing.expect(std.mem.startsWith(u8, (try serve(a, client, &.{ "echo?x=1&x=2", "--x", "a b%" }, .{})).stdout, "ok: true\ndata: a b%\n"));
    try testing.expect(std.mem.startsWith(u8, (try serve(a, client, &.{ "-X", "POST", "-d", "{\"x\":\"posted\"}", "echo" }, .{})).stdout, "ok: true\ndata: posted\n"));
    try serving.await(testing.io);
    // Methods std.http does not know and closed ports fail like unreachable servers.
    try testing.expectEqualStrings("code: UNKNOWN\nmessage: fetch failed\n", (try serve(a, client, &.{ "-X", "BREW", "echo" }, .{})).stdout);
    server.deinit(testing.io);
    try testing.expectEqualStrings("code: UNKNOWN\nmessage: fetch failed\n", (try serve(a, client, &.{"status"}, .{})).stdout);
}

fn unreachableApi(_: Allocator, _: *const incur.Process, _: *const incur.http.Request) !incur.http.Response {
    return error.FetchFailed;
}

const GatewayGlobals = struct { limit: ?i64 = null };
const GatewayEnv = struct { TOKEN: []const u8 };

test "runs fetch gateways with globals, env, manifests, and completions" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(GatewayGlobals), .env = incur.schema(GatewayEnv) });
    defer cli.destroy();
    try cli.gateway("api", .{ .description = "Upstream API", .fetch = .{ .handler = .of(echoUrl) } });
    try cli.gateway("down", .{ .fetch = .{ .handler = .of(unreachableApi) } });
    const env: []const [2][]const u8 = &.{.{ "TOKEN", "t" }};
    try testing.expectEqualStrings("url: \"http://localhost/users\"\n", (try serve(a, cli, &.{ "api", "users", "--limit", "2" }, .{ .env = env })).stdout);
    try testing.expectEqualStrings("url: \"http://localhost/a%20b\"\n", (try serve(a, cli, &.{ "api", "a b" }, .{ .env = env })).stdout);
    try testing.expectEqual(1, (try serve(a, cli, &.{ "api", "users", "--limit", "x" }, .{ .env = env })).exit);
    try testing.expectEqual(1, (try serve(a, cli, &.{ "api", "users" }, .{})).exit);
    const manifest = try serve(a, cli, &.{ "--llms", "--format", "json" }, .{});
    try testing.expect(std.mem.find(u8, manifest.stdout, "{\n      \"name\": \"api\",\n      \"description\": \"Upstream API\"\n    }") != null);
    const completed = try serve(a, cli, &.{ "--", "tool", "a" }, .{ .env = &.{.{ "COMPLETE", "bash" }} });
    try testing.expectEqualStrings("api", completed.stdout);
    // A gateway whose handler fails answers HTTP requests with a 500 envelope.
    const failed = try fetch(a, cli, "GET", "http://localhost/down/x", &.{}, null);
    try testing.expectEqual(500, failed.status);
}

/// Mounts generated groups and loads them, for the allocation-failure sweep.
fn mountsSources(gpa: Allocator) !void {
    const cli = try incur.Cli.create(gpa, "tool", .{});
    defer cli.destroy();
    try cli.gateway("api", .{ .fetch = .{ .handler = .of(echoUrl) }, .openapi = .{ .json = items_spec }, .openapi_config = .{ .mode = .namespace } });
    try cli.mcpSource("remote", .{ .url = "http://remote.test/mcp", .fetch = .of(scriptedMcp) });
    var env: std.process.Environ.Map = .init(gpa);
    defer env.deinit();
    var buf: [64]u8 = undefined;
    var out: std.Io.Writer.Discarding = .init(&buf);
    _ = try cli.serveWith(&.{ "api", "items", "--help" }, .{ .io = testing.io, .env = &env, .stdout = &out.writer, .stderr = &out.writer, .tty = false });
}

/// Mounts a remote MCP group on a new CLI, for the allocation-failure sweep.
fn mountsMcpSource(gpa: Allocator) !void {
    const cli = try incur.Cli.create(gpa, "tool", .{});
    defer cli.destroy();
    try cli.mcpSource("remote", .{ .url = "http://remote.test/mcp", .fetch = .of(scriptedMcp) });
}

test "propagates allocation failures while mounting generated groups" {
    scenario = .list_error;
    try testing.checkAllAllocationFailures(testing.allocator, mountsSources, .{});
    try testing.checkAllAllocationFailures(testing.allocator, mountsMcpSource, .{});
}

test "accepts any value for unsupported JSON Schema types" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    // TypeScript's `z.fromJSONSchema` throws for unknown types; this port accepts anything.
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .fetch = .{ .handler = .of(echoBody) }, .openapi = .{ .json = "{\"paths\":{\"/check\":{\"post\":{\"operationId\":\"check\",\"requestBody\":{\"content\":{\"application/json\":{\"schema\":{\"type\":\"object\",\"properties\":{\"x\":{\"type\":\"bogus\"}}}}}}}}}}" } });
    defer cli.destroy();
    const response = try fetch(a, cli, "POST", "http://localhost/check", &.{.{ "content-type", "application/json" }}, "{\"x\":[1]}");
    try testing.expect(std.mem.startsWith(u8, response.body, "{\"ok\":true,\"data\":{\"url\":\"/check\",\"body\":{\"x\":[1]}}"));
}
