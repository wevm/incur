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

const PrListOptions = struct {
    state: PrState = .open,

    pub const incur = .{ .fields = .{ .state = .{ .description = "State" } } };
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

const PrViewArgs = struct {
    number: f64,

    pub const incur = .{ .fields = .{ .number = .{ .description = "PR number" } } };
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

fn prList(c: *Context(.{ .options = PrListOptions })) !Outcome {
    return c.ok(.{ .prs = .{}, .state = c.options.state, .user = c.get("user") });
}

fn prView(c: *Context(.{ .args = PrViewArgs })) !Outcome {
    return c.ok(.{ .number = c.args.number });
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

    const pr = try incur.Cli.create(gpa, "pr", .{ .description = "Pull request commands" });
    try pr.use(prUser);
    try pr.command("list", .{ .description = "List pull requests", .run = incur.handler(prList) });
    try pr.command("view", .{ .description = "View a pull request", .run = incur.handler(prView) });
    try cli.group(pr);

    const db = try incur.Cli.create(gpa, "db", .{ .description = "Database commands", .output_policy = .agent_only, .root = .{ .run = incur.handler(dbRoot) } });
    try db.command("migrate", .{ .description = "Run migrations", .run = incur.handler(migrate) });
    try cli.group(db);

    try cli.group(try incur.Cli.create(gpa, "hi", .{ .description = "Leaf CLI", .aliases = &.{"hey"}, .root = .{ .run = incur.handler(hi) } }));
    return cli;
}

const LoudOptions = struct {
    loud: ?bool = null,

    pub const incur = .{ .fields = .{ .loud = .{ .description = "Shout" } } };
};

fn greetRoot(c: *Context(.{ .args = GreetArgs, .options = LoudOptions })) !Outcome {
    const prefix = if (c.options.loud == true) "HELLO" else "hello";
    return c.ok(.{ .message = try std.fmt.allocPrint(c.allocator, "{s} {s}", .{ prefix, c.args.name }) });
}

fn greetBanner(_: std.Io, _: Allocator) !?[]const u8 {
    return "Greet banner";
}

fn greetCli(gpa: Allocator) !*incur.Cli {
    return incur.Cli.create(gpa, "greet", .{
        .update = null,
        .description = "A greeting CLI",
        .banner = .{ .mode = .agent, .render = greetBanner },
        .root = .{ .run = incur.handler(greetRoot) },
    });
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

fn hello(c: *Context(.{})) !Outcome {
    return c.ok(.{ .hello = "world" });
}

fn helloLoud(c: *Context(.{})) !Outcome {
    return c.ok(.{ .hello = "WORLD" });
}

fn v2(c: *Context(.{})) !Outcome {
    return c.ok(.{ .v = 2 });
}

fn katakana(c: *Context(.{})) !Outcome {
    return c.ok("ポン");
}

fn plainBanner(_: std.Io, _: Allocator) !?[]const u8 {
    return "Welcome to plain";
}

fn plain(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "plain", .{
        .update = null,
        .description = "No skills, JSON by default",
        .sync = null,
        .format = .json,
        .aliases = &.{ "pl", "plain-cli" },
        .config = .{},
        .banner = .{ .mode = .all, .render = plainBanner },
    });
    errdefer cli.destroy();
    try cli.command("hello", .{ .description = "Say hello", .run = incur.handler(hello) });
    try cli.command("ping", .{ .run = incur.handler(ping) });
    try cli.command("Hello", .{ .description = "Say hello loudly", .run = incur.handler(helloLoud) });
    try cli.command("v2", .{ .description = "Version two", .run = incur.handler(v2) });
    try cli.command("ピン", .{ .description = "Katakana ping", .run = incur.handler(katakana) });
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
    try cli.command("named", .{ .description = "Positional named like a global", .run = incur.handler(toolNamed) });
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
    const cli = try incur.Cli.create(gpa, "oa", .{ .description = "OpenAPI commands", .update = null, .sync = null });
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
    \\{"tools":[{"name":"structured","description":"Structured result","inputSchema":{"type":"object","properties":{"count":{"type":"integer","description":"Count"},"label":{"type":"string"},"on":{"type":"boolean"},"ratio":{"type":["number","null"]},"tags":{"type":["array","null"],"items":{"type":"string"}}},"required":["count"]},"outputSchema":{"type":"object","properties":{"total":{"type":"number"}}},"annotations":{"readOnlyHint":true}},{"name":"headers","description":"Echo MCP headers"},{"name":"texts","description":"Two text items","outputSchema":{"type":"string"}},{"name":"words","description":"Non-JSON text"},{"name":"none","description":"No content"},{"name":"tool-error","description":"Tool error result"},{"name":"silent-error","description":"Tool error without text"},{"name":"rpc-error","description":"JSON-RPC error"},{"name":"http-error","description":"HTTP error"},{"name":"sse","description":"SSE response"},{"name":"sse-other","description":"SSE without a matching message"},{"name":"empty-body","description":"Empty response body"}]}
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
fn kitCli(gpa: Allocator, name: []const u8, options: struct { mcp: incur.Mcp = .{}, package: ?[]const u8 = null, version: []const u8 = "1.4.0" }) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, name, .{
        .description = "Skill and MCP sync",
        .version = options.version,
        .update = null,
        .package = options.package,
        .mcp = options.mcp,
        .sync = .{
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
        .{ "app", app },         .{ "bare", bare },         .{ "catalog", catalog }, .{ "cfg", cfg },
        .{ "dupe", dupe },       .{ "gateway", gateway },   .{ "globals", globals }, .{ "greet", greetCli },
        .{ "plain", plain },     .{ "proxy", proxy },       .{ "raw", raw },         .{ "rooted", rooted },
        .{ "tools", tools },     .{ "web", web },           .{ "oa", oa },           .{ "oaroot", oaroot },
        .{ "remote", remote },   .{ "kit", kit },           .{ "kitpkg", kitpkg },   .{ "kitcmd", kitcmd },
        .{ "kitbad", kitbad },   .{ "kitver", kitver },     .{ "spaced", spaced },   .{ "upd", upd },
        .{ "updbeta", updbeta }, .{ "updcheck", updcheck }, .{ "updnone", updnone }, .{ "updpkg", updpkg },
        .{ "updbad", updbad },   .{ "shadow", shadow },
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

/// An OpenAPI document covering parameters, bodies, security, references, and versions.
const pet_spec =
    \\{"openapi":"3.1.0","info":{"title":"Pets","version":"1.0.0"},"security":[{"apiKey":[]}],"components":{"securitySchemes":{"apiKey":{"type":"apiKey","in":"header","name":"X-Api-Key","description":"API key"},"bearer":{"type":"http","scheme":"bearer"},"basic":{"type":"http","scheme":"Basic","description":"Basic credentials"},"query":{"type":"apiKey","in":"query","name":"key"},"oauth":{"type":"oauth2"}},"schemas":{"Pet":{"type":"object","properties":{"name":{"type":"string","description":"Pet name"},"age":{"type":"integer","minimum":0},"tags":{"type":"array","items":{"type":"string"}},"owner":{"type":"object","properties":{"id":{"type":"string"}}}},"required":["name"]}},"parameters":{"Limit":{"name":"limit","in":"query","description":"Max results","schema":{"type":"integer","minimum":1,"maximum":50}}}},"paths":{"/":{"get":{"operationId":"index","summary":"API index"}},"/pets":{"get":{"operationId":"listPets","summary":"List pets","description":"Lists every pet in the store.","parameters":[{"$ref":"#/components/parameters/Limit"},{"name":"status","in":"query","required":true,"schema":{"type":"string","enum":["available","sold"]}},{"name":"vaccinated","in":"query","schema":{"type":"boolean"}},{"name":"X-Trace","in":"header","description":"Trace id","schema":{"type":"string"}}]},"post":{"operationId":"createPet","summary":"Create a pet","security":[{"bearer":[]}],"requestBody":{"required":true,"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Pet"}}}}}},"/pets/{petId}":{"get":{"operationId":"getPet","summary":"Get a pet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}]},"delete":{"operationId":"deletePet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}],"security":[]},"put":{"summary":"Replace a pet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}],"security":[{"basic":[]},{"query":[]},{"oauth":[]},{"unknown":[]}],"requestBody":{"content":{"application/json":{"schema":{"$ref":"#/components/schemas/Pet"}}}}}},"/pets/{petId}/fail":{"get":{"operationId":"failPet","parameters":[{"name":"petId","in":"path","required":true,"description":"Pet id","schema":{"type":"integer"}}]}},"/store/text":{"get":{"operationId":"storeText","description":"Plain text"}},"/store/bad":{"post":{"operationId":"storeBad","summary":"Rejected","description":"Rejected"}},"/store/boom":{"post":{"operationId":"storeBoom"}},"/search":{"get":{"operationId":"search","summary":"Search","parameters":[{"name":"q","in":"query","required":true,"schema":{"type":"string","pattern":"^[a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z]$","example":"abc"}},{"name":"since","in":"query","schema":{"type":"string","format":"date-time"}},{"name":"score","in":"query","schema":{"type":["number","null"]}}]}},"/v1/users":{"get":{"operationId":"listUsersV1","summary":"List users (v1)"}},"/v2/users":{"get":{"operationId":"listUsersV2","summary":"List users (v2)"}},"/v2/users/{id}":{"patch":{"operationId":"updateUser","summary":"Update a user","parameters":[{"name":"id","in":"path","required":true,"schema":{"type":"string"}},{"name":"limit","in":"query","schema":{"type":"integer"}},{"name":"limit","in":"header","required":true,"schema":{"type":"string"}},{"name":"Limit","in":"header","schema":{"type":"string"}}],"requestBody":{"content":{"application/json":{"schema":{"type":"object","properties":{"header-limit":{"type":"string"},"active":{"type":"boolean","description":"Active flag"}},"required":["active"]}}}}}}}}
;
