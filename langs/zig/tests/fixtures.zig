//! Zig mirror of the reference CLIs in `langs/differential/fixtures.ts`.

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
    deploy_retries: ?f64 = null,
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
    try out.put(c.allocator, "added", .{ .number = 1 });
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

fn greetBanner(_: Allocator) !?[]const u8 {
    return "Greet banner";
}

fn greetCli(gpa: Allocator) !*incur.Cli {
    return incur.Cli.create(gpa, "greet", .{
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

fn globBanner(_: Allocator) !?[]const u8 {
    return "Glob banner";
}

fn globals(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "glob", .{
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

fn plainBanner(_: Allocator) !?[]const u8 {
    return "Welcome to plain";
}

fn plain(gpa: Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "plain", .{
        .description = "No skills, JSON by default",
        .sync = false,
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

/// Returns the fixture CLI with the given key from `cases.json`, or null for unknown keys.
pub fn create(gpa: Allocator, name: []const u8) !?*incur.Cli {
    const fixtures = .{ .{ "app", app }, .{ "cfg", cfg }, .{ "globals", globals }, .{ "greet", greetCli }, .{ "plain", plain }, .{ "rooted", rooted } };
    inline for (fixtures) |entry| if (std.mem.eql(u8, name, entry[0])) return try entry[1](gpa);
    return null;
}
