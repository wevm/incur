//! Zig mirror of the reference CLIs in `langs/_differential/fixtures.ts`.

const std = @import("std");
const incur = @import("incur");

const Allocator = std.mem.Allocator;
const Value = incur.Value;
const Outcome = incur.Outcome;
const Context = incur.Context;

const AppEnv = struct {
    app_user: ?[]const u8 = null,

    pub const incur = .{
        .rename_all = .screaming_snake_case,
        .fields = .{ .app_user = .{ .description = "Acting user" } },
    };
};

const InstallArgs = struct {
    package: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .package = .{ .description = "Package name" } } };
};

const Tag = enum { latest, next };

const InstallOptions = struct {
    save_dev: ?bool = null,
    registry: ?[]const u8 = null,
    retries: f64 = 3,
    tag: Tag = .latest,

    pub const incur = .{
        .rename_all = .camel_case,
        .omit_null = true,
        .fields = .{
            .save_dev = .{ .description = "Save as dev dependency", .alias = 'D' },
            .registry = .{ .description = "Registry URL", .alias = 'r' },
            .retries = .{ .description = "Retry count", .min = 0, .max = 10 },
            .tag = .{ .description = "Dist tag" },
        },
    };
};

const GreetArgs = struct {
    name: []const u8,

    pub const incur = .{ .fields = .{ .name = .{ .description = "Name to greet" } } };
};

const GreetOptions = struct {
    loud: bool = false,
    times: ?i64 = null,
    suffix: ?[]const u8 = null,

    pub const incur = .{ .fields = .{
        .loud = .{ .description = "Shout" },
        .times = .{ .description = "Repeat count", .min = 1, .max = 5 },
        .suffix = .{ .description = "Suffix", .min = 1, .max = 3 },
    } };
};

const GreetOutput = struct {
    message: []const u8,

    pub const incur = .{ .fields = .{ .message = .{ .description = "The greeting" } } };
};

const ItemState = enum { open, closed };

const ListArgs = struct {
    state: ItemState = .open,

    pub const incur = .{ .fields = .{ .state = .{ .description = "Item state" } } };
};

const DeployEnv = struct {
    deploy_token: []const u8,
    deploy_region: []const u8 = "us",
    deploy_retries: ?i64 = null,
    deploy_dry: ?bool = null,

    pub const incur = .{
        .rename_all = .screaming_snake_case,
        .fields = .{
            .deploy_token = .{ .description = "Deploy token" },
            .deploy_region = .{ .description = "Region" },
            .deploy_retries = .{ .description = "Retries" },
            .deploy_dry = .{ .description = "Dry run" },
        },
    };
};

const DeployOptions = struct {
    zone: ?[]const u8 = null,
    region: ?[]const u8 = null,
    force: ?bool = null,

    pub const incur = .{ .fields = .{
        .zone = .{ .description = "Availability zone", .alias = 'z', .deprecated = true },
        .region = .{ .description = "Target region" },
        .force = .{ .description = "Force deploy", .alias = 'f' },
    } };
};

const CountOptions = struct {
    verbose: i64 = 0,
    quiet: ?bool = null,
    level: ?i64 = null,

    pub const incur = .{ .fields = .{
        .verbose = .{ .description = "Verbosity", .count = true, .alias = 'v' },
        .quiet = .{ .description = "Quiet", .alias = 'q' },
        .level = .{ .description = "Level" },
    } };
};

const TagsArgs = struct {
    target: []const u8,
    files: ?[]const []const u8 = null,

    pub const incur = .{ .fields = .{
        .target = .{ .description = "Target" },
        .files = .{ .description = "Files", .min = 1, .max = 3 },
    } };
};

const TagsOptions = struct {
    tag: []const []const u8 = &.{},

    pub const incur = .{ .fields = .{ .tag = .{ .description = "Tags", .alias = 't' } } };
};

const UsageArgs = struct {
    file: []const u8,

    pub const incur = .{ .fields = .{ .file = .{ .description = "File" } } };
};

const UsageOptions = struct {
    lines: ?f64 = null,

    pub const incur = .{ .fields = .{ .lines = .{ .description = "Lines" } } };
};

const PrState = enum { open, closed, all };

/// Pull request commands, declared as a group.
const Pr = union(enum) {
    list: struct {
        state: PrState = .open,

        pub const incur = .{ .fields = .{ .state = .{ .description = "State" } } };
    },
    view: struct {
        number: f64,

        pub const incur = .{ .fields = .{ .number = .{ .arg = true, .coerce = false, .description = "PR number" } } };
    },

    pub const incur = .{
        .name = "pr",
        .description = "Pull request commands",
        .middleware = &.{prUser},
        .fields = .{
            .list = .{ .description = "List pull requests" },
            .view = .{ .description = "View a pull request" },
        },
    };
};

const UserRow = struct {
    name: []const u8,
    email: []const u8,
    role: []const u8,

    pub const incur = .{ .fields = .{
        .name = .{ .description = "Name" },
        .email = .{ .description = "Email" },
        .role = .{ .description = "Role" },
    } };
};

const PageInfo = struct {
    total: f64,

    pub const incur = .{ .fields = .{ .total = .{ .description = "Total" } } };
};

const UsersOutput = struct {
    users: []const UserRow,
    page: ?PageInfo = null,

    pub const incur = .{ .fields = .{
        .users = .{ .description = "Users" },
        .page = .{ .description = "Paging" },
    } };
};

const VariadicArgs = struct {
    files: []const []const u8,
    last: []const u8,

    pub const incur = .{ .fields = .{
        .files = .{ .description = "Files" },
        .last = .{ .description = "Last" },
    } };
};

const DataArgs = struct {
    json: []const u8,

    pub const incur = .{ .fields = .{ .json = .{ .description = "JSON value" } } };
};

const DbArgs = struct {
    table: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .table = .{ .description = "Table" } } };
};

/// The users list.
const users = [_]UserRow{
    .{ .name = "Alice", .email = "alice@example.com", .role = "admin" },
    .{ .name = "Bob", .email = "bob@example.com", .role = "user" },
    .{ .name = "Carol", .email = "carol@example.com", .role = "user" },
};

/// The mixed data, as JSON text: its keys include an empty string and a space.
const mixed =
    \\{"context":{"task":"Our favorite hikes together","location":"Boulder","season":"spring_2025"},
    \\"friends":["ana","luis","sam"],
    \\"hikes":[{"id":1,"name":"Blue Lake Trail","distanceKm":7.5,"wasSunny":true},{"id":2,"name":"Ridge Overlook","distanceKm":9.2,"wasSunny":false}],
    \\"matrix":[[1,2],[3,4]],
    \\"nested":[{"a":{"b":1}},"x",[1,{"y":2}]],
    \\"empty":{},
    \\"none":[],
    \\"quoted":["true","42","-dash","a:b"," pad","","comma,here","null","05","1e3"],
    \\"text":"line one\nline two",
    \\"long":"This is a fairly long sentence that should exceed the default YAML line width of eighty characters easily.",
    \\"unicode":"héllo wörld 日本語",
    \\"special":{"key with space":1,"1abc":2,"dotted.key":3,"":4},
    \\"numbers":[0,-1,1.5,1e21,0.000001,123456789012],
    \\"nil":null}
;

/// Parses JSON text, reporting V8's message as an `UNKNOWN` error.
fn parseJson(c: anytype, text: []const u8) !Value {
    var message: []const u8 = undefined;
    return incur.json.parse(c.allocator, text, &message) catch |err| switch (err) {
        error.SyntaxError => return c.fail(.{ .message = message }),
        else => |e| return e,
    };
}

fn useUser(c: *incur.MiddlewareContext, next: incur.Next) !void {
    // An empty value is falsy in the reference, so it sets no user.
    if (c.env.get("APP_USER")) |user| if (user.string.len > 0) try c.set("user", user);
    try next.run(c);
}

fn prUser(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const user = if (c.get("user")) |u| u.string else "";
    try c.set("user", .{ .string = try std.fmt.allocPrint(c.allocator, "pr:{s}", .{user}) });
    try next.run(c);
}

fn requireRoot(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const user = c.get("user") orelse Value.null;
    if (user != .string or !std.mem.eql(u8, user.string, "root")) return c.fail(.{ .code = "FORBIDDEN", .message = "admin only" });
    try next.run(c);
}

fn pr(c: *Context(.{}), command: Pr) !Outcome {
    return switch (command) {
        .list => |options| c.ok(.{ .prs = .{}, .state = options.state, .user = c.get("user") }),
        .view => |args| c.ok(.{ .number = args.number }),
    };
}

fn dbRoot(c: *Context(.{ .args = DbArgs })) !Outcome {
    if (c.args.table) |table| return c.ok(.{ .tables = .{table} });
    return c.ok(.{ .tables = .{ "users", "posts" } });
}

fn migrate(c: *Context(.{})) !Outcome {
    return c.ok(.{ .migrated = true });
}

fn status(c: *Context(.{})) !Outcome {
    return c.ok(.{ .clean = true, .branch = "main" });
}

fn install(c: *Context(.{ .args = InstallArgs, .options = InstallOptions })) !Outcome {
    var out: incur.ObjectBuilder = .{};
    try out.put(c.allocator, "added", .{ .integer = 1 });
    try out.put(c.allocator, "package", try incur.encode(c.allocator, c.args.package));
    for ((try incur.encode(c.allocator, c.options)).object) |entry| try out.put(c.allocator, entry.key, entry.value);
    return c.ok(out.finish());
}

fn greet(c: *Context(.{ .args = GreetArgs, .options = GreetOptions })) !Outcome {
    const a = c.allocator;
    var message = try std.fmt.allocPrint(a, "hello {s}{s}", .{ c.args.name, c.options.suffix orelse "" });
    if (c.options.loud) message = try std.ascii.allocUpperString(a, message);
    const times: usize = @intCast(c.options.times orelse 1);
    const parts = try a.alloc([]const u8, times);
    @memset(parts, message);
    return c.ok(.{ .message = try std.mem.join(a, " ", parts) });
}

fn usersCommand(c: *Context(.{})) !Outcome {
    return c.ok(.{ .users = users });
}

fn list(c: *Context(.{ .args = ListArgs })) !Outcome {
    const items = [_]struct { id: i64, title: []const u8 }{.{ .id = 1, .title = "Fix bug" }};
    const outcome = try c.ok(.{ .items = items, .state = c.args.state });
    return outcome.withCta(.{
        .description = "Next steps:",
        .commands = &.{
            .{ .command = "get 1", .description = "View item" },
            .{ .command = "list", .args = &.{.{ .key = "state", .value = .{ .string = "closed" } }}, .description = "View closed" },
            .{ .command = "search", .options = &.{.{ .key = "query", .value = .{ .bool = true } }} },
            .{ .command = "status" },
            .{ .command = "app whoami", .description = "Who am I" },
            .{ .command = "tags", .args = &.{.{ .key = "target", .value = .{ .bool = true } }}, .options = &.{.{ .key = "tag", .value = .{ .string = "x" } }} },
        },
    });
}

fn fail(c: *Context(.{})) !Outcome {
    return c.fail(.{
        .code = "NOT_AUTHENTICATED",
        .message = "GitHub token not found",
        .hint = "Tokens expire after 30 days.",
        .retryable = true,
        .exit_code = 3,
        .cta = .{ .commands = &.{ .{ .command = "auth login", .description = "Log in to GitHub" }, .{ .command = "status" } } },
    });
}

fn throw(c: *Context(.{})) !Outcome {
    return c.fail(.{ .message = "boom" });
}

fn throwIncur(c: *Context(.{})) !Outcome {
    return c.fail(.{ .code = "RATE_LIMITED", .message = "Slow down", .retryable = true });
}

fn deploy(c: *Context(.{ .options = DeployOptions, .env = DeployEnv })) !Outcome {
    return c.ok(.{
        .deployed = true,
        .region = c.options.region orelse c.env.deploy_region,
        .retries = c.env.deploy_retries,
        .dry = c.env.deploy_dry,
    });
}

fn logs(c: *Context(.{})) !Outcome {
    const progress = struct {
        fn of(a: Allocator, n: f64) !Value {
            return incur.encode(a, .{ .progress = n });
        }
    }.of;
    const chunks = try c.allocator.dupe(incur.Chunk, &.{
        .{ .data = .{ .string = "connecting..." } },
        .{ .data = try progress(c.allocator, 50) },
        .{ .data = try progress(c.allocator, 100) },
    });
    return (try c.streamSlice(chunks)).withCta(.{ .commands = &.{.{ .command = "status" }} });
}

fn streamFail(c: *Context(.{})) !Outcome {
    const chunks = try c.allocator.dupe(incur.Chunk, &.{
        .{ .data = try incur.encode(c.allocator, .{ .step = 1 }) },
        .{ .failure = .{ .code = "STREAM_BROKE", .message = "stream broke", .cta = .{ .commands = &.{.{ .command = "status" }} } } },
    });
    return c.streamSlice(chunks);
}

fn nuke(c: *Context(.{})) !Outcome {
    return c.ok(.{ .nuked = true });
}

fn scalar(c: *Context(.{})) !Outcome {
    return c.ok("hello world");
}

fn number(c: *Context(.{})) !Outcome {
    return c.ok(42);
}

fn nothing(_: *Context(.{})) !Outcome {
    return .none;
}

fn jsonString(c: *Context(.{})) !Outcome {
    return c.ok("{\"b\":1,\"a\":[1,2]}");
}

fn array(c: *Context(.{})) !Outcome {
    return c.ok(.{ 1, 2, 3 });
}

fn objects(c: *Context(.{})) !Outcome {
    return c.ok(users);
}

fn mixedCommand(c: *Context(.{})) !Outcome {
    return c.ok(try parseJson(c, mixed));
}

fn data(c: *Context(.{ .args = DataArgs })) !Outcome {
    return c.ok(try parseJson(c, c.args.json));
}

fn secret(c: *Context(.{})) !Outcome {
    return c.ok(.{ .token = "abc" });
}

fn count(c: *Context(.{ .options = CountOptions })) !Outcome {
    return c.ok(.{ .verbose = c.options.verbose, .quiet = c.options.quiet orelse false, .level = c.options.level });
}

fn tags(c: *Context(.{ .args = TagsArgs, .options = TagsOptions })) !Outcome {
    return c.ok(.{ .target = c.args.target, .files = c.args.files orelse &.{}, .tag = c.options.tag });
}

fn variadic(c: *Context(.{ .args = VariadicArgs })) !Outcome {
    return c.ok(.{ .ok = true });
}

fn whoami(c: *Context(.{})) !Outcome {
    return c.ok(.{ .user = c.get("user") });
}

fn admin(c: *Context(.{})) !Outcome {
    return c.ok(.{ .admin = true });
}

fn fmt(c: *Context(.{})) !Outcome {
    return c.ok(.{ .a = 1 });
}

fn usage(c: *Context(.{ .args = UsageArgs, .options = UsageOptions })) !Outcome {
    return c.ok(.{ .ok = true });
}

fn hi(c: *Context(.{})) !Outcome {
    return c.ok(.{ .hi = true });
}

fn app(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "app", .{
        .update = null,
        .description = "A differential test CLI",
        .version = "1.2.3",
        .env = incur.schema(AppEnv),
        .vars = &.{.{ .key = "user", .value = .{ .string = "anonymous" } }},
    });
    errdefer cli.destroy();
    try cli.use(useUser);
    try cli.command("status", .{ .description = "Show repo status", .examples = &.{.{ .description = "Show status" }}, .run = incur.handler(status) });
    try cli.command("install", .{ .description = "Install a package", .run = incur.handler(install) });
    try cli.command("greet", .{
        .description = "Greet someone",
        .output = incur.schema(GreetOutput),
        .examples = &.{ .{ .command = "world", .description = "Greet the world" }, .{ .command = "bob --loud true" } },
        .hint = "Names are case-sensitive.",
        .run = incur.handler(greet),
    });
    try cli.command("users", .{ .description = "List users", .output = incur.schema(UsersOutput), .run = incur.handler(usersCommand) });
    try cli.command("list", .{ .description = "List items", .run = incur.handler(list) });
    try cli.command("fail", .{ .description = "Fail with a code", .run = incur.handler(fail) });
    try cli.command("throw", .{ .description = "Throw an error", .run = incur.handler(throw) });
    try cli.command("throw-incur", .{ .description = "Throw an incur error", .run = incur.handler(throwIncur) });
    try cli.command("deploy", .{
        .description = "Deploy the app",
        .aliases = &.{"ship"},
        .destructive = true,
        .hint = "Requires a deploy token.",
        .run = incur.handler(deploy),
    });
    try cli.command("logs", .{ .description = "Tail logs", .run = incur.handler(logs) });
    try cli.command("stream-fail", .{ .description = "Stream then fail", .run = incur.handler(streamFail) });
    try cli.command("nuke", .{
        .description = "Delete everything",
        .destructive = true,
        .hint = "Confirm with the user before executing this destructive command.",
        .run = incur.handler(nuke),
    });
    try cli.command("scalar", .{ .description = "Return a string", .output = incur.schema([]const u8), .run = incur.handler(scalar) });
    try cli.command("number", .{ .description = "Return a number", .run = incur.handler(number) });
    try cli.command("nothing", .{ .description = "Return nothing", .output = incur.schema(struct {}), .run = incur.handler(nothing) });
    try cli.command("json-string", .{ .description = "Return JSON text", .run = incur.handler(jsonString) });
    try cli.command("array", .{ .description = "Return an array", .run = incur.handler(array) });
    try cli.command("objects", .{ .description = "Return objects", .output = incur.schema(Value), .run = incur.handler(objects) });
    try cli.command("mixed", .{ .description = "Return mixed data", .run = incur.handler(mixedCommand) });
    try cli.command("data", .{ .description = "Return parsed JSON", .run = incur.handler(data) });
    try cli.command("secret", .{ .description = "Agent-only output", .output_policy = .agent_only, .run = incur.handler(secret) });
    try cli.command("count", .{ .description = "Count flags", .run = incur.handler(count) });
    try cli.command("tags", .{ .description = "Collect values", .run = incur.handler(tags) });
    try cli.command("variadic", .{ .description = "Variadic arg first", .run = incur.handler(variadic) });
    try cli.command("whoami", .{ .description = "Show the acting user", .run = incur.handler(whoami) });
    try cli.command("admin", .{ .description = "Admin only", .destructive = true, .middleware = &.{requireRoot}, .run = incur.handler(admin) });
    try cli.command("fmt", .{ .description = "Defaults to JSON", .format = .json, .run = incur.handler(fmt) });
    try cli.command("usage", .{
        .description = "Custom usage",
        .usage = &.{ .{ .args = &.{"file"} }, .{ .options = &.{"lines"}, .prefix = "cat x |", .suffix = "| head" } },
        .run = incur.handler(usage),
    });

    const prs = try incur.cli(Pr, gpa, .{});
    prs.handle(Pr, pr) catch |err| {
        prs.destroy();
        return err;
    };
    try cli.group(prs);

    const db = try incur.Cli.create(gpa, "db", .{ .description = "Database commands", .output_policy = .agent_only, .root = .{ .run = incur.handler(dbRoot) } });
    try db.command("migrate", .{ .description = "Run migrations", .run = incur.handler(migrate) });
    try cli.group(db);

    try cli.group(try incur.Cli.create(gpa, "hi", .{ .description = "Leaf CLI", .aliases = &.{"hey"}, .root = .{ .run = incur.handler(hi) } }));
    return cli;
}

/// A greeting CLI, declared as a command.
const Greet = struct {
    name: []const u8,
    loud: ?bool = null,

    pub const incur = .{
        .name = "greet",
        .description = "A greeting CLI",
        .fields = .{
            .name = .{ .arg = true, .description = "Name to greet" },
            .loud = .{ .description = "Shout" },
        },
    };
};

fn greetRoot(c: *Context(.{}), greet_: Greet) !Outcome {
    const prefix = if (greet_.loud == true) "HELLO" else "hello";
    return c.ok(.{ .message = try std.fmt.allocPrint(c.allocator, "{s} {s}", .{ prefix, greet_.name }) });
}

fn greetBanner(_: std.Io, _: Allocator) !?[]const u8 {
    return "Greet banner";
}

fn greetCli(gpa: Allocator) !*incur.Cli {
    const cli = try incur.cli(Greet, gpa, .{ .update = null, .banner = .{ .mode = .agent, .render = greetBanner } });
    errdefer cli.destroy();
    try cli.handle(Greet, greetRoot);
    return cli;
}

const Globals = struct {
    verbose: ?bool = null,
    profile: []const u8 = "dev",
    debug: f64 = 0,

    pub const incur = .{ .fields = .{
        .verbose = .{ .description = "Verbose output", .alias = 'V' },
        .profile = .{ .description = "Profile name", .alias = 'P' },
        .debug = .{ .description = "Debug level", .count = true, .alias = 'D' },
    } };
};

const ShowOptions = struct {
    name: ?[]const u8 = null,
    all: ?bool = null,

    pub const incur = .{ .fields = .{
        .name = .{ .description = "Name", .alias = 'n' },
        .all = .{ .description = "All", .alias = 'a' },
    } };
};

const Color = enum { red, green };
const Mode = enum { fast };

const PickOptions = struct {
    color: ?Color = null,
    mode: ?Mode = null,

    pub const incur = .{ .fields = .{
        .color = .{ .description = "Color" },
        .mode = .{ .description = "Mode" },
    } };
};

fn globLoader(load: *incur.Config.Load, path: ?[]const u8) !?Value {
    const name = path orelse "";
    if (std.mem.endsWith(u8, name, "none.json")) return null;
    if (std.mem.endsWith(u8, name, "array.json")) return try incur.encode(load.allocator, .{1});
    if (std.mem.endsWith(u8, name, "throw.json")) return load.fail(.{ .message = "loader failed" });
    var message: []const u8 = undefined;
    return try incur.json.parse(load.allocator, "{\"commands\":{\"show\":{\"options\":{\"name\":\"loaded\"}}}}", &message);
}

fn show(c: *Context(.{ .options = ShowOptions })) !Outcome {
    const parsed = try c.globalsAs(Globals);
    _ = .{ parsed.verbose, parsed.profile, parsed.debug };
    return c.ok(.{ .globals = c.globals, .name = c.options.name });
}

fn pick(c: *Context(.{ .options = PickOptions })) !Outcome {
    return c.ok(.{ .color = c.options.color });
}

fn globBanner(_: std.Io, _: Allocator) !?[]const u8 {
    return "Glob banner";
}

fn globals(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "glob", .{
        .update = null,
        .description = "Global options",
        .banner = .{ .mode = .human, .render = globBanner },
        .config = .{ .flag = "config", .loader = globLoader },
        .globals = incur.schema(Globals),
    });
    errdefer cli.destroy();
    try cli.command("show", .{ .description = "Show globals", .run = incur.handler(show) });
    try cli.command("pick", .{ .description = "Pick a color", .run = incur.handler(pick) });
    return cli;
}

const EchoArgs = struct {
    text: []const u8,

    pub const incur = .{ .fields = .{ .text = .{ .description = "Text" } } };
};

const Meta = struct {
    a: []const u8,

    pub const incur = .{ .fields = .{ .a = .{ .description = "A" } } };
};

const EchoOptions = struct {
    upper: ?bool = null,
    prefix: []const u8 = ">",
    tags: ?[]const []const u8 = null,
    meta: ?Meta = null,
    extra: ?Value = null,

    pub const incur = .{ .fields = .{
        .upper = .{ .description = "Uppercase" },
        .prefix = .{ .description = "Prefix" },
        .tags = .{ .description = "Tags" },
        .meta = .{ .description = "Meta" },
        .extra = .{ .description = "Extra" },
    } };
};

const CfgEnv = struct {
    cfg_limit: ?f64 = null,

    pub const incur = .{ .rename_all = .screaming_snake_case, .fields = .{ .cfg_limit = .{ .description = "Limit" } } };
};

const CfgGlobals = struct {
    trace: ?bool = null,

    pub const incur = .{ .fields = .{ .trace = .{ .description = "Trace" } } };
};

const LimitOptions = struct {
    limit: f64 = 10,

    pub const incur = .{ .fields = .{ .limit = .{ .description = "Limit" } } };
};

fn echo(c: *Context(.{ .args = EchoArgs, .options = EchoOptions })) !Outcome {
    const text = if (c.options.upper == true) try std.ascii.allocUpperString(c.allocator, c.args.text) else c.args.text;
    return c.ok(.{ .out = try std.fmt.allocPrint(c.allocator, "{s} {s}", .{ c.options.prefix, text }) });
}

fn ping(c: *Context(.{})) !Outcome {
    return c.ok("pong");
}

fn projectList(c: *Context(.{ .options = LimitOptions })) !Outcome {
    return c.ok(.{ .limit = c.options.limit });
}

fn cfg(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "cfg", .{
        .update = null,
        .description = "Config defaults",
        .config = .{ .flag = "config", .files = &.{"config/cfg.json"} },
        .env = incur.schema(CfgEnv),
        .globals = incur.schema(CfgGlobals),
    });
    errdefer cli.destroy();
    try cli.command("echo", .{ .description = "Echo text", .run = incur.handler(echo) });
    try cli.command("ping", .{ .description = "Ping", .run = incur.handler(ping) });
    const project = try incur.Cli.create(gpa, "project", .{ .description = "Projects" });
    try project.command("list", .{ .description = "List projects", .run = incur.handler(projectList) });
    try cli.group(project);
    return cli;
}

/// No skills, JSON by default: commands declared as a group.
const Plain = union(enum) {
    hello,
    ping,
    hello_loud,
    v2,
    pin,

    pub const incur = .{
        .name = "plain",
        .aliases = &.{ "pl", "plain-cli" },
        .description = "No skills, JSON by default",
        .fields = .{
            .hello = .{ .description = "Say hello" },
            .hello_loud = .{ .name = "Hello", .description = "Say hello loudly" },
            .v2 = .{ .description = "Version two" },
            .pin = .{ .name = "ピン", .description = "Katakana ping" },
        },
    };
};

fn plainCommand(c: *Context(.{}), command: Plain) !Outcome {
    return switch (command) {
        .hello => c.ok(.{ .hello = "world" }),
        .ping => c.ok("pong"),
        .hello_loud => c.ok(.{ .hello = "WORLD" }),
        .v2 => c.ok(.{ .v = 2 }),
        .pin => c.ok("ポン"),
    };
}

fn plainBanner(_: std.Io, _: Allocator) !?[]const u8 {
    return "Welcome to plain";
}

fn plain(gpa: Allocator) !*incur.Cli {
    const cli = try incur.cli(Plain, gpa, .{
        .update = null,
        .sync = null,
        .format = .json,
        .config = .{},
        .banner = .{ .mode = .all, .render = plainBanner },
    });
    errdefer cli.destroy();
    try cli.handle(Plain, plainCommand);
    return cli;
}

const RootedArgs = struct {
    query: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .query = .{ .description = "Query" } } };
};

fn rootedRoot(c: *Context(.{ .args = RootedArgs })) !Outcome {
    return c.ok(.{ .query = c.args.query });
}

fn sub(c: *Context(.{})) !Outcome {
    return c.ok(.{ .sub = true });
}

fn leaf(c: *Context(.{})) !Outcome {
    return c.ok(.{ .leaf = true });
}

fn rooted(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "rooted", .{
        .update = null,
        .description = "Root with subcommands",
        .config = .{ .files = &.{"config/cfg.json"} },
        .root = .{ .run = incur.handler(rootedRoot) },
    });
    errdefer cli.destroy();
    try cli.command("sub", .{ .description = "A subcommand", .run = incur.handler(sub) });
    const nest = try incur.Cli.create(gpa, "nest", .{ .description = "Nested commands" });
    try nest.command("leaf", .{ .description = "A nested leaf", .run = incur.handler(leaf) });
    try cli.group(nest);
    return cli;
}

const ShadowSkillArgs = struct {
    id: []const u8,

    pub const incur = .{ .fields = .{ .id = .{ .description = "Skill id" } } };
};

fn shadowAdd(c: *Context(.{})) !Outcome {
    return c.ok(.{ .added = true });
}

fn shadowSkill(c: *Context(.{ .args = ShadowSkillArgs })) !Outcome {
    return c.ok(.{ .id = c.args.id });
}

fn shadowShell(c: *Context(.{})) !Outcome {
    return c.ok(.{ .shell = true });
}

fn shadow(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "shadow", .{ .update = null, .description = "Commands named like built-ins" });
    errdefer cli.destroy();
    const mcp = try incur.Cli.create(gpa, "mcp", .{ .description = "Manage servers" });
    try mcp.command("add", .{ .description = "Add a server", .run = incur.handler(shadowAdd) });
    try cli.group(mcp);
    try cli.command("skill", .{ .description = "Show a skill", .run = incur.handler(shadowSkill) });
    try cli.command("shell", .{ .description = "Show the shell", .aliases = &.{"completions"}, .run = incur.handler(shadowShell) });
    return cli;
}

fn shadowallRoot(c: *Context(.{})) !Outcome {
    return c.ok(.{ .root = true });
}

fn shadowallMcp(c: *Context(.{})) !Outcome {
    return c.ok(.{ .mcp = true });
}

fn shadowallCompletions(c: *Context(.{})) !Outcome {
    return c.ok(.{ .completions = true });
}

fn shadowall(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "shadowall", .{ .update = null, .sync = null, .description = "Every built-in shadowed", .root = .{ .run = incur.handler(shadowallRoot) } });
    errdefer cli.destroy();
    try cli.command("mcp", .{ .description = "User mcp", .run = incur.handler(shadowallMcp) });
    try cli.command("completions", .{ .description = "User completions", .run = incur.handler(shadowallCompletions) });
    return cli;
}

const ToolsEnv = struct {
    tools_region: []const u8 = "eu",

    pub const incur = .{ .rename_all = .screaming_snake_case, .fields = .{ .tools_region = .{ .description = "Region" } } };
};

const ToolsGlobals = struct {
    profile: []const u8 = "dev",
    verbose: ?bool = null,

    pub const incur = .{ .fields = .{ .profile = .{ .description = "Profile" }, .verbose = .{ .description = "Verbose output" } } };
};

const ToolEchoArgs = struct {
    text: []const u8,

    pub const incur = .{ .fields = .{ .text = .{ .description = "Text to echo" } } };
};

const ToolEchoOptions = struct {
    upper: bool = false,
    times: i64 = 1,

    pub const incur = .{ .fields = .{ .upper = .{ .description = "Uppercase" }, .times = .{ .description = "Repeat count", .min = 1, .max = 3 } } };
};

const ToolEchoOutput = struct {
    text: []const u8,

    pub const incur = .{ .fields = .{ .text = .{ .description = "Echoed text" } } };
};

const LabelOptions = struct {
    label: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .label = .{ .description = "Label" } } };
};

const TokenEnv = struct {
    tools_token: ?[]const u8 = null,

    pub const incur = .{ .rename_all = .screaming_snake_case, .fields = .{ .tools_token = .{ .description = "Token" } } };
};

const RequiredTokenEnv = struct {
    tools_token: []const u8,

    pub const incur = .{ .rename_all = .screaming_snake_case, .fields = .{ .tools_token = .{ .description = "Token" } } };
};

const ProfileArgs = struct {
    profile: []const u8,

    pub const incur = .{ .fields = .{ .profile = .{ .description = "Profile argument" } } };
};

const TargetArgs = struct {
    target: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .target = .{ .description = "Target" } } };
};

const OpsListOptions = struct {
    limit: f64 = 2,

    pub const incur = .{ .fields = .{ .limit = .{ .description = "Limit" } } };
};

fn traceRoot(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const region = c.env.get("TOOLS_REGION").?.string;
    try c.set("trace", .{ .string = try std.fmt.allocPrint(c.allocator, "root:{s}:{s}", .{ c.command, region }) });
    try next.run(c);
}

fn traceOps(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const trace = c.get("trace").?.string;
    try c.set("trace", .{ .string = try std.fmt.allocPrint(c.allocator, "{s}>ops", .{trace}) });
    try next.run(c);
}

fn needsVerbose(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const verbose = c.globals.get("verbose") orelse Value.null;
    if (!(verbose == .bool and verbose.bool)) return c.fail(.{ .code = "NEEDS_VERBOSE", .message = "pass verbose" });
    try next.run(c);
}

fn toolEcho(c: *Context(.{ .args = ToolEchoArgs, .options = ToolEchoOptions })) !Outcome {
    const a = c.allocator;
    const text = if (c.options.upper) try std.ascii.allocUpperString(a, c.args.text) else c.args.text;
    const parts = try a.alloc([]const u8, @intCast(c.options.times));
    @memset(parts, text);
    return c.ok(.{ .text = try std.mem.join(a, " ", parts) });
}

fn toolContext(c: *Context(.{ .options = LabelOptions, .env = TokenEnv })) !Outcome {
    return c.ok(.{ .agent = c.agent, .format = c.format, .globals = c.globals, .label = c.options.label, .token = c.env.tools_token, .trace = c.get("trace") });
}

fn toolNamed(c: *Context(.{ .args = ProfileArgs })) !Outcome {
    return c.ok(.{ .arg = c.args.profile, .global = c.globals.get("profile") });
}

fn toolDeploy(c: *Context(.{ .env = RequiredTokenEnv })) !Outcome {
    return c.ok(.{ .deployed = c.env.tools_token });
}

fn toolFail(c: *Context(.{})) !Outcome {
    return c.fail(.{
        .code = "QUOTA",
        .message = "Quota exceeded",
        .hint = "Wait a minute.",
        .retryable = true,
        .exit_code = 4,
        .cta = .{ .commands = &.{
            .{ .command = "echo", .args = &.{.{ .key = "text", .value = .{ .string = "retry" } }}, .description = "Try again" },
            .{ .command = "context", .options = &.{.{ .key = "label", .value = .{ .bool = true } }} },
        } },
    });
}

fn plainFail(c: *Context(.{})) !Outcome {
    return c.fail(.{ .code = "NOPE", .message = "nope" });
}

fn throws(c: *Context(.{})) !Outcome {
    return c.fail(.{ .message = "kaput" });
}

fn suggest(c: *Context(.{})) !Outcome {
    return (try c.ok(.{ .done = true })).withCta(.{ .description = "Then:", .commands = &.{ .{ .command = "echo next" }, .{ .command = "tools fail" } } });
}

fn chunkN(a: Allocator, value: i64) !Value {
    return incur.encode(a, .{ .n = value });
}

fn toolStream(c: *Context(.{})) !Outcome {
    const chunks = try c.allocator.dupe(incur.Chunk, &.{ .{ .data = try chunkN(c.allocator, 1) }, .{ .data = .{ .string = "two" } } });
    return (try c.streamSlice(chunks)).withCta(.{ .commands = &.{.{ .command = "echo done" }} });
}

fn streamPlain(c: *Context(.{})) !Outcome {
    return c.streamSlice(try c.allocator.dupe(incur.Chunk, &.{.{ .data = try chunkN(c.allocator, 1) }}));
}

fn streamBroke(c: *Context(.{})) !Outcome {
    return c.streamSlice(try c.allocator.dupe(incur.Chunk, &.{
        .{ .data = try chunkN(c.allocator, 1) },
        .{ .failure = .{ .code = "BROKEN", .message = "stream broke", .cta = .{ .commands = &.{.{ .command = "stream" }} } } },
        .{ .data = try chunkN(c.allocator, 2) },
    }));
}

fn streamThrow(c: *Context(.{})) !Outcome {
    return c.streamSlice(try c.allocator.dupe(incur.Chunk, &.{ .{ .data = try chunkN(c.allocator, 1) }, .{ .failure = .{ .message = "stream threw" } } }));
}

fn streamReturnError(c: *Context(.{})) !Outcome {
    return c.streamSlice(try c.allocator.dupe(incur.Chunk, &.{ .{ .data = try chunkN(c.allocator, 1) }, .{ .failure = .{ .code = "LATE", .message = "failed at the end" } } }));
}

fn plainScalar(c: *Context(.{})) !Outcome {
    return c.ok("plain");
}

fn hidden(c: *Context(.{})) !Outcome {
    return c.ok(.{ .hidden = true });
}

fn renamed(c: *Context(.{})) !Outcome {
    return c.ok(.{ .renamed = true });
}

fn guarded(c: *Context(.{})) !Outcome {
    return c.ok(.{ .trace = c.get("trace") });
}

fn opsRoot(c: *Context(.{ .args = TargetArgs })) !Outcome {
    return c.ok(.{ .ops = c.args.target orelse "all" });
}

fn opsList(c: *Context(.{ .options = OpsListOptions })) !Outcome {
    return c.ok(.{ .limit = c.options.limit, .trace = c.get("trace") });
}

fn peek(c: *Context(.{})) !Outcome {
    return c.ok(.{ .peek = true });
}

/// Builds a CLI that exercises MCP tool behaviors. `tools` and `catalog` differ only in `mcp`.
fn toolCli(gpa: Allocator, name: []const u8, mcp: incur.Mcp) !*incur.Cli {
    const trace: []const Value.Entry = &.{.{ .key = "trace", .value = .{ .string = "none" } }};
    const cli = try incur.Cli.create(gpa, name, .{
        .description = "MCP tool behaviors",
        .version = "2.0.0",
        .update = null,
        .sync = null,
        .mcp = mcp,
        .config = .{},
        .env = incur.schema(ToolsEnv),
        .globals = incur.schema(ToolsGlobals),
        .vars = trace,
    });
    errdefer cli.destroy();
    try cli.use(traceRoot);
    try cli.command("echo", .{
        .description = "Echo text back",
        .aliases = &.{"say"},
        .output = incur.schema(ToolEchoOutput),
        .mcp = .{ .annotations = .{ .title = "Echo", .read_only_hint = true, .destructive_hint = false, .idempotent_hint = true, .open_world_hint = false } },
        .run = incur.handler(toolEcho),
    });
    try cli.command("context", .{ .description = "Show globals, env, and vars", .run = incur.handler(toolContext) });
    try cli.command("named", .{
        .description = "Positional named like a global",
        .mcp = .{ .title = "Named", .icons = &.{.{ .src = "https://example.com/named.svg", .sizes = &.{"any"}, .theme = .light }} },
        .run = incur.handler(toolNamed),
    });
    try cli.command("deploy", .{ .description = "Deploy with a required token", .destructive = true, .run = incur.handler(toolDeploy) });
    try cli.command("fail", .{ .description = "Fail with details", .run = incur.handler(toolFail) });
    try cli.command("plain-fail", .{ .description = "Fail without details", .run = incur.handler(plainFail) });
    try cli.command("throws", .{ .description = "Throw an error", .run = incur.handler(throws) });
    try cli.command("suggest", .{ .description = "Return data with suggestions", .run = incur.handler(suggest) });
    try cli.command("stream", .{ .description = "Stream chunks", .run = incur.handler(toolStream) });
    try cli.command("stream-plain", .{ .description = "Stream without suggestions", .run = incur.handler(streamPlain) });
    try cli.command("stream-fail", .{ .description = "Stream then fail", .run = incur.handler(streamBroke) });
    try cli.command("stream-throw", .{ .description = "Stream then throw", .run = incur.handler(streamThrow) });
    try cli.command("stream-return-error", .{ .description = "Stream then return an error", .run = incur.handler(streamReturnError) });
    try cli.command("scalar", .{ .description = "Return a string", .output = incur.schema([]const u8), .run = incur.handler(plainScalar) });
    try cli.command("nothing", .{ .description = "Return nothing", .run = incur.handler(nothing) });
    try cli.command("hidden", .{ .description = "Hidden from MCP", .mcp = null, .run = incur.handler(hidden) });
    try cli.command("renamed", .{
        .description = "Renamed for MCP",
        .mcp = .{ .name = "custom_tool", .description = "A custom tool", .instructions = "Call sparingly." },
        .run = incur.handler(renamed),
    });
    try cli.command("guarded", .{ .description = "Requires --verbose", .middleware = &.{needsVerbose}, .run = incur.handler(guarded) });
    const ops = try incur.Cli.create(gpa, "ops", .{ .description = "Operations", .vars = trace, .root = .{ .run = incur.handler(opsRoot) } });
    try ops.use(traceOps);
    try ops.command("list", .{ .description = "List operations", .run = incur.handler(opsList) });
    try cli.group(ops);
    const private = try incur.Cli.create(gpa, "private", .{ .description = "Hidden group", .mcp = null });
    try private.command("peek", .{ .description = "Peek", .run = incur.handler(peek) });
    try cli.group(private);
    return cli;
}

fn tools(gpa: Allocator) !*incur.Cli {
    return toolCli(gpa, "tools", .{ .instructions = "Use echo for testing.", .title = "Tool Box", .tools = .{ .discovery = .direct } });
}

fn catalog(gpa: Allocator) !*incur.Cli {
    return toolCli(gpa, "catalog", .{ .tools = .{
        .include = &.{ "echo", "ops*", "stream*", "fail", "context", "named", "deploy" },
        .exclude = &.{"stream-throw"},
    } });
}

const ParamArgs = struct {
    id: []const u8,

    pub const incur = .{ .fields = .{ .id = .{ .description = "Item id" } } };
};

const ParamOptions = struct {
    limit: ?i64 = null,
    verbose: bool = false,
    tags: ?[]const []const u8 = null,

    pub const incur = .{ .omit_null = true, .fields = .{ .limit = .{ .description = "Limit" } } };
};

fn paramGet(c: *Context(.{ .args = ParamArgs, .options = ParamOptions })) !Outcome {
    var out: incur.ObjectBuilder = .{};
    try out.put(c.allocator, "id", .{ .string = c.args.id });
    for ((try incur.encode(c.allocator, c.options)).object) |entry| try out.put(c.allocator, entry.key, entry.value);
    return c.ok(out.finish());
}

fn okTrue(c: *Context(.{})) !Outcome {
    return c.ok(.{ .ok = true });
}

/// Exercises MCP tool titles, icons, `x-mcp-header` declarations, and cache hints.
fn paramsCli(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "params", .{
        .description = "MCP tool metadata",
        .version = "1.0.0",
        .update = null,
        .sync = null,
        .mcp = .{ .cache = .{ .ttl_ms = 60000, .cache_scope = .public }, .tools = .{ .discovery = .direct } },
    });
    errdefer cli.destroy();
    try cli.command("get", .{
        .description = "Get an item",
        .mcp = .{
            .title = "Get item",
            .icons = &.{
                .{ .src = "https://example.com/get.png", .mime_type = "image/png", .sizes = &.{"48x48"} },
                .{ .src = "data:image/svg+xml;base64,PHN2Zy8+", .theme = .dark },
            },
            .headers = &.{ .{ .input = "id", .name = "Item-Id" }, .{ .input = "limit", .name = "Limit" }, .{ .input = "verbose", .name = "Verbose" } },
        },
        .run = incur.handler(paramGet),
    });
    try cli.command("blank", .{ .description = "Empty title", .mcp = .{ .title = "" }, .run = incur.handler(okTrue) });
    return cli;
}

const ReviewStyle = enum { brief, deep };

const ReviewArgs = struct {
    code: []const u8,
    style: ReviewStyle = .brief,
    focus: ?[]const u8 = null,

    pub const incur = .{
        .omit_null = true,
        .fields = .{ .code = .{ .description = "Code to review" }, .style = .{ .description = "Depth" } },
    };
};

/// Returns the values in `options` that start with `value`.
fn prefixed(a: Allocator, options: []const []const u8, value: []const u8) Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    for (options) |o| if (std.mem.startsWith(u8, o, value)) try out.append(a, o);
    return out.items;
}

fn readme(a: Allocator) Allocator.Error!Value {
    _ = a;
    return .{ .string = "# Knowledge base" };
}

fn logo(a: Allocator) Allocator.Error!Value {
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "blob", .{ .string = "iVBORw0K" });
    try out.put(a, "mimeType", .{ .string = "image/png" });
    return out.finish();
}

fn pair(a: Allocator) Allocator.Error!Value {
    var first: incur.ObjectBuilder = .{};
    try first.put(a, "text", .{ .string = "one" });
    var second: incur.ObjectBuilder = .{};
    try second.put(a, "uri", .{ .string = "kb://pair#2" });
    try second.put(a, "text", .{ .string = "two" });
    try second.put(a, "mimeType", .{ .string = "text/csv" });
    return .{ .array = try a.dupe(Value, &.{ first.finish(), second.finish() }) };
}

fn docsRead(a: Allocator, uri: []const u8, v: Value) Allocator.Error!Value {
    return .{ .string = try std.fmt.allocPrint(a, "{s}/{s} at {s}", .{ v.get("section").?.string, v.get("page").?.string, uri }) };
}

fn sectionComplete(a: Allocator, value: []const u8, chosen: Value) Allocator.Error![]const []const u8 {
    _ = chosen;
    return prefixed(a, &.{ "guide", "api" }, value);
}

fn pageComplete(a: Allocator, value: []const u8, chosen: Value) Allocator.Error![]const []const u8 {
    const section = if (chosen.get("section")) |s| s.string else "";
    const pages: []const []const u8 = if (std.mem.eql(u8, section, "guide"))
        &.{ "intro", "install" }
    else if (std.mem.eql(u8, section, "api")) &.{ "cli", "mcp" } else &.{};
    return prefixed(a, pages, value);
}

fn numRead(a: Allocator, uri: []const u8, v: Value) Allocator.Error!Value {
    _ = uri;
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "text", v.get("n").?);
    return out.finish();
}

fn pairsRead(a: Allocator, uri: []const u8, v: Value) Allocator.Error!Value {
    _ = uri;
    return .{ .string = try std.fmt.allocPrint(a, "{s}|{s}", .{ v.get("a").?.string, v.get("b").?.string }) };
}

fn packagesRead(a: Allocator, uri: []const u8, v: Value) Allocator.Error!Value {
    _ = uri;
    return .{ .string = try std.fmt.allocPrint(a, "{s} {s} {s}", .{ v.get("name").?.string, v.get("version").?.string, v.get("os").?.string }) };
}

fn numComplete(a: Allocator, value: []const u8, chosen: Value) Allocator.Error![]const []const u8 {
    _ = chosen;
    const out = try a.alloc([]const u8, 150);
    for (out, 0..) |*slot, i| slot.* = try std.fmt.allocPrint(a, "{s}{d}", .{ value, i });
    return out;
}

fn styleComplete(a: Allocator, value: []const u8, chosen: Value) Allocator.Error![]const []const u8 {
    _ = chosen;
    return prefixed(a, &.{ "brief", "deep" }, value);
}

fn reviewGet(a: Allocator, args: Value) Allocator.Error!Value {
    var text: incur.ObjectBuilder = .{};
    try text.put(a, "type", .{ .string = "text" });
    try text.put(a, "text", .{ .string = try std.fmt.allocPrint(a, "Review ({s}): {s}", .{ args.get("style").?.string, args.get("code").?.string }) });
    var user: incur.ObjectBuilder = .{};
    try user.put(a, "role", .{ .string = "user" });
    try user.put(a, "content", text.finish());
    var resource: incur.ObjectBuilder = .{};
    try resource.put(a, "uri", .{ .string = "kb://readme" });
    try resource.put(a, "mimeType", .{ .string = "text/markdown" });
    try resource.put(a, "text", args.get("focus") orelse .{ .string = "all" });
    var content: incur.ObjectBuilder = .{};
    try content.put(a, "type", .{ .string = "resource" });
    try content.put(a, "resource", resource.finish());
    var assistant: incur.ObjectBuilder = .{};
    try assistant.put(a, "role", .{ .string = "assistant" });
    try assistant.put(a, "content", content.finish());
    return .{ .array = try a.dupe(Value, &.{ user.finish(), assistant.finish() }) };
}

fn helloGet(a: Allocator, args: Value) Allocator.Error!Value {
    return .{ .string = try std.fmt.allocPrint(a, "Hello {s}", .{try incur.json.stringify(a, args)}) };
}

fn pong(c: *Context(.{})) !Outcome {
    return c.ok(.{ .pong = true });
}

const kb_resources = [_]incur.mcp.Resource{
    .{ .uri = "kb://readme", .name = "readme", .title = "Read me", .description = "Start here", .mime_type = "text/markdown", .icons = &.{.{ .src = "https://example.com/readme.png" }}, .read = readme },
    .{ .uri = "kb://logo", .name = "logo", .read = logo },
    .{ .uri = "kb://pair", .name = "pair", .mime_type = "text/plain", .read = pair },
};

const kb_templates = [_]incur.mcp.ResourceTemplate{
    .{
        .uri_template = "docs://{section}/{page}",
        .name = "docs",
        .title = "Docs",
        .description = "A docs page",
        .mime_type = "text/plain",
        .icons = &.{.{ .src = "https://example.com/docs.png", .mime_type = "image/png" }},
        .complete = &.{ .{ .name = "section", .complete = sectionComplete }, .{ .name = "page", .complete = pageComplete } },
        .read = docsRead,
    },
    .{ .uri_template = "num://{n}.txt", .name = "numbers", .complete = &.{.{ .name = "n", .complete = numComplete }}, .read = numRead },
    .{ .uri_template = "pkg://{name}-{version}-{os}.zip", .name = "packages", .read = packagesRead },
    .{ .uri_template = "kv://{a}{b}", .name = "pairs", .read = pairsRead },
};

const kb_prompts = [_]incur.mcp.Prompt{
    .{
        .name = "review",
        .title = "Review code",
        .description = "Review a snippet",
        .icons = &.{.{ .src = "https://example.com/review.svg", .theme = .dark }},
        .args = incur.schema(ReviewArgs),
        .complete = &.{.{ .name = "style", .complete = styleComplete }},
        .get = reviewGet,
    },
    .{ .name = "hello", .get = helloGet },
};

/// Exercises MCP resources, resource templates, prompts, and completion.
fn kb(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "kb", .{
        .description = "Knowledge base",
        .version = "1.0.0",
        .update = null,
        .sync = null,
        .mcp = .{
            .cache = .{ .ttl_ms = 5000 },
        },
    });
    errdefer cli.destroy();
    for (kb_resources) |r| try cli.resource(r);
    for (kb_templates) |t| try cli.resourceTemplate(t);
    for (kb_prompts) |p| try cli.prompt(p);
    try cli.command("ping", .{ .description = "Ping", .run = incur.handler(pong) });
    return cli;
}

fn empty(a: Allocator, uri: []const u8, v: Value) Allocator.Error!Value {
    _ = .{ a, uri, v };
    return .{ .string = "" };
}

/// A resource template incur cannot match.
const Role = enum { dev, ops };

const Profile = struct {
    name: []const u8,
    age: ?i64 = null,
    role: Role = .dev,
    subscribe: ?bool = null,

    pub const incur = .{
        .omit_null = true,
        .fields = .{ .name = .{ .description = "Your name" }, .age = .{ .min = 0 } },
    };
};

const NameInput = struct { name: []const u8 };
const ColorInput = struct { color: []const u8 };
const GoInput = struct { go: bool };
const NoteInput = struct {
    note: ?[]const u8 = null,

    pub const incur = .{ .omit_null = true };
};

/// Renders an answer as the TypeScript fixture returns it.
fn answerValue(a: Allocator, answer: anytype) Allocator.Error!Value {
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "action", .{ .string = @tagName(answer.action) });
    if (@TypeOf(answer.content) != ?void) if (answer.content) |content| try out.put(a, "content", try incur.encode(a, content));
    return out.finish();
}

fn askProfile(c: *Context(.{})) !Outcome {
    const a = c.allocator;
    const answer = try c.elicit(Profile, "Who are you?");
    const content = answer.content orelse return c.ok(try answerValue(a, answer));
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "greeting", .{ .string = try std.fmt.allocPrint(a, "Hi {s}", .{content.name}) });
    for ((try incur.encode(a, content)).object) |entry| try out.put(a, entry.key, entry.value);
    return c.ok(out.finish());
}

fn askPair(c: *Context(.{})) !Outcome {
    const a = c.allocator;
    const first = try c.elicit(NameInput, "Name?");
    const second = try c.elicit(ColorInput, "Color?");
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "first", try answerValue(a, first));
    try out.put(a, "second", try answerValue(a, second));
    return c.ok(out.finish());
}

fn askLink(c: *Context(.{})) !Outcome {
    return c.ok(try answerValue(c.allocator, try c.elicitUrl("Connect your account", "https://example.com/connect")));
}

fn askFallback(c: *Context(.{})) !Outcome {
    const a = c.allocator;
    if (c.elicit(NameInput, "Name?")) |answer| return c.ok(try answerValue(a, answer)) else |err| {
        _ = try c.failure.take(err);
        return c.ok(try answerValue(a, try c.elicitUrl("Use the website", "https://example.com/name")));
    }
}

const TitledName = struct { name: []const u8, title: []const u8 = "Dr" };

const NameOutput = struct { name: []const u8 };

fn askTyped(c: *Context(.{})) !Outcome {
    const a = c.allocator;
    const answer = try c.elicit(TitledName, "Name?");
    const name = if (answer.content) |given| try std.fmt.allocPrint(a, "{s} {s}", .{ given.title, given.name }) else @tagName(answer.action);
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "name", .{ .string = name });
    return c.ok(out.finish());
}

fn askNote(c: *Context(.{})) !Outcome {
    return c.ok(try answerValue(c.allocator, try c.elicit(NoteInput, "Any notes?")));
}

fn askWatch(c: *Context(.{})) !Outcome {
    const a = c.allocator;
    var start: incur.ObjectBuilder = .{};
    try start.put(a, "step", .{ .string = "start" });
    const second: incur.Chunk = if (c.elicit(GoInput, "Continue?")) |answer| chunk: {
        var out: incur.ObjectBuilder = .{};
        try out.put(a, "step", .{ .string = "answer" });
        try out.put(a, "answer", try answerValue(a, answer));
        break :chunk .{ .data = out.finish() };
    } else |err| .{ .failure = try c.failure.take(err) };
    return c.streamSlice(try a.dupe(incur.Chunk, &.{ .{ .data = start.finish() }, second }));
}

/// Exercises MCP elicitation through `input_required`.
fn ask(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "ask", .{
        .description = "MCP elicitation",
        .version = "1.0.0",
        .update = null,
        .sync = null,
        .mcp = .{ .tools = .{ .discovery = .direct } },
    });
    errdefer cli.destroy();
    try cli.command("profile", .{ .description = "Ask for a profile", .run = incur.handler(askProfile) });
    try cli.command("pair", .{ .description = "Ask twice", .run = incur.handler(askPair) });
    try cli.command("link", .{ .description = "Send the user to a URL", .run = incur.handler(askLink) });
    try cli.command("fallback", .{ .description = "Ask by URL when the form fails", .run = incur.handler(askFallback) });
    try cli.command("note", .{ .description = "Ask for optional input", .run = incur.handler(askNote) });
    try cli.command("typed", .{ .description = "Ask with an output schema", .output = incur.schema(NameOutput), .run = incur.handler(askTyped) });
    try cli.command("watch", .{ .description = "Ask while streaming", .run = incur.handler(askWatch) });
    return cli;
}

fn notes(a: Allocator) Allocator.Error!Value {
    _ = a;
    return .{ .string = "Notes" };
}

fn weather(c: *Context(.{})) !Outcome {
    return c.ok(.{ .temp = 20 });
}

fn emptyObject(c: *Context(.{})) !Outcome {
    return c.ok(.{});
}

/// Exercises MCP Apps: `ui://` views and the tools that link to them.
fn view(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "view", .{ .version = "1.0.0", .update = null, .sync = null, .mcp = .{ .tools = .{ .discovery = .direct } } });
    errdefer cli.destroy();
    try cli.resource(.{ .uri = "view://notes", .name = "notes", .read = notes });
    try cli.app(.{
        .uri = "ui://view/dashboard",
        .name = "dashboard",
        .title = "Dashboard",
        .description = "Weather dashboard",
        .html = "<!doctype html><p>Weather</p>",
        .csp = .{ .resource_domains = &.{"https://cdn.example.com"}, .connect_domains = &.{ "https://api.example.com", "wss://live.example.com" } },
        .prefers_border = true,
    });
    try cli.app(.{ .uri = "ui://view/plain", .name = "plain", .html = "<p>Plain</p>" });
    try cli.app(.{ .uri = "ui://view/framed", .name = "framed", .html = "", .csp = .{ .base_uri_domains = &.{"https://base.example.com"}, .frame_domains = &.{} }, .prefers_border = false });
    try cli.app(.{ .uri = "ui://view/open", .name = "open", .html = "<p>Open</p>", .csp = .{} });
    try cli.command("weather", .{ .description = "Show the weather", .mcp = .{ .app = "dashboard", .instructions = "Render it" }, .run = incur.handler(weather) });
    try cli.command("plain", .{ .description = "Plain view", .mcp = .{ .app = "plain" }, .run = incur.handler(okTrue) });
    try cli.command("other", .{ .description = "No view", .run = incur.handler(okTrue) });
    return cli;
}

/// Mounts a CLI whose command links to its own app. A parent app with the same name wins.
fn viewhost(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "viewhost", .{ .version = "1.0.0", .update = null, .sync = null, .mcp = .{ .tools = .{ .discovery = .direct } } });
    errdefer cli.destroy();
    try cli.app(.{ .uri = "ui://viewhost/chart", .name = "chart", .html = "<p>Host</p>" });
    const kid = try incur.Cli.create(gpa, "kid", .{ .description = "Mounted views" });
    errdefer kid.destroy();
    try kid.app(.{ .uri = "ui://kid/chart", .name = "chart", .html = "<p>Kid chart</p>" });
    try kid.app(.{ .uri = "ui://kid/table", .name = "table", .html = "<p>Kid table</p>" });
    try kid.command("chart", .{ .description = "Chart", .mcp = .{ .app = "chart" }, .run = incur.handler(emptyObject) });
    try kid.command("table", .{ .description = "Table", .mcp = .{ .app = "table" }, .run = incur.handler(emptyObject) });
    try cli.group(kid);
    return cli;
}

/// A command that links to an app the CLI never registers.
fn viewmissing(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "viewmissing", .{ .version = "1.0.0", .update = null, .sync = null });
    errdefer cli.destroy();
    try cli.app(.{ .uri = "ui://viewmissing/real", .name = "real", .html = "" });
    try cli.command("show", .{ .description = "Show", .mcp = .{ .app = "ghost" }, .run = incur.handler(emptyObject) });
    return cli;
}

/// An app whose URI is not a `ui://` URI.
fn viewscheme(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "viewscheme", .{ .version = "1.0.0", .update = null, .sync = null });
    errdefer cli.destroy();
    try cli.app(.{ .uri = "https://example.com/view", .name = "web", .html = "" });
    try cli.command("show", .{ .description = "Show", .run = incur.handler(emptyObject) });
    return cli;
}

fn kbbad(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "kbbad", .{ .version = "1.0.0", .update = null, .sync = null });
    errdefer cli.destroy();
    try cli.resourceTemplate(.{ .uri_template = "x://{+path}", .name = "bad", .read = empty });
    return cli;
}

const BadHeaderOptions = struct {
    a: []const u8,
    n: f64,
    tags: []const []const u8,
    b: ?[]const u8 = null,
};

fn badOk(c: *Context(.{ .options = BadHeaderOptions })) !Outcome {
    return c.ok(.{ .ok = true });
}

/// Builds a CLI whose one command declares an invalid `x-mcp-header`.
fn badHeaders(gpa: Allocator, name: []const u8, headers: []const incur.Header) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, name, .{ .version = "1.0.0", .update = null, .sync = null });
    errdefer cli.destroy();
    try cli.command("bad", .{ .description = "Invalid header", .mcp = .{ .headers = headers }, .run = incur.handler(badOk) });
    return cli;
}

fn hdrarray(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrarray", &.{.{ .input = "tags", .name = "Tags" }});
}

fn hdrdupe(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrdupe", &.{ .{ .input = "a", .name = "Same" }, .{ .input = "b", .name = "same" } });
}

fn hdrempty(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrempty", &.{.{ .input = "a", .name = "" }});
}

fn hdrkey(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrkey", &.{ .{ .input = "a", .name = "A" }, .{ .input = "missing", .name = "Missing" } });
}

fn hdrnewline(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrnewline", &.{.{ .input = "a", .name = "A\n" }});
}

fn hdrnumber(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrnumber", &.{.{ .input = "n", .name = "N" }});
}

fn hdrtoken(gpa: Allocator) !*incur.Cli {
    return badHeaders(gpa, "hdrtoken", &.{.{ .input = "a", .name = "Bad Header" }});
}

fn bare(gpa: Allocator) !*incur.Cli {
    return incur.Cli.create(gpa, "bare", .{ .update = null, .sync = null });
}

fn one(c: *Context(.{})) !Outcome {
    return c.ok(1);
}

fn two(c: *Context(.{})) !Outcome {
    return c.ok(2);
}

fn dupe(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "dupe", .{ .description = "Duplicate tool names", .update = null, .sync = null });
    errdefer cli.destroy();
    try cli.command("a_b", .{ .description = "Underscored", .run = incur.handler(one) });
    const group = try incur.Cli.create(gpa, "a", .{ .description = "Group" });
    try group.command("b", .{ .run = incur.handler(two) });
    try cli.group(group);
    return cli;
}

const WebGlobals = struct {
    region: []const u8 = "us",

    pub const incur = .{ .fields = .{ .region = .{ .description = "Region" } } };
};

const NameArgs = struct {
    name: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .name = .{ .description = "Name" } } };
};

const ItemArgs = struct {
    id: ?f64 = null,

    pub const incur = .{ .fields = .{ .id = .{ .description = "Item id" } } };
};

const ItemOptions = struct {
    limit: f64 = 10,
    tags: ?[]const []const u8 = null,
    verbose: ?bool = null,

    pub const incur = .{ .omit_null = true, .fields = .{
        .limit = .{ .description = "Limit" },
        .tags = .{ .description = "Tags" },
        .verbose = .{ .description = "Verbose" },
    } };
};

const CreateOptions = struct {
    title: []const u8,
    draft: bool = false,

    pub const incur = .{ .fields = .{ .title = .{ .description = "Title", .min = 1 }, .draft = .{ .description = "Draft" } } };
};

const CreateOutput = struct {
    title: []const u8,
    draft: bool,
};

fn webRoot(c: *Context(.{ .args = NameArgs })) !Outcome {
    return c.ok(.{ .root = true, .name = c.args.name, .region = c.globals.get("region") });
}

fn webItems(c: *Context(.{ .args = ItemArgs, .options = ItemOptions })) !Outcome {
    var out: incur.ObjectBuilder = .{};
    try out.put(c.allocator, "id", try incur.encode(c.allocator, c.args.id));
    for ((try incur.encode(c.allocator, c.options)).object) |entry| try out.put(c.allocator, entry.key, entry.value);
    try out.put(c.allocator, "region", c.globals.get("region").?);
    return c.ok(out.finish());
}

fn webCreate(c: *Context(.{ .options = CreateOptions })) !Outcome {
    return c.ok(c.options);
}

fn webRequest(c: *Context(.{})) !Outcome {
    const request = c.request orelse return c.ok(.{ .agent = null, .method = null, .url = null });
    return c.ok(.{ .agent = request.headers.get("x-agent"), .method = request.method, .url = request.url });
}

fn webStream(c: *Context(.{})) !Outcome {
    const chunks = try c.allocator.dupe(incur.Chunk, &.{ .{ .data = try chunkN(c.allocator, 1) }, .{ .data = try chunkN(c.allocator, 2) } });
    return (try c.streamSlice(chunks)).withCta(.{ .commands = &.{.{ .command = "items" }} });
}

fn webStreamPlain(c: *Context(.{})) !Outcome {
    return c.streamSlice(try c.allocator.dupe(incur.Chunk, &.{.{ .data = .{ .string = "only" } }}));
}

fn webFail(c: *Context(.{})) !Outcome {
    return c.fail(.{ .code = "NOPE", .message = "nope", .retryable = false, .cta = .{ .commands = &.{.{ .command = "items" }} } });
}

fn euOnly(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const region = c.globals.get("region") orelse Value.null;
    if (!(region == .string and std.mem.eql(u8, region.string, "eu"))) return c.fail(.{ .code = "REGION", .message = "eu only" });
    try next.run(c);
}

fn stats(c: *Context(.{})) !Outcome {
    return c.ok(.{ .users = 3 });
}

fn web(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "web", .{
        .description = "HTTP serving",
        .version = "3.0.0",
        .update = null,
        .sync = null,
        .mcp = .{ .stateless = false },
        .globals = incur.schema(WebGlobals),
        .root = .{ .run = incur.handler(webRoot) },
    });
    errdefer cli.destroy();
    try cli.command("items", .{ .description = "List items", .run = incur.handler(webItems) });
    try cli.command("create", .{ .description = "Create an item", .output = incur.schema(CreateOutput), .run = incur.handler(webCreate) });
    try cli.command("request", .{ .description = "Inspect the HTTP request", .run = incur.handler(webRequest) });
    try cli.command("stream", .{ .description = "Stream chunks", .run = incur.handler(webStream) });
    try cli.command("stream-plain", .{ .description = "Stream without suggestions", .run = incur.handler(webStreamPlain) });
    try cli.command("stream-fail", .{ .description = "Stream then fail", .run = incur.handler(streamBroke) });
    try cli.command("stream-throw", .{ .description = "Stream then throw", .run = incur.handler(streamThrow) });
    try cli.command("stream-return-error", .{ .description = "Stream then return an error", .run = incur.handler(streamReturnError) });
    try cli.command("fail", .{ .description = "Fail with suggestions", .run = incur.handler(webFail) });
    try cli.command("throws", .{ .description = "Throw an error", .run = incur.handler(throws) });
    const admin_group = try incur.Cli.create(gpa, "admin", .{ .description = "Admin commands" });
    try admin_group.use(euOnly);
    try admin_group.command("stats", .{ .description = "Show stats", .run = incur.handler(stats) });
    try cli.group(admin_group);
    return cli;
}

const GatewayEnv = struct {
    gateway_mode: ?[]const u8 = null,

    pub const incur = .{ .rename_all = .screaming_snake_case, .fields = .{ .gateway_mode = .{ .description = "Mode" } } };
};

fn gatewayMode(c: *incur.MiddlewareContext, next: incur.Next) !void {
    const mode = if (c.env.get("GATEWAY_MODE")) |m| m.string else "";
    if (std.mem.eql(u8, mode, "deny")) return c.fail(.{ .code = "DENIED", .message = "gateway denied", .cta = .{ .commands = &.{.{ .command = "status" }} } });
    if (std.mem.eql(u8, mode, "throw")) return c.fail(.{ .message = "middleware threw" });
    try next.run(c);
}

fn okStatus(c: *Context(.{})) !Outcome {
    return c.ok(.{ .ok = true });
}

fn local(c: *Context(.{})) !Outcome {
    return c.ok(.{ .local = true });
}

/// The upstream API as a fetch source.
const upstream_source: incur.fetch.Source = .{ .handler = .of(upstream) };

fn gateway(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "gateway", .{ .description = "Fetch gateways", .update = null, .sync = null, .env = incur.schema(GatewayEnv) });
    errdefer cli.destroy();
    try cli.use(gatewayMode);
    try cli.gateway("api", .{ .description = "Upstream API", .fetch = upstream_source });
    try cli.gateway("v1", .{ .fetch = upstream_source, .base_path = "/v1" });
    try cli.gateway("hosted", .{ .description = "Hosted API", .fetch = incur.fetch.fromRequest("http://hosted.test/base/", &.{
        .{ .name = "authorization", .value = "Bearer hosted" },
        .{ .name = "x-default", .value = "yes" },
    }) });
    try cli.gateway("offline", .{ .description = "Unreachable API", .fetch = incur.fetch.fromRequest("http://offline.test", &.{}) });
    try cli.gateway("secret", .{ .description = "Agent-only API", .fetch = upstream_source, .output_policy = .agent_only });
    try cli.command("status", .{ .description = "Local command", .run = incur.handler(okStatus) });
    const nested = try incur.Cli.create(gpa, "nested", .{ .description = "Nested gateways" });
    try nested.gateway("api", .{ .description = "Nested API", .fetch = upstream_source });
    try cli.group(nested);
    return cli;
}

fn proxy(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "proxy", .{ .description = "Root fetch with commands", .update = null, .sync = null, .fetch = upstream_source });
    errdefer cli.destroy();
    try cli.command("local", .{ .description = "Local command", .run = incur.handler(local) });
    return cli;
}

fn raw(gpa: Allocator) !*incur.Cli {
    return incur.Cli.create(gpa, "raw", .{ .description = "Root fetch only", .update = null, .sync = null, .fetch = upstream_source });
}

fn latestOperation(op: incur.openapi.Operation) bool {
    return !std.mem.eql(u8, op.method, "delete") and !std.mem.startsWith(u8, op.path, "/store");
}

fn searchOperation(op: incur.openapi.Operation) bool {
    return std.mem.eql(u8, op.path, "/search");
}

fn oa(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "oa", .{ .description = "OpenAPI commands", .update = null, .sync = null, .config = .{} });
    errdefer cli.destroy();
    try cli.gateway("ops", .{ .description = "Operation mode", .fetch = upstream_source, .openapi = .{ .json = pet_spec } });
    try cli.gateway("ns", .{ .description = "Namespace mode", .fetch = upstream_source, .base_path = "/base", .openapi = .{ .json = pet_spec }, .openapi_config = .{
        .mode = .namespace,
        .groups = &.{
            .{ .path = "pets", .description = "Pet operations" },
            .{ .path = "v2 users", .description = "Users (v2)" },
            .{ .path = "missing", .description = "Ignored" },
            .{ .path = "pets petId get", .description = "Leaf" },
        },
        .forward_headers = &.{ "x-forward", "x-api-key" },
    } });
    try cli.gateway("latest", .{ .description = "Latest versions only", .fetch = upstream_source, .openapi = .{ .json = pet_spec }, .openapi_config = .{
        .mode = .namespace,
        .versions = .latest,
        .security = false,
        .include = latestOperation,
    } });
    try cli.gateway("compact", .{ .description = "Compact schemas", .fetch = upstream_source, .openapi = .{ .json = pet_spec }, .openapi_config = .{ .compact = true, .include = searchOperation }, .mcp = false });
    try cli.gateway("composed", .{ .description = "Composed request bodies", .fetch = upstream_source, .openapi = .{ .json = composed_spec } });
    try cli.gateway("url", .{ .description = "Spec from a URL", .fetch = upstream_source, .openapi = .{ .url = "http://hosted.test/openapi.json" } });
    try cli.gateway("rel", .{ .description = "Spec relative to a hosted source", .fetch = incur.fetch.fromRequest("http://hosted.test/svc", &.{}), .openapi = .{ .url = "openapi.json" }, .output_policy = .agent_only });
    return cli;
}

fn oaroot(gpa: Allocator) !*incur.Cli {
    return incur.Cli.create(gpa, "oaroot", .{
        .description = "Root OpenAPI commands",
        .version = "0.1.0",
        .update = null,
        .sync = null,
        .fetch = upstream_source,
        .openapi = .{ .json = mini_spec },
        .openapi_config = .{ .mode = .namespace },
    });
}

/// A fake streamable-HTTP MCP server with canned tool results.
fn fakeMcp(a: Allocator, _: *const incur.Process, request: *const incur.http.Request) !incur.http.Response {
    var message_text: []const u8 = undefined;
    const message = try incur.json.parse(a, request.body orelse "", &message_text);
    const id = message.get("id") orelse .null;
    const method = message.get("method").?.string;
    const Reply = struct {
        fn send(al: Allocator, rpc_id: Value, result: []const u8) !incur.http.Response {
            return jsonResponse(al, try std.fmt.allocPrint(al, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}", .{ try incur.json.stringify(al, rpc_id), result }), 200);
        }
        fn text(al: Allocator, rpc_id: Value, items: []const []const u8) !incur.http.Response {
            var content: std.ArrayList(Value) = .empty;
            for (items) |t| {
                var item: incur.ObjectBuilder = .{};
                try item.put(al, "type", .{ .string = "text" });
                try item.put(al, "text", .{ .string = t });
                try content.append(al, item.finish());
            }
            var result: incur.ObjectBuilder = .{};
            try result.put(al, "content", .{ .array = content.items });
            return send(al, rpc_id, try incur.json.stringify(al, result.finish()));
        }
    };
    if (std.mem.eql(u8, method, "initialize")) {
        var response = try Reply.send(a, id, "{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"fake\",\"version\":\"1.0.0\"}}");
        try response.headers.set(a, "mcp-session-id", "fake-session");
        return response;
    }
    if (std.mem.eql(u8, method, "notifications/initialized")) return .{ .status = 202 };
    if (std.mem.eql(u8, method, "tools/list")) return Reply.send(a, id, fake_tools);
    const params = message.get("params") orelse Value{ .object = &.{} };
    const args = params.get("arguments") orelse Value{ .object = &.{} };
    const name = if (params.get("name")) |n| n.string else "";
    const eql = struct {
        fn f(x: []const u8, y: []const u8) bool {
            return std.mem.eql(u8, x, y);
        }
    }.f;
    if (eql(name, "structured")) {
        const n = if (args.get("count")) |c| c.toFloat() orelse std.math.nan(f64) else std.math.nan(f64);
        var structured: incur.ObjectBuilder = .{};
        try structured.put(a, "total", Value.fromFloat(n * 2));
        try structured.put(a, "args", args);
        return Reply.send(a, id, try std.fmt.allocPrint(a, "{{\"content\":[{{\"type\":\"text\",\"text\":\"ignored\"}}],\"structuredContent\":{s}}}", .{try incur.json.stringify(a, structured.finish())}));
    }
    if (eql(name, "headers")) {
        var out: incur.ObjectBuilder = .{};
        inline for (.{ .{ "session", "mcp-session-id" }, .{ "version", "mcp-protocol-version" }, .{ "custom", "x-custom" }, .{ "accept", "accept" } }) |entry| {
            try out.put(a, entry[0], if (request.headers.get(entry[1])) |v| .{ .string = v } else .null);
        }
        return Reply.text(a, id, &.{try incur.json.stringify(a, out.finish())});
    }
    if (eql(name, "mixed")) return Reply.text(a, id, &.{try incur.json.stringify(a, args)});
    if (eql(name, "texts")) return Reply.text(a, id, &.{ "first", "second" });
    if (eql(name, "words")) return Reply.text(a, id, &.{"just words"});
    if (eql(name, "none")) return Reply.send(a, id, "{}");
    if (eql(name, "tool-error")) return Reply.send(a, id, "{\"content\":[{\"type\":\"text\",\"text\":\"remote failed\"}],\"isError\":true}");
    if (eql(name, "silent-error")) return Reply.send(a, id, "{\"content\":[{\"type\":\"image\",\"data\":\"\"}],\"isError\":true}");
    if (eql(name, "rpc-error")) return jsonResponse(a, try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"error\":{{\"code\":-32000,\"message\":\"rpc failed\"}}}}", .{try incur.json.stringify(a, id)}), 200);
    if (eql(name, "http-error")) return incur.http.Response.text(a, "unavailable", 503, "text/plain;charset=UTF-8");
    if (eql(name, "sse")) return incur.http.Response.text(a, try std.fmt.allocPrint(a, "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\n\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{{\\\"via\\\":\\\"sse\\\"}}\"}}]}}}}\n\n", .{try incur.json.stringify(a, id)}), 200, "text/event-stream");
    if (eql(name, "sse-other")) return incur.http.Response.text(a, "data: {\"jsonrpc\":\"2.0\",\"id\":\"other\",\"result\":{}}\n\n", 200, "text/event-stream");
    return incur.http.Response.text(a, "", 200, "application/json");
}

/// The tools `fakeMcp` lists.
const fake_tools =
    \\{"tools":[{"name":"structured","description":"Structured result","inputSchema":{"type":"object","properties":{"count":{"type":"integer","description":"Count"},"label":{"type":"string"},"on":{"type":"boolean"},"ratio":{"type":["number","null"]},"tags":{"type":["array","null"],"items":{"type":"string"}},"ref":{"type":["string","array"],"items":{"type":"string"},"maxLength":3,"description":"Ref"},"size":{"type":["string","integer"]},"mode":{"type":["string","integer"],"default":"auto"},"strict":{"type":["string","boolean"]},"shape":{"type":["object","array","null"]}},"required":["count"]},"outputSchema":{"type":"object","properties":{"total":{"type":"number"}}},"annotations":{"readOnlyHint":true}},{"name":"mixed","description":"Required multi-type input","inputSchema":{"type":"object","properties":{"key":{"type":["string","array"],"items":{"type":"string"}}},"required":["key"]}},{"name":"headers","description":"Echo MCP headers"},{"name":"texts","description":"Two text items","outputSchema":{"type":"string"}},{"name":"words","description":"Non-JSON text"},{"name":"none","description":"No content"},{"name":"tool-error","description":"Tool error result"},{"name":"silent-error","description":"Tool error without text"},{"name":"rpc-error","description":"JSON-RPC error"},{"name":"http-error","description":"HTTP error"},{"name":"sse","description":"SSE response"},{"name":"sse-other","description":"SSE without a matching message"},{"name":"empty-body","description":"Empty response body"}]}
;

fn remote(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "remote", .{ .description = "Remote MCP servers", .update = null, .sync = null });
    errdefer cli.destroy();
    inline for (.{
        .{ "direct", "Direct discovery", "http://tools.test/mcp", tools },
        .{ "catalog", "Progressive discovery", "http://catalog.test/mcp", catalog },
        .{ "paged", "Progressive discovery across pages", "http://app.test/mcp", app },
        .{ "session", "Stateful server", "http://web.test/mcp", web },
    }) |entry| {
        const server = try entry[3](gpa);
        cli.own(server) catch |err| {
            server.destroy();
            return err;
        };
        try cli.mcpSource(entry[0], .{ .description = entry[1], .url = entry[2], .fetch = server.handler() });
    }
    try cli.mcpSource("fake", .{ .description = "Canned server", .output_policy = .agent_only, .url = "http://fake.test/mcp", .fetch = .of(fakeMcp), .headers = &.{.{ .name = "x-custom", .value = "yes" }} });
    try cli.command("local", .{ .description = "Local command", .run = incur.handler(local) });
    return cli;
}

const KitDeployArgs = struct {
    env: enum { staging, prod },

    pub const incur = .{ .fields = .{ .env = .{ .description = "Target environment" } } };
};

fn kitOk(c: *Context(.{})) !Outcome {
    return c.ok(.{ .ok = true });
}

fn kitDeploy(c: *Context(.{ .args = KitDeployArgs })) !Outcome {
    return c.ok(.{ .deployed = c.args.env });
}

/// Builds a CLI that syncs skills and registers MCP servers.
fn kitCli(gpa: Allocator, name: []const u8, options: struct { command: ?[]const u8 = null, cwd: ?[]const u8 = null, mcp: incur.Mcp = .{}, package: ?[]const u8 = null, version: []const u8 = "1.4.0" }) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, name, .{
        .description = "Skill and MCP sync",
        .version = options.version,
        .update = null,
        .package = options.package,
        .mcp = options.mcp,
        .sync = .{
            .command = options.command,
            .cwd = options.cwd,
            .include = &.{ "skills/*", "_root" },
            .body = "Run `kit auth login` to finish setup.",
            .suggestions = &.{ "Show my status", "Deploy the app" },
        },
    });
    errdefer cli.destroy();
    try cli.command("status", .{ .description = "Show status", .examples = &.{.{ .description = "Show status" }}, .run = incur.handler(kitOk) });
    try cli.command("deploy", .{ .description = "Deploy the app", .destructive = true, .run = incur.handler(kitDeploy) });
    const auth = try incur.Cli.create(gpa, "auth", .{ .description = "Authentication" });
    try auth.command("login", .{ .description = "Log in", .run = incur.handler(kitOk) });
    try auth.command("logout", .{ .description = "Log out", .hint = "Clears tokens.", .run = incur.handler(kitOk) });
    try cli.group(auth);
    return cli;
}

fn kit(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kit", .{});
}

fn kitpkg(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kitpkg", .{ .package = "@acme/kit", .mcp = .{ .name = "acme", .agents = &.{"amp"} } });
}

fn kitcmd(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kitcmd", .{ .mcp = .{ .agents = &.{ "cursor", "amp" }, .command = "kit serve --stdio" } });
}

fn kitcwd(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kitcwd", .{ .cwd = "vendor" });
}

fn kitrun(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kitrun", .{ .command = "bunx @acme/kit" });
}

fn kitbad(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kitbad", .{ .package = "Bad Name", .version = "1" });
}

fn kitver(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kitver", .{ .package = "kitver", .version = "latest" });
}

fn spaced(gpa: Allocator) !*incur.Cli {
    return kitCli(gpa, "kit tool", .{});
}

/// Writes `label {context}` to standard error, as the TypeScript callbacks log their context.
fn logContext(process: *const incur.Process, a: Allocator, label: []const u8, fields: []const struct { []const u8, ?[]const u8 }) !void {
    var out: incur.ObjectBuilder = .{};
    for (fields) |field| if (field[1]) |value| try out.put(a, field[0], .{ .string = value });
    try process.stderr.print("{s} {s}\n", .{ label, try incur.json.stringify(a, out.finish()) });
}

fn updCheck(c: *const incur.update.Check) !?[]const u8 {
    try logContext(c.process, c.allocator, "check", &.{ .{ "current", c.current }, .{ "name", c.name }, .{ "package", c.package } });
    return if (std.mem.eql(u8, c.current, "1.0.0")) "1.2.0" else null;
}

fn updInstall(c: *const incur.update.Install) !void {
    try logContext(c.process, c.allocator, "install", &.{ .{ "current", c.current }, .{ "latest", c.latest }, .{ "name", c.name }, .{ "package", c.package } });
}

fn upd(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "upd", .{ .description = "Custom updates", .version = "1.0.0", .update = .{ .check = updCheck, .install = updInstall } });
    errdefer cli.destroy();
    try cli.command("status", .{ .description = "Show status", .run = incur.handler(kitOk) });
    return cli;
}

fn notAVersion(_: *const incur.update.Check) !?[]const u8 {
    return "not-a-version";
}

fn installerFailed(c: *const incur.update.Install) !void {
    return c.fail("installer failed");
}

fn updbeta(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "updbeta", .{ .description = "Prerelease updates", .version = "1.0.0-beta.2", .sync = null, .update = .{ .check = notAVersion, .deferred = true, .install = installerFailed } });
    errdefer cli.destroy();
    try cli.command("status", .{ .description = "Show status", .run = incur.handler(kitOk) });
    return cli;
}

fn checkFailed(c: *const incur.update.Check) !?[]const u8 {
    return c.fail("check failed");
}

fn installNothing(_: *const incur.update.Install) !void {}

fn updcheck(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "updcheck", .{ .version = "1.0.0", .sync = null, .update = .{ .check = checkFailed, .deferred = true, .install = installNothing } });
    errdefer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(kitOk) });
    return cli;
}

fn nine(_: *const incur.update.Check) !?[]const u8 {
    return "9.0.0";
}

fn updnone(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "updnone", .{ .version = "1.0.0", .sync = null, .update = .{ .check = nine } });
    errdefer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(kitOk) });
    return cli;
}

fn updpkg(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "updpkg", .{ .description = "Package updates", .sync = null });
    errdefer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(kitOk) });
    return cli;
}

fn updbad(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "updbad", .{ .sync = null, .update = .{ .package = "Bad Name!" } });
    errdefer cli.destroy();
    try cli.command("status", .{ .run = incur.handler(kitOk) });
    return cli;
}

/// Returns the fixture CLI with the given key from `cases.json`.
pub fn create(gpa: Allocator, name: []const u8) !*incur.Cli {
    const fixtures = .{
        .{ "app", app },               .{ "bare", bare },         .{ "catalog", catalog },         .{ "cfg", cfg },
        .{ "dupe", dupe },             .{ "gateway", gateway },   .{ "globals", globals },         .{ "greet", greetCli },
        .{ "plain", plain },           .{ "proxy", proxy },       .{ "raw", raw },                 .{ "rooted", rooted },
        .{ "tools", tools },           .{ "web", web },           .{ "oa", oa },                   .{ "oaroot", oaroot },
        .{ "remote", remote },         .{ "kit", kit },           .{ "kitpkg", kitpkg },           .{ "kitcmd", kitcmd },
        .{ "kitbad", kitbad },         .{ "kitver", kitver },     .{ "spaced", spaced },           .{ "upd", upd },
        .{ "updbeta", updbeta },       .{ "updcheck", updcheck }, .{ "updnone", updnone },         .{ "updpkg", updpkg },
        .{ "updbad", updbad },         .{ "shadow", shadow },     .{ "kitcwd", kitcwd },           .{ "kitrun", kitrun },
        .{ "shadowall", shadowall },   .{ "params", paramsCli },  .{ "hdrarray", hdrarray },       .{ "hdrdupe", hdrdupe },
        .{ "hdrempty", hdrempty },     .{ "hdrkey", hdrkey },     .{ "hdrnumber", hdrnumber },     .{ "hdrtoken", hdrtoken },
        .{ "hdrnewline", hdrnewline }, .{ "kb", kb },             .{ "kbbad", kbbad },             .{ "ask", ask },
        .{ "view", view },             .{ "viewhost", viewhost }, .{ "viewmissing", viewmissing }, .{ "viewscheme", viewscheme },
    };
    inline for (fixtures) |entry| if (std.mem.eql(u8, name, entry[0])) return entry[1](gpa);
    return error.UnknownFixture;
}

/// Returns a JSON response.
fn jsonResponse(a: Allocator, text: []const u8, status_code: u16) !incur.http.Response {
    return incur.http.Response.text(a, text, status_code, "application/json");
}

/// The fake network every outgoing request reaches: `hosted.test` reaches `upstream`,
/// `registry.test` is a fake npm registry, and other hosts fail like unreachable servers.
pub const network: incur.http.Handler = .of(networkFetch);

fn networkFetch(a: Allocator, process: *const incur.Process, request: *const incur.http.Request) !incur.http.Response {
    const url = incur.http.Url.parse(request.url) orelse return error.FetchFailed;
    if (std.mem.eql(u8, url.host, "hosted.test")) return upstream(a, process, request);
    if (std.mem.eql(u8, url.host, "registry.test")) {
        const name = try incur.http.decodeComponent(a, url.path[1..], false);
        if (std.mem.eql(u8, name, "missing")) return incur.http.Response.text(a, "Not Found", 404, "text/plain;charset=UTF-8");
        var tags_: incur.ObjectBuilder = .{};
        try tags_.put(a, "latest", .{ .string = if (std.mem.eql(u8, name, "stale")) "0.1.0" else "2.0.0" });
        var out: incur.ObjectBuilder = .{};
        try out.put(a, "name", .{ .string = name });
        try out.put(a, "dist-tags", tags_.finish());
        return incur.http.Response.json(a, out.finish(), 200);
    }
    return error.FetchFailed;
}

/// The upstream API behind fetch-backed and OpenAPI commands. Routes on the last path segment;
/// unknown routes echo the request.
fn upstream(a: Allocator, _: *const incur.Process, request: *const incur.http.Request) !incur.http.Response {
    const url = incur.http.Url.parse(request.url).?;
    const route = url.path[(std.mem.findScalarLast(u8, url.path, '/') orelse 0) + 1 ..];
    const eql = struct {
        fn f(x: []const u8, y: []const u8) bool {
            return std.mem.eql(u8, x, y);
        }
    }.f;
    if (eql(route, "openapi.json")) return jsonResponse(a, mini_spec, 200);
    if (eql(route, "users")) return incur.http.Response.json(a, try incur.encode(a, .{ .users = users }), 200);
    if (eql(route, "text")) return incur.http.Response.text(a, "plain text body", 200, "text/plain;charset=UTF-8");
    if (eql(route, "fail")) return jsonResponse(a, "{\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"No such thing\"}}", 404);
    if (eql(route, "bad")) return jsonResponse(a, "{\"message\":\"Bad input\",\"error\":{\"code\":7}}", 400);
    if (eql(route, "bad-object")) return jsonResponse(a, "{\"message\":{\"detail\":\"Bad input\"}}", 422);
    if (eql(route, "boom")) return incur.http.Response.text(a, "Internal failure", 500, "text/plain;charset=UTF-8");
    if (eql(route, "down")) return jsonResponse(a, "{\"status\":\"down\"}", 503);
    if (eql(route, "empty")) return .{ .status = 204 };
    if (eql(route, "stream")) return incur.http.Response.text(a, "{\"n\":1}\n\nnot json\n{\"n\":2}\n{\"n\":3}", 200, "application/x-ndjson");
    if (eql(route, "sse")) return incur.http.Response.text(a, "data: {\"n\":1}\n\n", 200, "text/event-stream");
    const body: Value = if (request.body) |text| body: {
        if (text.len == 0) break :body .null;
        var message: []const u8 = undefined;
        break :body incur.json.parse(a, text, &message) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.SyntaxError => .{ .string = text },
        };
    } else .null;
    const params = try incur.http.SearchParams.parse(a, url.query);
    var query: incur.ObjectBuilder = .{};
    for (params.list.items) |entry| try query.put(a, entry.key, entry.value);
    var out: incur.ObjectBuilder = .{};
    try out.put(a, "method", .{ .string = request.method });
    try out.put(a, "path", .{ .string = url.path });
    try out.put(a, "query", query.finish());
    try out.put(a, "headers", try request.headers.toValue(a));
    try out.put(a, "body", body);
    return incur.http.Response.json(a, out.finish(), 200);
}

/// A one-operation OpenAPI document served by the upstream API at any `openapi.json`.
const mini_spec =
    \\{"openapi":"3.1.0","info":{"title":"Mini","version":"1.0.0"},"paths":{"/ping":{"get":{"operationId":"ping","summary":"Ping the API"}},"/ping/{id}":{"post":{"operationId":"pingOne","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}}]}}}}
;

/// Request bodies composed with `oneOf`, `anyOf`, and `allOf`, flattened into options.
const composed_spec =
    \\{"openapi":"3.1.0","info":{"title":"Composed","version":"1.0.0"},"components":{"securitySchemes":{},"schemas":{"Ref":{"type":"object","properties":{"ref":{"type":"string","description":"Git ref"}}},"Node":{"type":"object","properties":{"label":{"type":"string"}},"allOf":[{"$ref":"#/components/schemas/Node"}]},"Left":{"properties":{"left":{"type":"string"}},"allOf":[{"$ref":"#/components/schemas/Right"}]},"Right":{"properties":{"right":{"type":"string"}},"allOf":[{"$ref":"#/components/schemas/Left"}]}}},"paths":{"/events":{"post":{"operationId":"createEvent","summary":"Create an event","requestBody":{"content":{"application/json":{"schema":{"oneOf":[{"allOf":[{"$ref":"#/components/schemas/Ref"},{"properties":{"kind":{"const":"push"},"at":{"type":"string"},"version":{"const":1},"meta":{"const":null}},"required":["kind","ref"]}]},{"type":"object","properties":{"kind":{"const":"tag"},"name":{"type":"string"},"at":{"type":"integer"},"version":{"const":2},"meta":{"const":"x"}},"required":["kind","name"]},{"type":"string"},true]}}}}}},"/items":{"post":{"operationId":"createItem","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"id":{"type":"string","description":"Item id"},"qty":{"type":"integer"}},"allOf":[{"type":"object","properties":{"id":{"type":"string"},"qty":{"type":"integer","minimum":1}},"required":["id"]},{"type":"object","properties":{"note":{"type":"string"}}},true],"anyOf":[{"type":["object","null"],"properties":{"count":{"type":"integer"}}},{"type":"object","properties":{"count":{"type":"integer"}}}]}}}}}},"/policy":{"put":{"operationId":"setPolicy","requestBody":{"content":{"application/json":{"schema":{"anyOf":[{"type":"object","properties":{"enabled":{"const":false}},"required":["enabled"]},{"type":"object","properties":{"enabled":{"const":true},"limit":{"type":"integer","default":10}},"required":["enabled","limit"]}]}}}}}},"/rpc":{"post":{"operationId":"rpc","requestBody":{"content":{"application/json":{"schema":{"anyOf":[{"type":"object","properties":{"method":{"type":"string"},"params":{"type":"array"}},"required":["method"]},{"type":"array","items":{"type":"object"}}]}}}}}},"/nodes":{"post":{"operationId":"createNode","requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Node"}}}}}},"/pair":{"post":{"operationId":"createPair","requestBody":{"content":{"application/json":{"schema":{"allOf":[{"$ref":"#/components/schemas/Left"},{"$ref":"#/components/schemas/Right"},{"$ref":"#/components/schemas/Ref"},{"$ref":"#/components/schemas/Ref"}]}}}}}},"/notes":{"post":{"operationId":"createNote","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"text":{"type":"string","description":"Note text"},"tag":{"type":"string","description":"Tag"}},"required":["text"]}}}}}},"/flex":{"patch":{"operationId":"updateFlex","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"note":{"type":"string"}},"anyOf":[{"type":"object","properties":{"kind":{"type":"string"}},"required":["kind"]},true]}}}}}},"/stock":{"put":{"operationId":"setStock","requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"qty":{"type":"integer","default":5},"level":{"type":"string","default":"low"},"mode":{"enum":["auto","manual"],"default":"auto"}},"required":["qty"],"allOf":[{"properties":{"qty":{"type":"integer","minimum":1},"level":{"type":"string","default":"high"},"mode":{"type":"string"}}}]}}}}}},"/raw":{"post":{"operationId":"raw","requestBody":{"content":{"application/json":{"schema":{"oneOf":[{"type":"array"},{"type":"string"},false]}}}}}}}}
;

/// An OpenAPI document covering parameters, bodies, security, references, and versions.
const pet_spec =
    \\{"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},"security":[{"apiKey":[]}],"components":{"securitySchemes":{"apiKey":{"type":"apiKey","in":"header","name":"X-Api-Key","description":"API key"},"bearer":{"type":"http","scheme":"bearer"},"basic":{"type":"http","scheme":"Basic","description":"Basic credentials"},"query":{"type":"apiKey","in":"query","name":"key"},"oauth":{"type":"oauth2"}},"schemas":{"Pet":{"type":"object","properties":{"name":{"type":"string","description":"Pet name"},"age":{"type":"integer","minimum":0},"tags":{"type":"array","items":{"type":"string"}},"owner":{"type":"object","properties":{"id":{"type":"string"}}}},"required":["name"]}},"parameters":{"Limit":{"name":"limit","in":"query","description":"Max results","schema":{"type":"integer","minimum":1,"maximum":50}}}},"paths":{"/":{"get":{"operationId":"index","summary":"API index"}},"/pets":{"get":{"operationId":"listPets","summary":"List pets","description":"Lists every pet in the store.","parameters":[{"$ref":"#/components/parameters/Limit"},{"name":"status","in":"query","required":true,"schema":{"type":"string","enum":["available","sold"]}},{"name":"vaccinated","in":"query","schema":{"type":"boolean"}},{"name":"X-Trace","in":"header","description":"Trace id","schema":{"type":"string"}}]},"post":{"operationId":"createPet","summary":"Create a pet","security":[{"bearer":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Pet"}}}}}},"/pets/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}]},"delete":{"operationId":"deletePet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}],"security":[]},"put":{"summary":"Replace a pet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}],"security":[{"basic":[]},{"query":[]},{"oauth":[]},{"unknown":[]}],"requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Pet"}}}}}},"/pets/{petId}/fail":{"get":{"operationId":"failPet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}]}},"/store/text":{"get":{"operationId":"storeText","description":"Plain text"}},"/store/bad":{"post":{"operationId":"storeBad","summary":"Rejected","description":"Rejected"}},"/store/boom":{"post":{"operationId":"storeBoom"}},"/search":{"get":{"operationId":"search","summary":"Search","parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string","pattern":"^[a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z]$","example":"abc"}},{"name":"since","in":"query","schema":{"type":"string","format":"date-time"}},{"name":"score","in":"query","schema":{"type":["number","null"]}},{"name":"tag","in":"query","schema":{"type":["string","array"],"items":{"type":"string"}}},{"name":"page","in":"query","schema":{"type":["boolean","integer","string"]}}]}},"/v1/users":{"get":{"operationId":"listUsersV1","summary":"List users (v1)"}},"/v2/users":{"get":{"operationId":"listUsersV2","summary":"List users (v2)"}},"/v2/users/{id}":{"patch":{"operationId":"updateUser","summary":"Update a user","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}},{"name":"limit","in":"query","schema":{"type":"integer"}},{"name":"limit","in":"header","required":true,"schema":{"type":"string"}},{"name":"Limit","in":"header","schema":{"type":"string"}}],"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"header-limit":{"type":"string"},"active":{"type":"boolean","description":"Active flag"}},"required":["active"]}}}}}}}}
;
