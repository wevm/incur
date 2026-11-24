//! CLIs declared as types: `incur.parse`, `incur.parseWith`, `Cli.handle`, and how declared and
//! builder CLIs compose.

const std = @import("std");
const incur = @import("incur");

const testing = std.testing;
const Allocator = std.mem.Allocator;
const Context = incur.Context;
const Outcome = incur.Outcome;
const Value = incur.Value;

const Stage = enum { dev, prod };

/// A command with every kind of input.
const Deploy = struct {
    service: []const u8,
    replicas: ?u8 = null,
    stage: Stage = .dev,
    verbose: f64 = 0,
    api_token: ?[]const u8 = null,
    dry_run: bool = false,
    labels: []const []const u8 = &.{},

    pub const incur = .{
        .description = "Deploys a service.",
        .hint = "Deploys are logged.",
        .examples = &.{.{ .command = "api 3" }},
        .middleware = &.{traceDeploy},
        .fields = .{
            .service = .{ .arg = true, .description = "Service name" },
            .replicas = .{ .arg = true, .description = "Replica count" },
            .stage = .{ .alias = 's', .description = "Target stage" },
            .verbose = .{ .alias = 'v', .count = true, .description = "Verbosity" },
            .api_token = .{ .env = true, .description = "API token" },
            .dry_run = .{ .rename = "dry", .description = "Renamed flag" },
            .labels = .{ .description = "Labels" },
        },
    };
};

/// A nested group.
const Db = union(enum) {
    migrate,
    shell: struct {
        name: ?[]const u8 = null,

        pub const incur = .{ .fields = .{ .name = .{ .arg = true } } };
    },

    pub const incur = .{
        .name = "db",
        .description = "Database commands",
        .middleware = &.{traceDb},
        .fields = .{ .shell = .{ .name = "sh", .description = "Open a shell" } },
    };
};

const Misc = union(enum) { ping };

const WipeOutput = struct { wiped: bool };

/// A CLI that is a group of commands.
const Ops = union(enum) {
    status,
    deploy: Deploy,
    ship: Deploy,
    db: Db,
    admin: Db,
    misc: Misc,
    wipe: struct {
        yes: bool = false,
        level: ?f64 = null,

        pub const incur = .{ .fields = .{
            .yes = .{ .alias = 'y', .description = "Confirmation" },
            .level = .{ .arg = true, .description = "Strict level" },
        } };
    },
    force_push: struct {
        times: ?f64 = null,

        pub const incur = .{ .fields = .{ .times = .{ .coerce = true } } };
    },

    pub const incur = .{
        .name = "ops",
        .version = "2.0.0",
        .aliases = &.{"op"},
        .description = "Operations tooling",
        .middleware = &.{traceOps},
        .fields = .{
            .status = .{ .description = "Show status" },
            .ship = .{
                .description = "Ship it now",
                .aliases = &.{"go"},
                .hint = "Ships to prod.",
                .middleware = &.{traceShip},
                .examples = &.{.{ .command = "web", .description = "Ship web" }},
                .usage = &.{.{ .args = &.{"service"}, .options = &.{"stage"}, .prefix = "env X=1", .suffix = "| tee log" }},
            },
            .admin = .{ .description = "Database admin" },
            .wipe = .{ .description = "Wipe all data", .destructive = true, .output = WipeOutput },
        },
    };
};

/// Appends `name` to the `trace` variable and runs the rest of the chain.
fn traced(c: *incur.MiddlewareContext, next: incur.Next, name: []const u8) !void {
    const trace = if (c.get("trace")) |t| t.string else "";
    try c.set("trace", .{ .string = try std.fmt.allocPrint(c.allocator, "{s}{s},", .{ trace, name }) });
    try next.run(c);
}

fn traceOps(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try traced(c, next, "ops");
}

fn traceDb(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try traced(c, next, "db");
}

fn traceDeploy(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try traced(c, next, "deploy");
}

fn traceShip(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try traced(c, next, "ship");
}

/// The result of one parse: the command or the exit code, and the output.
fn Result(comptime T: type) type {
    return struct {
        arena: std.heap.ArenaAllocator,
        parsed: incur.Parsed(T),
        output: []const u8,

        fn deinit(r: *@This()) void {
            r.arena.deinit();
        }
    };
}

/// Options for `parse`.
const Options = struct {
    env: []const [2][]const u8 = &.{},
    /// Customizes the CLI before parsing.
    configure: ?*const fn (cli: *incur.Cli) anyerror!void = null,
};

/// Parses `argv` into a `T` without a terminal, returning the result and the output.
fn parse(comptime T: type, argv: []const []const u8, options: Options) !Result(T) {
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    var env: std.process.Environ.Map = .init(a);
    for (options.env) |v| try env.put(v[0], v[1]);
    var stdout: std.Io.Writer.Allocating = .init(a);
    var stderr: std.Io.Writer.Allocating = .init(a);
    const cli = try incur.cli(T, testing.allocator, .{ .update = null, .sync = null });
    defer cli.destroy();
    if (options.configure) |configure| try configure(cli);
    const parsed = try cli.parseWith(T, a, argv, .{ .io = testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stderr.writer, .tty = false });
    return .{ .arena = arena, .parsed = parsed, .output = try std.mem.concat(a, u8, &.{ stdout.written(), stderr.written() }) };
}

/// Asserts that parsing exits with `code` and prints `output`.
fn expectExit(comptime T: type, argv: []const []const u8, options: Options, code: u8, output: []const u8) !void {
    var r = try parse(T, argv, options);
    defer r.deinit();
    try testing.expectEqual(code, r.parsed.exit);
    try testing.expectEqualStrings(output, r.output);
}

test "parses declared commands, nested groups, aliases, and every kind of input" {
    {
        var r = try parse(Ops, &.{"status"}, .{});
        defer r.deinit();
        try testing.expectEqual(.status, std.meta.activeTag(r.parsed.command));
        try testing.expectEqualStrings("", r.output);
    }
    {
        var r = try parse(Ops, &.{ "deploy", "api", "3", "-s", "prod", "-vv", "--dry", "--labels", "a", "--labels", "b" }, .{ .env = &.{.{ "API_TOKEN", "secret" }} });
        defer r.deinit();
        const deploy = r.parsed.command.deploy;
        try testing.expectEqualStrings("api", deploy.service);
        try testing.expectEqual(@as(?u8, 3), deploy.replicas);
        try testing.expectEqual(.prod, deploy.stage);
        try testing.expectEqual(@as(f64, 2), deploy.verbose);
        try testing.expectEqualStrings("secret", deploy.api_token.?);
        try testing.expect(deploy.dry_run);
        try testing.expectEqual(@as(usize, 2), deploy.labels.len);
        try testing.expectEqualStrings("b", deploy.labels[1]);
    }
    {
        var r = try parse(Ops, &.{ "go", "web" }, .{});
        defer r.deinit();
        try testing.expectEqualStrings("web", r.parsed.command.ship.service);
        try testing.expectEqual(.dev, r.parsed.command.ship.stage);
    }
    {
        var r = try parse(Ops, &.{ "db", "sh", "main" }, .{});
        defer r.deinit();
        try testing.expectEqualStrings("main", r.parsed.command.db.shell.name.?);
    }
    {
        var r = try parse(Ops, &.{ "admin", "migrate" }, .{});
        defer r.deinit();
        try testing.expectEqual(.migrate, std.meta.activeTag(r.parsed.command.admin));
    }
    {
        var r = try parse(Ops, &.{ "misc", "ping" }, .{});
        defer r.deinit();
        try testing.expectEqual(.ping, std.meta.activeTag(r.parsed.command.misc));
    }
    {
        var r = try parse(Ops, &.{ "wipe", "-y" }, .{});
        defer r.deinit();
        try testing.expect(r.parsed.command.wipe.yes);
        try testing.expectEqual(@as(?f64, null), r.parsed.command.wipe.level);
    }
    {
        var r = try parse(Ops, &.{ "force-push", "--times", "" }, .{});
        defer r.deinit();
        try testing.expectEqual(@as(?f64, 0), r.parsed.command.force_push.times);
    }
}

test "returns the exit code of built-ins and invalid input" {
    try expectExit(Ops, &.{"--version"}, .{}, 0, "2.0.0\n");
    try expectExit(Ops, &.{ "deploy", "api", "300" }, .{ .env = &.{.{ "NO_COLOR", "1" }} }, 1,
        \\code: VALIDATION_ERROR
        \\message: "Too big: expected number to be <=255\n\nDetails: [\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 255,\n    \"inclusive\": true,\n    \"path\": [\n      \"replicas\"\n    ],\n    \"message\": \"Too big: expected number to be <=255\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  too_big,false,replicas,"","","Too big: expected number to be <=255"
        \\
    );
    // Positional numbers convert from strings, so text is not a number.
    try expectExit(Ops, &.{ "wipe", "abc", "--filter-output", "code" }, .{}, 1,
        \\code: VALIDATION_ERROR
        \\message: "Invalid input: expected number, received NaN\n\nDetails: [\n  {\n    \"expected\": \"number\",\n    \"code\": \"invalid_type\",\n    \"received\": \"NaN\",\n    \"path\": [\n      \"level\"\n    ],\n    \"message\": \"Invalid input: expected number, received NaN\"\n  }\n]"
        \\fieldErrors[1]{code,missing,path,expected,received,message}:
        \\  invalid_type,false,level,number,NaN,"Invalid input: expected number, received NaN"
        \\
    );
    try expectExit(Ops, &.{ "misc", "--help" }, .{}, 0,
        \\ops misc
        \\
        \\Usage: ops misc <command>
        \\
        \\Commands:
        \\  ping
        \\
        \\Global Options:
        \\  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        \\  --format <toon|json|yaml|md|jsonl>  Output format
        \\  --full-output                       Show full output envelope
        \\  --help                              Show help
        \\  --llms, --llms-full                 Print LLM-readable manifest
        \\  --schema                            Show JSON Schema for command
        \\  --token-count                       Print token count of output (instead of output)
        \\  --token-limit <n>                   Limit output to n tokens
        \\  --token-offset <n>                  Skip first n tokens of output
        \\
    );
    try expectExit(Ops, &.{ "ship", "--help" }, .{}, 0,
        \\ops ship — Ship it now
        \\
        \\Usage: env X=1 ops ship <service> --stage <stage> | tee log
        \\Aliases: go
        \\
        \\Arguments:
        \\  service   Service name
        \\  replicas  Replica count
        \\
        \\Options:
        \\  --stage, -s <dev|prod>  Target stage (default: dev)
        \\  --verbose, -v <count>   Verbosity (default: 0)
        \\  --dry                   Renamed flag
        \\  --labels <array>        Labels
        \\
        \\Examples:
        \\  ops ship api 3
        \\  ops ship web    # Ship web
        \\
        \\Ships to prod.
        \\
        \\Global Options:
        \\  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        \\  --format <toon|json|yaml|md|jsonl>  Output format
        \\  --full-output                       Show full output envelope
        \\  --help                              Show help
        \\  --llms, --llms-full                 Print LLM-readable manifest
        \\  --schema                            Show JSON Schema for command
        \\  --token-count                       Print token count of output (instead of output)
        \\  --token-limit <n>                   Limit output to n tokens
        \\  --token-offset <n>                  Skip first n tokens of output
        \\
        \\Environment Variables:
        \\  API_TOKEN  API token
        \\
    );
}

/// Root help of `Ops`, which lists the `mcp` integration and `--mcp` only when serving.
fn opsHelp(comptime mcp: bool) []const u8 {
    return
    \\ops@2.0.0 — Operations tooling
    \\
    \\Usage: ops <command>
    \\Aliases: op
    \\
    \\Commands:
    \\  admin       Database admin
    \\  db          Database commands
    \\  deploy      Deploys a service.
    \\  force-push
    \\  misc
    \\  ship        Ship it now
    \\  status      Show status
    \\  wipe        Wipe all data
    \\
    \\Integrations:
    \\  completions  Generate shell completion script
    \\
    ++ (if (mcp) "  mcp          Register as MCP server (add, doctor)\n" else "") ++
        \\
        \\Global Options:
        \\  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        \\  --format <toon|json|yaml|md|jsonl>  Output format
        \\  --full-output                       Show full output envelope
        \\  --help                              Show help
        \\  --llms, --llms-full                 Print LLM-readable manifest
        \\
    ++ (if (mcp) "  --mcp                               Start as MCP stdio server\n" else "") ++
        \\  --schema                            Show JSON Schema for command
        \\  --token-count                       Print token count of output (instead of output)
        \\  --token-limit <n>                   Limit output to n tokens
        \\  --token-offset <n>                  Skip first n tokens of output
        \\  --version                           Show version
        \\
    ;
}

fn ops(c: *Context(.{}), command: Ops) !Outcome {
    return c.ok(@tagName(command));
}

test "hides --mcp and mcp add when parsing, since they need a handler" {
    try expectExit(Ops, &.{"--help"}, .{}, 0, opsHelp(false));
    const not_found =
        \\code: COMMAND_NOT_FOUND
        \\message: '{s}' is not a command for 'ops'.
        \\cta:
        \\  description: "Suggested command:"
        \\  commands[1]{{command,description}}:
        \\    ops --help,see all available commands
        \\
    ;
    try expectExit(Ops, &.{"--mcp"}, .{}, 1, std.fmt.comptimePrint(not_found, .{"--mcp"}));
    try expectExit(Ops, &.{ "mcp", "add" }, .{}, 1, std.fmt.comptimePrint(not_found, .{"mcp"}));
    try expectExit(Ops, &.{ "mcp", "doctor" }, .{}, 1, std.fmt.comptimePrint(not_found, .{"mcp"}));
    // `mcp` is no longer a suggestion for a typo.
    try expectExit(Ops, &.{"mc"}, .{}, 1,
        \\code: COMMAND_NOT_FOUND
        \\message: 'mc' is not a command for 'ops'. Did you mean 'go'?
        \\cta:
        \\  description: "Suggested commands:"
        \\  commands[2]:
        \\    - command: ops go
        \\    - command: ops --help
        \\      description: see all available commands
        \\
    );
    // Bash completion candidates are separated by vertical tabs, and groups marked with `\x01`.
    try expectExit(Ops, &.{ "--", "ops", "" }, .{ .env = &.{.{ "COMPLETE", "bash" }} }, 0, "status\x0bdeploy\x0bship\x0bdb\x01\x0badmin\x01\x0bmisc\x01\x0bwipe\x0bforce-push\x0bcompletions");
    try expectExit(Ops, &.{ "--", "ops", "mcp", "" }, .{ .env = &.{.{ "COMPLETE", "bash" }} }, 0, "status\x0bdeploy\x0bship\x0bdb\x01\x0badmin\x01\x0bmisc\x01\x0bwipe\x0bforce-push");

    // Serving the same declaration with a handler keeps them.
    const cli = try incur.cli(Ops, testing.allocator, .{ .update = null, .sync = null });
    defer cli.destroy();
    try cli.handle(Ops, ops);
    var stdout: std.Io.Writer.Allocating = .init(testing.allocator);
    defer stdout.deinit();
    var env: std.process.Environ.Map = .init(testing.allocator);
    defer env.deinit();
    const process: incur.Process = .{ .io = testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stdout.writer, .tty = false };
    try testing.expectEqual(0, try cli.serveWith(&.{"--help"}, process));
    try testing.expectEqualStrings(opsHelp(true), stdout.written());
    stdout.clearRetainingCapacity();
    try testing.expectEqual(0, try cli.serveWith(&.{ "admin", "migrate" }, process));
    try testing.expectEqualStrings("admin\n", stdout.written());
}

/// Middleware that fails after the command was parsed.
fn denyAfter(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try next.run(c);
    return c.fail(.{ .code = "DENIED", .message = "failed after the command" });
}

fn useDenyAfter(cli: *incur.Cli) !void {
    try cli.use(denyAfter);
}

test "fails the parse when middleware fails after the command" {
    try expectExit(Ops, &.{"status"}, .{ .configure = useDenyAfter }, 1,
        \\code: DENIED
        \\message: failed after the command
        \\
    );
    try expectExit(Ops, &.{ "status", "--format", "json" }, .{ .configure = useDenyAfter }, 1,
        \\{
        \\  "code": "DENIED",
        \\  "message": "failed after the command"
        \\}
        \\
    );
}

/// A CLI that is one command, with middleware.
const Bare = struct {
    pub const incur = .{ .name = "bare", .version = "1.0.0", .aliases = &.{"b"}, .middleware = &.{requireAllow} };
};

/// Middleware that fails unless the `allow` variable is set.
fn requireAllow(c: *incur.MiddlewareContext, next: incur.Next) !void {
    if (c.get("allow") == null) return c.fail(.{ .code = "FORBIDDEN", .message = "not allowed" });
    try next.run(c);
}

fn allow(cli: *incur.Cli) !void {
    cli.options.vars = &.{.{ .key = "allow", .value = .{ .bool = true } }};
}

test "parses a struct as the root command, running its middleware first" {
    try expectExit(Bare, &.{}, .{}, 1,
        \\code: FORBIDDEN
        \\message: not allowed
        \\
    );
    {
        var r = try parse(Bare, &.{"--full-output"}, .{ .configure = allow });
        defer r.deinit();
        try testing.expectEqual(Bare{}, r.parsed.command);
        // The envelope after the command belongs to the caller.
        try testing.expectEqualStrings("", r.output);
    }
    try expectExit(Bare, &.{"--version"}, .{}, 0, "1.0.0\n");
}

fn extra(c: *Context(.{})) !Outcome {
    return c.ok(.{ .extra = true });
}

fn addExtra(cli: *incur.Cli) !void {
    try cli.command("extra", .{ .description = "A builder command", .run = incur.handler(extra) });
}

test "composes declared and builder commands" {
    // A builder command on a declared CLI runs its own handler, so parsing returns its exit code.
    try expectExit(Ops, &.{"extra"}, .{ .configure = addExtra }, 0, "extra: true\n");

    // A declared group mounts on a builder CLI.
    const app = try incur.Cli.create(testing.allocator, "app", .{ .update = null, .sync = null });
    defer app.destroy();
    const db = try incur.cli(Db, testing.allocator, .{});
    db.handle(Db, dbCommand) catch |err| {
        db.destroy();
        return err;
    };
    try app.group(db);
    var stdout: std.Io.Writer.Allocating = .init(testing.allocator);
    defer stdout.deinit();
    var env: std.process.Environ.Map = .init(testing.allocator);
    defer env.deinit();
    const process: incur.Process = .{ .io = testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stdout.writer, .tty = false };
    try testing.expectEqual(0, try app.serveWith(&.{ "db", "sh", "main" }, process));
    try testing.expectEqualStrings("shell: main\ntrace: \"db,\"\n", stdout.written());

    // The one-call entry declares the CLI too.
    var arena: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena.deinit();
    stdout.clearRetainingCapacity();
    const parsed = try incur.parseWith(Db, arena.allocator(), &.{"migrate"}, process);
    try testing.expectEqual(.migrate, std.meta.activeTag(parsed.command));
}

fn dbCommand(c: *Context(.{}), command: Db) !Outcome {
    return switch (command) {
        .migrate => c.ok(.{ .migrated = true }),
        .shell => |shell| c.ok(.{ .shell = shell.name, .trace = c.get("trace") }),
    };
}

/// A command with an option of any JSON value.
const Tool = union(enum) {
    run: struct { extra: ?Value = null },

    pub const incur = .{ .name = "tool" };
};

fn loadsBigInteger(load: *incur.Config.Load, _: ?[]const u8) !?Value {
    var message: []const u8 = undefined;
    return try incur.json.parse(load.allocator,
        \\{"commands":{"run":{"options":{"extra":[123456789012345678901234567890123456789012345678901234567890,"text"]}}}}
    , &message);
}

fn withBigInteger(cli: *incur.Cli) !void {
    cli.options.config = .{ .loader = loadsBigInteger };
}

test "copies the parsed command out of the invocation, integers of any size included" {
    var r = try parse(Tool, &.{"run"}, .{ .configure = withBigInteger });
    defer r.deinit();
    const items = r.parsed.command.run.extra.?.array;
    try testing.expectEqualStrings("123456789012345678901234567890123456789012345678901234567890", items[0].big_integer);
    try testing.expectEqualStrings("text", items[1].string);
}

/// Declares, parses, and frees a CLI, for the allocation-failure sweep.
fn parseOnce(gpa: Allocator, argv: []const []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var env: std.process.Environ.Map = .init(gpa);
    defer env.deinit();
    try env.put("API_TOKEN", "secret");
    var buf: [64]u8 = undefined;
    var out: std.Io.Writer.Discarding = .init(&buf);
    const cli = try incur.cli(Ops, gpa, .{ .update = null, .sync = null });
    defer cli.destroy();
    _ = try cli.parseWith(Ops, arena.allocator(), argv, .{ .io = testing.io, .env = &env, .stdout = &out.writer, .stderr = &out.writer, .tty = false });
}

test "propagates allocation failures while declaring and parsing without leaking" {
    try testing.checkAllAllocationFailures(testing.allocator, parseOnce, .{&[_][]const u8{ "deploy", "api", "3", "--labels", "a" }});
    try testing.checkAllAllocationFailures(testing.allocator, parseOnce, .{&[_][]const u8{"--help"}});
}
