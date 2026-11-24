//! Zig-only behavior that the differential suite cannot compare with TypeScript: typed handler
//! and middleware failures, the struct schema syntax, allocation failures, the production
//! network and HTTP server paths, and inputs the reference treats differently by design.

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
fn serve(cli: *incur.Cli, argv: []const []const u8, vars: []const [2][]const u8) !Served {
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
fn expectServe(cli: *incur.Cli, argv: []const []const u8, exit: u8, output: []const u8) !void {
    const served = try serve(cli, argv, &.{});
    defer served.deinit();
    try testing.expectEqualStrings(output, served.output);
    try testing.expectEqual(exit, served.exit);
}

fn one(c: *Context(.{})) !Outcome {
    return c.ok(1);
}

test "splits skill files that show the CLI name or a command in its place" {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const commands: []const incur.skill.CommandInfo = &.{.{ .name = "status", .description = "Show status" }};
    const plain = try incur.skill.split(a, "kit", commands, &.{}, 1);
    try testing.expect(std.mem.indexOf(u8, plain[0].content, "\n# kit status\n") != null);
    const run = try incur.skill.splitAs(a, "kit", "bunx @acme/kit", commands, &.{}, 1);
    try testing.expectEqualStrings("kit-status", run[0].name);
    try testing.expect(std.mem.indexOf(u8, run[0].content, "\n# bunx @acme/kit status\n") != null);
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

    pub fn next(it: *Countdown, _: std.Io, a: Allocator) !?incur.Chunk {
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

fn allocatedBanner(_: std.Io, a: Allocator) !?[]const u8 {
    return try std.fmt.allocPrint(a, "tool {d}", .{1});
}

/// Serves a few invocations that touch config loading, middleware, validation, and streams.
fn serveSeveral(gpa: Allocator, dir: [:0]const u8) !void {
    const cli = try incur.Cli.create(gpa, "tool", .{
        .banner = .{ .render = allocatedBanner },
        .config = .{ .files = &.{dir} },
        .env = incur.schema(struct { HOME: ?[]const u8 = null }),
    });
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
        &.{ "greet", "--schema" },      &.{ "completions", "bash" },       &.{},
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

const DataArgs = struct { json: []const u8 };

fn parseData(c: *Context(.{ .args = DataArgs })) !Outcome {
    var message: []const u8 = undefined;
    return c.ok(incur.json.parse(c.allocator, c.args.json, &message) catch |err| switch (err) {
        error.SyntaxError => return c.fail(.{ .message = message }),
        else => |e| return e,
    });
}

fn zigIntegers(c: *Context(.{})) !Outcome {
    return c.ok(.{
        .u64_max = std.math.maxInt(u64),
        .i64_min = @as(i64, std.math.minInt(i64)),
        .u128_max = @as(u128, std.math.maxInt(u128)),
        .comptime_big = 1 << 130,
        .float = @as(f64, 9007199254740993.0),
    });
}

/// Integers beyond 2^53, beyond 64 bits, and beyond 128 bits, next to floats.
const big_numbers =
    \\{"u64":18446744073709551615,"i64":-9223372036854775808,"near":9007199254740993,
    \\"huge":-123456789012345678901234567890123456789012,"float":1.5,"exp":1e21,"zero":-0,
    \\"list":[9007199254740993,18446744073709551616,1]}
;

test "keeps integers exact in every format" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("data", .{ .run = incur.handler(parseData) });
    try cli.command("ints", .{ .run = incur.handler(zigIntegers) });
    try expectServe(cli, &.{ "data", big_numbers, "--format", "json" }, 0,
        \\{
        \\  "u64": 18446744073709551615,
        \\  "i64": -9223372036854775808,
        \\  "near": 9007199254740993,
        \\  "huge": -123456789012345678901234567890123456789012,
        \\  "float": 1.5,
        \\  "exp": 1e+21,
        \\  "zero": 0,
        \\  "list": [
        \\    9007199254740993,
        \\    18446744073709551616,
        \\    1
        \\  ]
        \\}
        \\
    );
    try expectServe(cli, &.{ "data", big_numbers, "--format", "jsonl" }, 0,
        \\{"u64":18446744073709551615,"i64":-9223372036854775808,"near":9007199254740993,"huge":-123456789012345678901234567890123456789012,"float":1.5,"exp":1e+21,"zero":0,"list":[9007199254740993,18446744073709551616,1]}
        \\
    );
    try expectServe(cli, &.{ "data", big_numbers, "--format", "yaml" }, 0,
        \\u64: 18446744073709551615
        \\i64: -9223372036854775808
        \\near: 9007199254740993
        \\huge: -123456789012345678901234567890123456789012
        \\float: 1.5
        \\exp: 1e+21
        \\zero: 0
        \\list:
        \\  - 9007199254740993
        \\  - 18446744073709551616
        \\  - 1
        \\
    );
    const toon =
        \\u64: 18446744073709551615
        \\i64: -9223372036854775808
        \\near: 9007199254740993
        \\huge: -123456789012345678901234567890123456789012
        \\float: 1.5
        \\exp: 1e+21
        \\zero: 0
        \\list[3]: 9007199254740993,18446744073709551616,1
        \\
    ;
    try expectServe(cli, &.{ "data", big_numbers }, 0, toon);
    try expectServe(cli, &.{ "data", big_numbers, "--format", "md" }, 0,
        \\## u64
        \\
        \\18446744073709551615
        \\
        \\## i64
        \\
        \\-9223372036854775808
        \\
        \\## near
        \\
        \\9007199254740993
        \\
        \\## huge
        \\
        \\-123456789012345678901234567890123456789012
        \\
        \\## float
        \\
        \\1.5
        \\
        \\## exp
        \\
        \\1e+21
        \\
        \\## zero
        \\
        \\0
        \\
        \\## list
        \\
        \\9007199254740993,18446744073709551616,1
        \\
    );
    try expectServe(cli, &.{ "data", "[{\"id\":18446744073709551615,\"n\":9007199254740993}]", "--format", "md" }, 0,
        \\| id                   | n                |
        \\|----------------------|------------------|
        \\| 18446744073709551615 | 9007199254740993 |
        \\
    );
    try expectServe(cli, &.{ "data", big_numbers, "--token-count" }, 0, "36\n");
    try expectServe(cli, &.{ "data", big_numbers, "--filter-output", "list[1,3],u64" }, 0,
        \\list[2]: 18446744073709551616,1
        \\u64: 18446744073709551615
        \\
    );
    try expectServe(cli, &.{ "ints", "--json" }, 0,
        \\{
        \\  "u64_max": 18446744073709551615,
        \\  "i64_min": -9223372036854775808,
        \\  "u128_max": 340282366920938463463374607431768211455,
        \\  "comptime_big": 1361129467683753853853498429727072845824,
        \\  "float": 9007199254740992
        \\}
        \\
    );
}

const Narrow = struct {
    small: i8 = 0,
    port: ?u16 = null,
    verbose: u8 = 0,
    limit: f64 = 1,
    extra: Value = .{ .integer = 7 },
    nothing: Value = .null,

    pub const incur = .{ .fields = .{ .verbose = .{ .count = true, .alias = 'v' } } };
};

fn narrow(c: *Context(.{ .options = Narrow })) !Outcome {
    return c.ok(c.options);
}

test "rejects integers that do not fit narrower fields with validation errors" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("narrow", .{ .run = incur.handler(narrow) });
    try expectServe(cli, &.{ "narrow", "--small", "-128", "--port", "65535", "-vvv" }, 0,
        \\small: -128
        \\port: 65535
        \\verbose: 3
        \\limit: 1
        \\extra: 7
        \\nothing: null
        \\
    );
    try expectServe(cli, &.{ "narrow", "--small", "128", "--port", "-1" }, 1,
        \\code: VALIDATION_ERROR
        \\message: "Too big: expected number to be <=127; Too small: expected number to be >=0\n\nDetails: [\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 127,\n    \"inclusive\": true,\n    \"path\": [\n      \"small\"\n    ],\n    \"message\": \"Too big: expected number to be <=127\"\n  },\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"inclusive\": true,\n    \"path\": [\n      \"port\"\n    ],\n    \"message\": \"Too small: expected number to be >=0\"\n  }\n]"
        \\fieldErrors[2]{code,missing,path,expected,received,message}:
        \\  too_big,false,small,"","","Too big: expected number to be <=127"
        \\  too_small,false,port,"","","Too small: expected number to be >=0"
        \\
    );
    // The declared contract stays the safe-integer one Zod reports.
    try expectServe(cli, &.{ "narrow", "--schema", "--format", "json" }, 0,
        \\{
        \\  "options": {
        \\    "type": "object",
        \\    "properties": {
        \\      "small": {
        \\        "default": 0,
        \\        "type": "integer",
        \\        "minimum": -9007199254740991,
        \\        "maximum": 9007199254740991
        \\      },
        \\      "port": {
        \\        "type": "integer",
        \\        "minimum": -9007199254740991,
        \\        "maximum": 9007199254740991
        \\      },
        \\      "verbose": {
        \\        "default": 0,
        \\        "count": true,
        \\        "type": "number"
        \\      },
        \\      "limit": {
        \\        "default": 1,
        \\        "type": "number"
        \\      },
        \\      "extra": {
        \\        "default": 7
        \\      },
        \\      "nothing": {
        \\        "default": null
        \\      }
        \\    },
        \\    "required": [
        \\      "small",
        \\      "verbose",
        \\      "limit",
        \\      "extra",
        \\      "nothing"
        \\    ],
        \\    "additionalProperties": false
        \\  }
        \\}
        \\
    );
}

test "checks config numbers against the integer type of count fields" {
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const path = try tempConfig(dir, "tool.json",
        \\{"commands":{
        \\"whole":{"options":{"verbose":2.0,"limit":123456789012345678901234567890123456789012}},
        \\"fraction":{"options":{"verbose":2.5}},
        \\"float":{"options":{"verbose":1e40}},
        \\"negative":{"options":{"verbose":-1e40}},
        \\"big":{"options":{"verbose":-123456789012345678901234567890123456789012}},
        \\"wide":{"options":{"verbose":256}}}}
    );
    defer testing.allocator.free(path);
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .config = .{ .files = &.{path} } });
    defer cli.destroy();
    for ([_][]const u8{ "whole", "fraction", "float", "negative", "big", "wide" }) |name| try cli.command(name, .{ .run = incur.handler(narrow) });
    try expectServe(cli, &.{ "whole", "--format", "json" }, 0,
        \\{
        \\  "small": 0,
        \\  "port": null,
        \\  "verbose": 2,
        \\  "limit": 1.2345678901234568e+41,
        \\  "extra": 7,
        \\  "nothing": null
        \\}
        \\
    );
    try expectServe(cli, &.{"fraction"}, 1,
        \\code: VALIDATION_ERROR
        \\message: "Invalid input: expected int, received number\n\nDetails: [\n  {\n    \"expected\": \"int\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"verbose\"\n    ],\n    \"message\": \"Invalid input: expected int, received number\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  invalid_type,false,verbose,int,"","Invalid input: expected int, received number"
        \\
    );
    try expectServe(cli, &.{"float"}, 1,
        \\code: VALIDATION_ERROR
        \\message: "Too big: expected number to be <=255\n\nDetails: [\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 255,\n    \"inclusive\": true,\n    \"path\": [\n      \"verbose\"\n    ],\n    \"message\": \"Too big: expected number to be <=255\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  too_big,false,verbose,"","","Too big: expected number to be <=255"
        \\
    );
    try expectServe(cli, &.{"negative"}, 1,
        \\code: VALIDATION_ERROR
        \\message: "Too small: expected number to be >=0\n\nDetails: [\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"inclusive\": true,\n    \"path\": [\n      \"verbose\"\n    ],\n    \"message\": \"Too small: expected number to be >=0\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  too_small,false,verbose,"","","Too small: expected number to be >=0"
        \\
    );
    try expectServe(cli, &.{"big"}, 1,
        \\code: VALIDATION_ERROR
        \\message: "Too small: expected number to be >=0\n\nDetails: [\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"inclusive\": true,\n    \"path\": [\n      \"verbose\"\n    ],\n    \"message\": \"Too small: expected number to be >=0\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  too_small,false,verbose,"","","Too small: expected number to be >=0"
        \\
    );
    try expectServe(cli, &.{"wide"}, 1,
        \\code: VALIDATION_ERROR
        \\message: "Too big: expected number to be <=255\n\nDetails: [\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 255,\n    \"inclusive\": true,\n    \"path\": [\n      \"verbose\"\n    ],\n    \"message\": \"Too big: expected number to be <=255\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  too_big,false,verbose,"","","Too big: expected number to be <=255"
        \\
    );
}

fn halves(c: *Context(.{})) !Outcome {
    // A high and a low surrogate stored apart, as JavaScript concatenation leaves them, and a
    // lone high surrogate at the end.
    return c.ok(.{ .joined = "\xed\xa0\xbd" ++ "\xed\xb8\x80", .lone = "x\xed\xa0\xbd" });
}

/// Strings with unpaired surrogates, which JSON escapes can produce.
const lone_surrogates =
    \\{"a":"x\ud800y","b":"\udc00","c":"\ud83d\ude00","d":["\ud800"],"k\udbff":1}
;

test "keeps unpaired surrogates as JavaScript strings do" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("data", .{ .run = incur.handler(parseData) });
    try cli.command("halves", .{ .run = incur.handler(halves) });
    // JSON escapes them; other formats write them as Node writes strings, as U+FFFD.
    try expectServe(cli, &.{ "data", lone_surrogates, "--format", "json" }, 0,
        \\{
        \\  "a": "x\ud800y",
        \\  "b": "\udc00",
        \\  "c": "😀",
        \\  "d": [
        \\    "\ud800"
        \\  ],
        \\  "k\udbff": 1
        \\}
        \\
    );
    try expectServe(cli, &.{ "data", lone_surrogates, "--format", "jsonl" }, 0,
        \\{"a":"x\ud800y","b":"\udc00","c":"😀","d":["\ud800"],"k\udbff":1}
        \\
    );
    try expectServe(cli, &.{ "data", lone_surrogates, "--format", "yaml" }, 0,
        \\a: "x\ud800y"
        \\b: "\udc00"
        \\c: 😀
        \\d:
        \\  - "\ud800"
        \\"k\udbff": 1
        \\
    );
    try expectServe(cli, &.{ "data", lone_surrogates }, 0,
        \\a: x�y
        \\b: �
        \\c: 😀
        \\d[1]: �
        \\"k�": 1
        \\
    );
    try expectServe(cli, &.{ "data", lone_surrogates, "--format", "md" }, 0,
        \\## a
        \\
        \\x�y
        \\
        \\## b
        \\
        \\�
        \\
        \\## c
        \\
        \\😀
        \\
        \\## d
        \\
        \\�
        \\
        \\## k�
        \\
        \\1
        \\
    );
    try expectServe(cli, &.{ "data", lone_surrogates, "--token-count" }, 0,
        \\17
        \\
    );
    try expectServe(cli, &.{ "data", "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \\ud800\\ud800\\ud800\\ud800 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"", "--format", "yaml" }, 0,
        \\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        \\\ud800\ud800\ud800\ud800 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        \\
    );
    try expectServe(cli, &.{ "halves", "--json" }, 0,
        \\{
        \\  "joined": "😀",
        \\  "lone": "x\ud83d"
        \\}
        \\
    );
    try expectServe(cli, &.{"halves"}, 0,
        \\joined: 😀
        \\lone: x�
        \\
    );
}

test "lowercases suggestions as JavaScript does" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .description = "Unicode names" });
    defer cli.destroy();
    for ([_][]const u8{ "привет", "οσος", "οσοσx", "istanbul", "σα", "α'ς", "α'σx", "ασα", "ας", "āxy" }) |name| try cli.command(name, .{ .run = incur.handler(one) });
    for ([_][2][]const u8{
        .{ "ПРИВЕ", "привет" },
        .{ "ΟΣΟΣ", "οσος" },
        .{ "İSTANBUL", "istanbul" },
        .{ "ΣΑ", "σα" },
        .{ "Α'Σ", "α'ς" },
        .{ "Α'Σ1", "α'ς" },
        .{ "ΑΣΑ", "ασα" },
        .{ "āx", "āxy" },
    }) |entry| {
        const typo, const suggestion = entry;
        const served = try serve(cli, &.{typo}, &.{});
        defer served.deinit();
        const message = try std.fmt.allocPrint(testing.allocator, "code: COMMAND_NOT_FOUND\nmessage: '{s}' is not a command for 'tool'. Did you mean '{s}'?\n", .{ typo, suggestion });
        defer testing.allocator.free(message);
        try testing.expectStringStartsWith(served.output, message);
    }
}

/// Reads a file through `std.Io`.
fn readFile(io: std.Io, a: Allocator, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, a, .limited(1 << 16));
}

const PathsArgs = struct { first: []const u8, second: []const u8 };

fn readBoth(c: *Context(.{ .args = PathsArgs })) !Outcome {
    var first = c.io.async(readFile, .{ c.io, c.allocator, c.args.first });
    defer if (first.cancel(c.io)) |_| {} else |_| {};
    var second = c.io.async(readFile, .{ c.io, c.allocator, c.args.second });
    defer if (second.cancel(c.io)) |_| {} else |_| {};
    return c.ok(.{ .first = try first.await(c.io), .second = try second.await(c.io) });
}

/// Emits `left` chunks, waiting on the clock before each one.
const Ticker = struct {
    left: u8,

    pub fn next(it: *Ticker, io: std.Io, a: Allocator) !?incur.Chunk {
        if (it.left == 0) return null;
        try io.sleep(.fromMilliseconds(1), .awake);
        it.left -= 1;
        return .{ .data = try incur.encode(a, .{ .left = it.left }) };
    }
};

fn tick(c: *Context(.{})) !Outcome {
    const it = try c.allocator.create(Ticker);
    it.* = .{ .left = 2 };
    return c.stream(it);
}

fn wait(c: *Context(.{})) !Outcome {
    try c.io.sleep(.fromSeconds(600), .awake);
    return c.ok(1);
}

fn missingBanner(io: std.Io, a: Allocator) !?[]const u8 {
    return try readFile(io, a, "/nonexistent/incur-banner.txt");
}

test "runs handlers and streams on std.Io" {
    var dir = testing.tmpDir(.{});
    defer dir.cleanup();
    const first = try tempConfig(dir, "first.txt", "one");
    defer testing.allocator.free(first);
    const second = try tempConfig(dir, "second.txt", "two");
    defer testing.allocator.free(second);
    // Banner I/O failures show no banner, as in TypeScript.
    const cli = try incur.Cli.create(testing.allocator, "tool", .{ .banner = .{ .render = missingBanner } });
    defer cli.destroy();
    try cli.command("read", .{ .run = incur.handler(readBoth) });
    try cli.command("tick", .{ .run = incur.handler(tick) });
    try expectServe(cli, &.{ "read", first, second }, 0, "first: one\nsecond: two\n");
    try expectServe(cli, &.{"tick"}, 0, "left: 1\nleft: 0\n");
}

fn canceledBanner(_: std.Io, _: Allocator) !?[]const u8 {
    return error.Canceled;
}

test "ends serving when its task is canceled" {
    const cli = try incur.Cli.create(testing.allocator, "tool", .{});
    defer cli.destroy();
    try cli.command("wait", .{ .run = incur.handler(wait) });
    var env: std.process.Environ.Map = .init(testing.allocator);
    defer env.deinit();
    var stdout: std.Io.Writer.Allocating = .init(testing.allocator);
    defer stdout.deinit();
    const process: incur.Process = .{ .io = testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stdout.writer, .tty = false };
    var serving = try testing.io.concurrent(incur.Cli.serveWith, .{ cli, &.{"wait"}, process });
    try testing.expectError(error.Canceled, serving.cancel(testing.io));
    try testing.expectEqualStrings("", stdout.written());

    const bannered = try incur.Cli.create(testing.allocator, "tool", .{ .banner = .{ .render = canceledBanner } });
    defer bannered.destroy();
    try testing.expectError(error.Canceled, bannered.serveWith(&.{}, process));
}

test {
    _ = @import("features.zig");
    _ = @import("parse.zig");
}
