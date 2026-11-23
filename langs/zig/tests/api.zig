//! Zig-only behavior that the differential suite cannot compare with TypeScript: built-ins this
//! port does not implement, typed handler and middleware failures, the struct schema syntax,
//! allocation failures, and inputs the reference treats differently by design.

const std = @import("std");
const incur = @import("incur");

const testing = std.testing;
const Allocator = std.mem.Allocator;
const Context = incur.Context;
const Outcome = incur.Outcome;
const Value = incur.Value;

/// The exit code and the combined stdout and stderr of one invocation.
const Served = struct {
    exit: u8,
    output: []const u8,

    fn deinit(s: Served) void {
        testing.allocator.free(s.output);
    }
};

/// Serves `argv` without a terminal and returns the exit code and output.
fn serve(cli: *const incur.Cli, argv: []const []const u8, vars: []const [2][]const u8) !Served {
    var env: std.process.Environ.Map = .init(testing.allocator);
    defer env.deinit();
    for (vars) |v| try env.put(v[0], v[1]);
    var stdout: std.Io.Writer.Allocating = .init(testing.allocator);
    defer stdout.deinit();
    var stderr: std.Io.Writer.Allocating = .init(testing.allocator);
    defer stderr.deinit();
    const exit = try cli.serveWith(argv, .{ .io = testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stderr.writer, .tty = false });
    return .{ .exit = exit, .output = try std.mem.concat(testing.allocator, u8, &.{ stdout.written(), stderr.written() }) };
}

/// Asserts the exit code and output of one invocation.
fn expectServe(cli: *const incur.Cli, argv: []const []const u8, exit: u8, output: []const u8) !void {
    const served = try serve(cli, argv, &.{});
    defer served.deinit();
    try testing.expectEqualStrings(output, served.output);
    try testing.expectEqual(exit, served.exit);
}

fn one(c: *Context(.{})) !Outcome {
    return c.ok(1);
}

test "reports built-ins this port does not implement" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .version = "1.0.0" });
    defer cli.destroy();
    try expectServe(cli, &.{"--mcp"}, 1, "code: UNSUPPORTED\nmessage: '--mcp' is not supported by the Zig port of incur yet.\n");
    try expectServe(cli, &.{ "skills", "add" }, 1, "code: UNSUPPORTED\nmessage: 'skills add' is not supported by the Zig port of incur yet.\n");
    try expectServe(cli, &.{ "mcp", "add" }, 1, "code: UNSUPPORTED\nmessage: 'mcp add' is not supported by the Zig port of incur yet.\n");
}

test "runs commands without handlers and replaces commands registered twice" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("noop", .{ .description = "First" });
    try cli.command("other", .{ .run = incur.handler(one) });
    try cli.command("noop", .{ .description = "Does nothing" });
    try expectServe(cli, &.{"noop"}, 0, "");
    const served = try serve(cli, &.{"--llms"}, &.{});
    defer served.deinit();
    // The second registration keeps the first one's position.
    try testing.expect(std.mem.find(u8, served.output, "| `tool noop` | Does nothing |\n| `tool other` |") != null);
}

fn failsWithZigError(_: *Context(.{})) !Outcome {
    return error.DiskFull;
}

fn rejectsWithZigError(_: *incur.MiddlewareContext, _: incur.Next) !void {
    return error.AccessDenied;
}

test "reports Zig errors from handlers and middleware as UNKNOWN errors" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("disk", .{ .run = incur.handler(failsWithZigError) });
    try cli.command("guarded", .{ .middleware = &.{rejectsWithZigError}, .run = incur.handler(one) });
    try expectServe(cli, &.{"disk"}, 1, "code: UNKNOWN\nmessage: DiskFull\n");
    try expectServe(cli, &.{"guarded"}, 1, "code: UNKNOWN\nmessage: AccessDenied\n");
}

test "rejects global options that collide with built-in flags" {
    const Format = struct { format: ?[]const u8 = null };
    const Help = struct {
        verbose: ?bool = null,
        pub const incur = .{ .fields = .{ .verbose = .{ .alias = 'h' } } };
    };
    const Config = struct { config: ?[]const u8 = null };
    const NoConfig = struct {
        no_config: ?bool = null,
        pub const incur = .{ .rename_all = .camel_case };
    };
    try testing.expectError(error.GlobalOptionConflict, incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(Format) }));
    try testing.expectError(error.GlobalOptionConflict, incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(Help) }));
    const config: incur.Config = .{ .flag = "config" };
    try testing.expectError(error.GlobalOptionConflict, incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(Config), .config = config }));
    try testing.expectError(error.GlobalOptionConflict, incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(NoConfig), .config = config }));
    const ok = try incur.Cli.create(testing.allocator, "tool", .{ .globals = incur.schema(NoConfig), .config = .{ .flag = "" } });
    ok.destroy();
}

/// Writes a temporary config file and returns its absolute path.
fn tempConfig(dir: std.testing.TmpDir, name: []const u8, data: []const u8) ![:0]const u8 {
    try dir.dir.writeFile(testing.io, .{ .sub_path = name, .data = data });
    return dir.dir.realPathFileAlloc(testing.io, name, testing.allocator);
}

test "reports unreadable config files with the Zig error name" {
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const path = try dir.dir.realPathFileAlloc(testing.io, ".", testing.allocator);
    defer testing.allocator.free(path);
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .config = .{ .files = &.{path} } });
    defer cli.destroy();
    try cli.command("echo", .{ .run = incur.handler(one) });
    // TypeScript reports Node's `fs` message, which varies by Node version.
    try expectServe(cli, &.{"echo"}, 1, "code: UNKNOWN\nmessage: IsDir\n");
}

test "accepts config numbers beyond the double range as V8 does" {
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const path = try tempConfig(dir, "tool.json", "{\"commands\": {\"echo\": {\"options\": {\"n\": 1e400}}}}");
    defer testing.allocator.free(path);
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .config = .{ .files = &.{path} } });
    defer cli.destroy();
    try cli.command("echo", .{ .run = incur.handler(one) });
    try expectServe(cli, &.{"echo"}, 1, "code: UNKNOWN\nmessage: \"Unknown config option: n\"\n");
}

test "resolves relative config paths when the working directory is gone" {
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const previous = try std.process.currentPathAlloc(testing.io, testing.allocator);
    defer testing.allocator.free(previous);
    const gone = try dir.dir.realPathFileAlloc(testing.io, ".", testing.allocator);
    defer testing.allocator.free(gone);
    try dir.dir.createDir(testing.io, "cwd", .default_dir);
    const cwd = try std.fs.path.join(testing.allocator, &.{ gone, "cwd" });
    defer testing.allocator.free(cwd);
    try std.process.setCurrentPath(testing.io, cwd);
    defer std.process.setCurrentPath(testing.io, previous) catch {};
    try dir.dir.deleteDir(testing.io, "cwd");
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .config = .{} });
    defer cli.destroy();
    try cli.command("echo", .{ .run = incur.handler(one) });
    try expectServe(cli, &.{"echo"}, 0, "1\n");
}

const Level = enum { low, high };

const Nested = struct {
    label: []const u8,
    weight: f32 = 1.5,
};

const Typed = struct {
    dry_run: bool = false,
    max_count: i32 = 3,
    level: Level = .low,
    names: []const []const u8 = &.{ "a", "b" },
    nested: ?Nested = null,
    extra: Value,
    target: ?[]const u8 = null,

    pub const incur = .{
        .rename_all = .kebab_case,
        .fields = .{
            .max_count = .{ .rename = "maxCount", .min = 1, .description = "Most items" },
            .names = .{ .max = 3 },
            .target = .{ .alias = 'T', .deprecated = true },
        },
    };
};

const Pascal = struct {
    first_name: []const u8,
    pub const incur = .{ .rename_all = .pascal_case };
};

test "derives JSON Schema from struct fields and metadata" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const derived = try incur.json.stringify(a, try incur.schemas.jsonSchema(a, incur.schema(Typed)));
    try testing.expectEqualStrings(
        \\{"type":"object","properties":{"dry-run":{"default":false,"type":"boolean"},"maxCount":{"default":3,"description":"Most items","type":"integer","minimum":1,"maximum":9007199254740991},"level":{"default":"low","type":"string","enum":["low","high"]},"names":{"default":["a","b"],"maxItems":3,"type":"array","items":{"type":"string"}},"nested":{"type":"object","properties":{"label":{"type":"string"},"weight":{"default":1.5,"type":"number"}},"required":["label","weight"],"additionalProperties":false},"extra":{},"target":{"deprecated":true,"type":"string"}},"required":["dry-run","maxCount","level","names","extra"],"additionalProperties":false}
    , derived);
    const pascal = try incur.json.stringify(a, try incur.schemas.jsonSchema(a, incur.schema(Pascal)));
    try testing.expectEqualStrings("{\"type\":\"object\",\"properties\":{\"FirstName\":{\"type\":\"string\"}},\"required\":[\"FirstName\"],\"additionalProperties\":false}", pascal);
}

fn typed(c: *Context(.{ .options = Typed })) !Outcome {
    return c.ok(.{
        .options = c.options,
        .tuple = .{ c.options.level, .literal, @as(?u8, null), [_]u8{ 'h', 'i' }, [_]i64{ 1, 2 } },
        .pointer = &c.options.max_count,
        .float = @as(f32, 0.5),
    });
}

test "decodes typed options and encodes Zig values" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("typed", .{ .run = incur.handler(typed) });
    try expectServe(cli, &.{ "typed", "--dry-run", "--maxCount", "2", "--level", "high", "--names", "x", "--target", "t", "--format", "json" }, 0,
        \\{
        \\  "options": {
        \\    "dry-run": true,
        \\    "maxCount": 2,
        \\    "level": "high",
        \\    "names": [
        \\      "x"
        \\    ],
        \\    "nested": null,
        \\    "extra": null,
        \\    "target": "t"
        \\  },
        \\  "tuple": [
        \\    "high",
        \\    "literal",
        \\    null,
        \\    "hi",
        \\    [
        \\      1,
        \\      2
        \\    ]
        \\  ],
        \\  "pointer": 2,
        \\  "float": 0.5
        \\}
        \\
    );
}

/// Counts down, then fails with a Zig error.
const Countdown = struct {
    left: u8,

    pub fn next(it: *Countdown, a: Allocator) anyerror!?incur.Chunk {
        if (it.left == 0) return error.Exhausted;
        it.left -= 1;
        return .{ .data = try incur.encode(a, .{ .left = it.left }) };
    }
};

fn countdown(c: *Context(.{})) !Outcome {
    const it = try c.allocator.create(Countdown);
    it.* = .{ .left = 2 };
    return c.stream(it);
}

test "streams from custom iterators and reports their Zig errors" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("countdown", .{ .run = incur.handler(countdown) });
    try expectServe(cli, &.{ "countdown", "--format", "jsonl" }, 1,
        \\{"type":"chunk","data":{"left":1}}
        \\{"type":"chunk","data":{"left":0}}
        \\{"type":"error","ok":false,"error":{"code":"UNKNOWN","message":"Exhausted"}}
        \\
    );
}

const Globals = struct {
    level: i64 = 1,
};

fn readGlobals(c: *Context(.{})) !Outcome {
    const globals = try c.globalsAs(Globals);
    return c.ok(.{ .level = globals.level, .name = c.name, .version = c.version, .agent = c.agent, .format = c.format, .explicit = c.format_explicit, .display = c.display_name });
}

test "exposes globals and invocation details to handlers" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .version = "2.0.0", .globals = incur.schema(Globals) });
    defer cli.destroy();
    try cli.command("read", .{ .run = incur.handler(readGlobals) });
    try expectServe(cli, &.{ "read", "--level", "4", "--json" }, 0,
        \\{
        \\  "level": 4,
        \\  "name": "tool",
        \\  "version": "2.0.0",
        \\  "agent": true,
        \\  "format": "json",
        \\  "explicit": true,
        \\  "display": "tool"
        \\}
        \\
    );
}

fn loadsConfig(load: *incur.Config.Load, path: ?[]const u8) !?Value {
    var message: []const u8 = undefined;
    _ = path;
    return try incur.json.parse(load.allocator, "{\"commands\":{\"greet\":{\"options\":{\"name\":\"cfg\"}}}}", &message);
}

const GreetOptions = struct { name: []const u8 = "world" };

fn greet(c: *Context(.{ .options = GreetOptions })) !Outcome {
    if (std.mem.eql(u8, c.options.name, "fail")) return c.fail(.{ .code = "BAD_NAME", .message = "bad name", .hint = "Pick another." });
    return c.ok(try std.fmt.allocPrint(c.allocator, "hello {s}", .{c.options.name}));
}

fn mark(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try c.set("seen", .{ .bool = true });
    try next.run(c);
}

/// Serves a few invocations that touch config loading, middleware, validation, and streams.
fn serveSeveral(gpa: Allocator, dir: [:0]const u8) !void {
    const cli = try incur.Cli.create(gpa, "tool", .{ .config = .{ .files = &.{dir} }, .env = incur.schema(struct { HOME: ?[]const u8 = null }) });
    defer cli.destroy();
    try cli.use(mark);
    try cli.command("greet", .{ .description = "Greet", .run = incur.handler(greet) });
    try cli.command("count", .{ .run = incur.handler(countdown) });
    const loaded = try incur.Cli.create(gpa, "loaded", .{ .config = .{ .loader = loadsConfig } });
    {
        errdefer loaded.destroy();
        try loaded.command("greet", .{ .run = incur.handler(greet) });
        try cli.group(loaded);
    }
    var env: std.process.Environ.Map = .init(gpa);
    defer env.deinit();
    for ([_][]const []const u8{
        &.{"greet"},                    &.{ "greet", "--name", "fail" },   &.{ "greet", "--nope" },
        &.{ "loaded", "greet" },        &.{ "count", "--format", "yaml" }, &.{ "gret", "--full-output" },
        &.{ "greet", "--token-count" }, &.{"--llms-full"},                 &.{ "greet", "--help" },
        &.{ "greet", "--schema" },      &.{ "completions", "bash" },
    }) |argv| {
        // Output goes to a writer that does not allocate, so every failure reaches the library.
        var buf: [64]u8 = undefined;
        var out: std.Io.Writer.Discarding = .init(&buf);
        _ = try cli.serveWith(argv, .{ .io = testing.io, .env = &env, .stdout = &out.writer, .stderr = &out.writer, .tty = false });
    }
}

test "propagates allocation failures without leaking" {
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    // Padding makes reading the file need its own arena block, so that allocation can fail too.
    const padding: [8192]u8 = @splat(' ');
    const path = try tempConfig(dir, "tool.json", "{\"commands\": {\"greet\": {\"options\": {\"name\": \"file\"}}}}" ++ padding);
    defer testing.allocator.free(path);
    try testing.checkAllAllocationFailures(testing.allocator, serveSeveral, .{path});
}

fn smile(c: *Context(.{})) !Outcome {
    return c.ok(.{ .face = "smile 😀", .line = "a: 😀" });
}

test "measures text outside the Basic Multilingual Plane in UTF-16 units" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("smile", .{ .run = incur.handler(smile) });
    try expectServe(cli, &.{ "smile", "--format", "yaml" }, 0, "face: smile 😀\nline: \"a: 😀\"\n");
}

test "keeps manifest entries with the same name in registration order" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    const group = try incur.Cli.create(testing.allocator, "g", .{});
    {
        errdefer group.destroy();
        try group.command("x", .{ .description = "Grouped" });
        try cli.group(group);
    }
    try cli.command("g x", .{ .description = "Spaced" });
    const served = try serve(cli, &.{"--llms"}, &.{});
    defer served.deinit();
    try testing.expect(std.mem.find(u8, served.output, "| `tool g x` | Grouped |\n| `tool g x` | Spaced |\n") != null);
}
