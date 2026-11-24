//! CLI definition, command routing, and the `serve` loop.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");
const errors = @import("errors.zig");
const command = @import("command.zig");
const completions = @import("completions.zig");
const filter = @import("filter.zig");
const formatter = @import("formatter.zig");
const help = @import("help.zig");
const parser = @import("parser.zig");
const skill = @import("skill.zig");
const tokens = @import("tokens.zig");
const http = @import("http.zig");
const fetch_api = @import("fetch.zig");
const openapi = @import("openapi.zig");
const mcp = @import("mcp.zig");
const mcp_source = @import("mcp_source.zig");
const server = @import("server.zig");
const sync_api = @import("sync.zig");
const update_api = @import("update.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;
const Error = errors.Error;
const Format = formatter.Format;
const Command = command.Command;
const ServeError = command.ServeError;
const Middleware = command.Middleware;
const OutputPolicy = command.OutputPolicy;
const FormattedCta = errors.FormattedCta;
const FormattedCtaBlock = errors.FormattedCtaBlock;

/// The hint appended to destructive commands in agent skills.
const destructive_hint = "Confirm with the user before executing this destructive command.";

/// Who sees the banner.
pub const BannerMode = enum {
    /// Agents only.
    agent,
    /// Everyone.
    all,
    /// Terminals only.
    human,
};

/// Text shown above root help.
pub const Banner = struct {
    /// Who sees it.
    mode: BannerMode = .all,
    /// Renders the text, and may perform I/O. Null or empty text shows nothing, and errors
    /// other than `error.OutOfMemory` and `error.Canceled` show nothing too.
    render: *const fn (io: std.Io, a: Allocator) anyerror!?[]const u8,
};

/// Config-file option defaults.
pub const Config = struct {
    /// Global flag that names a config file, such as `config` for `--config <path>`.
    flag: ?[]const u8 = null,
    /// Ordered search paths. The first existing file wins. Defaults to `<cli>.json`.
    files: []const []const u8 = &.{},
    /// Custom loader, called with the resolved path or null. Returns the parsed config, or null
    /// for none; report failures with `load.fail`.
    loader: ?*const fn (load: *Load, path: ?[]const u8) anyerror!?Value = null,

    /// The context a config loader receives.
    pub const Load = struct {
        /// Allocator for the returned value.
        allocator: Allocator,
        /// The I/O implementation, for reading the config.
        io: std.Io,
        /// The failure slot `fail` writes.
        failure: *command.Failure,

        /// Records an error for the CLI to report and returns `error.Failed`.
        pub fn fail(l: *Load, e: Error) command.Failed {
            return l.failure.fail(e);
        }
    };
};

/// Options for `Cli.create`. Strings, slices, and schemas must outlive the CLI; literals and
/// `incur.schema` results do.
pub const Options = struct {
    /// Alternative binary names. Completions register every name.
    aliases: []const []const u8 = &.{},
    /// Text shown above root help.
    banner: ?Banner = null,
    /// Config-file defaults.
    config: ?Config = null,
    /// Description.
    description: ?[]const u8 = null,
    /// CLI-level environment schema, parsed before middleware runs.
    env: ?*const Type = null,
    /// Default output format.
    format: ?Format = null,
    /// Global options available to every command, such as `incur.schema(Globals)`.
    globals: ?*const Type = null,
    /// Default output policy, inherited by every command.
    output_policy: ?OutputPolicy = null,
    /// The root command, which runs when no subcommand matches.
    root: ?Command = null,
    /// Skill sync settings for `skills add` and `skills list`. Null disables the skills
    /// integration.
    sync: ?Sync = .{},
    /// Self-update settings for `--update`. Null disables updates.
    update: ?Update = .{},
    /// MCP server settings for `--mcp`, `mcp add`, and `/mcp` over HTTP. On a mounted group, null
    /// hides the group's commands from MCP.
    mcp: ?Mcp = .{},
    /// The npm package that distributes the CLI, used by `mcp add` and stale-skill hints.
    package: ?[]const u8 = null,
    /// A root HTTP handler: invocations that match no command become requests to it.
    fetch: ?fetch_api.Source = null,
    /// An OpenAPI document whose operations become commands calling `fetch`.
    openapi: ?openapi.Spec = null,
    /// How OpenAPI operations become commands.
    openapi_config: openapi.Config = .{},
    /// Default variables that middleware may replace.
    vars: []const Value.Entry = &.{},
    /// Version.
    version: ?[]const u8 = null,
};

/// Skill sync settings.
pub const Sync = struct {
    /// Text shown after `skills add` lists the synced skills.
    body: ?[]const u8 = null,
    /// The directory `include` patterns resolve against, for `skills add` and `skills list`.
    /// Defaults to the package root. Project installs (`skills add --no-global`) always go to the
    /// working directory.
    cwd: ?[]const u8 = null,
    /// Grouping depth for skill files.
    depth: f64 = 1,
    /// Patterns of directories with extra `SKILL.md` files, such as `skills/*`, or `_root` for a
    /// `SKILL.md` in the directory itself.
    include: []const []const u8 = &.{},
    /// Example prompts shown after `skills add` and `mcp add`.
    suggestions: []const []const u8 = &.{},
};

/// Self-update settings. Without `check` and `install`, updates resolve through the npm package
/// that contains the program and run the detected package manager.
pub const Update = struct {
    /// Returns the latest version, or null when unknown.
    check: ?*const fn (c: *const update_api.Check) anyerror!?[]const u8 = null,
    /// Installs the latest version.
    install: ?*const fn (c: *const update_api.Install) anyerror!void = null,
    /// Whether installation finishes after the updating process exits.
    deferred: bool = false,
    /// Minimum time between update checks, in milliseconds. Defaults to one day.
    interval: ?f64 = null,
    /// The npm package to check. Defaults to the package containing the program.
    package: ?[]const u8 = null,
};

/// MCP server settings.
pub const Mcp = struct {
    /// Agents `mcp add` registers with by default.
    agents: []const []const u8 = &.{},
    /// The command agents run. Defaults to `<name> --mcp` or a package runner invocation.
    command: ?[]const u8 = null,
    /// Instructions describing how to use the server.
    instructions: ?[]const u8 = null,
    /// The server name. Defaults to the CLI name.
    name: ?[]const u8 = null,
    /// Whether `/mcp` over HTTP runs without sessions.
    stateless: bool = true,
    /// A human-readable server title.
    title: ?[]const u8 = null,
    /// Which commands become tools, and how clients discover them.
    tools: mcp.Filter = .{},
};

/// A command backed by an HTTP handler. With `openapi`, the document's operations become a
/// group of typed commands that call the handler instead.
pub const Gateway = struct {
    /// Description.
    description: ?[]const u8 = null,
    /// The handler requests go to.
    fetch: fetch_api.Source,
    /// A path prefix for every request.
    base_path: ?[]const u8 = null,
    /// Output policy.
    output_policy: ?OutputPolicy = null,
    /// An OpenAPI document describing the handler.
    openapi: ?openapi.Spec = null,
    /// How OpenAPI operations become commands.
    openapi_config: openapi.Config = .{},
    /// Whether generated OpenAPI commands are MCP tools.
    mcp: bool = true,
};

/// A group of commands generated from a remote MCP server's tools. The server is contacted the
/// first time an invocation reaches the group.
pub const McpSource = struct {
    /// Description.
    description: ?[]const u8 = null,
    /// The server's streamable-HTTP endpoint.
    url: []const u8,
    /// The handler requests go to. Null sends them to the network.
    fetch: ?http.Handler = null,
    /// Headers sent with every request.
    headers: []const http.Header = &.{},
    /// Output policy.
    output_policy: ?OutputPolicy = null,
};

/// Errors `Cli.create` reports.
pub const CreateError = error{
    /// A global option or its alias collides with a built-in flag.
    GlobalOptionConflict,
} || Allocator.Error;

/// A command tree entry.
pub const Entry = union(enum) {
    /// Another name for a sibling command.
    alias: *const Command,
    /// A command.
    command: *const Command,
    /// A group of commands.
    group: *Cli,
    /// A command that forwards requests to an HTTP handler.
    gateway: *const Gateway,
};

/// A named command tree entry.
pub const Named = struct { name: []const u8, entry: Entry };

/// A list of named entries in insertion order.
pub const Commands = []const Named;

/// Returns the entry with the given name.
pub fn lookup(commands: Commands, name: []const u8) ?Entry {
    for (commands) |n| if (std.mem.eql(u8, n.name, name)) return n.entry;
    return null;
}

/// Process I/O for `Cli.serveWith`.
pub const Process = struct {
    /// The I/O implementation that config files, the clock, banners, middleware, handlers, and
    /// streams use. Canceling the task that serves the CLI cancels the command's I/O.
    io: std.Io,
    /// Environment variables.
    env: *const std.process.Environ.Map,
    /// Standard output.
    stdout: *std.Io.Writer,
    /// Standard error.
    stderr: *std.Io.Writer,
    /// Whether standard output is a terminal.
    tty: bool,
    /// Standard input, which `--mcp` reads JSON-RPC messages from. Null reads nothing.
    stdin: ?*std.Io.Reader = null,
    /// The path the program was invoked as. Package detection for updates, `mcp add`, and
    /// skill installs walks up from it; the display name is its basename when that names the CLI
    /// or one of its aliases.
    program: ?[]const u8 = null,
    /// Handles outgoing HTTP requests: hosted fetch sources, OpenAPI URLs, remote MCP servers,
    /// and registry lookups. Null sends them with `std.http.Client`.
    network: ?http.Handler = null,
};

/// A CLI: a router of commands, optionally with its own root command.
///
/// ```zig
/// const cli = try incur.Cli.create(gpa, "my-cli", .{ .description = "My CLI" });
/// defer cli.destroy();
/// try cli.command("status", .{ .description = "Show status", .run = incur.handler(status) });
/// ```
pub const Cli = struct {
    /// The allocator the CLI was created with.
    gpa: Allocator,
    /// Owns the command tree.
    arena: std.heap.ArenaAllocator,
    /// The CLI name.
    name: []const u8,
    /// Options.
    options: Options,
    /// Commands.
    commands: std.ArrayList(Named) = .empty,
    /// Middleware.
    middleware: std.ArrayList(Middleware) = .empty,
    /// Mounted groups and owned CLIs, destroyed with this CLI.
    children: std.ArrayList(*Cli) = .empty,
    /// Where a generated group's commands come from.
    source: ?Source = null,
    /// Whether generated commands have been loaded.
    loaded: bool = false,
    /// The stateful MCP session for `/mcp` over HTTP, created on first use.
    session: ?*mcp.Session = null,

    /// Where a generated group's commands come from.
    pub const Source = union(enum) {
        /// An OpenAPI document and the handler its operations call.
        openapi: *const Gateway,
        /// A remote MCP server.
        mcp: *const McpSource,
    };

    /// Creates a CLI. Destroy it with `destroy`.
    pub fn create(gpa: Allocator, name: []const u8, options: Options) CreateError!*Cli {
        if (options.globals) |globals| try checkGlobals(gpa, globals, options.config, options.update != null);
        const cli = try gpa.create(Cli);
        cli.* = .{ .gpa = gpa, .arena = .init(gpa), .name = name, .options = options };
        return cli;
    }

    /// Frees the CLI and every group mounted on it.
    pub fn destroy(cli: *Cli) void {
        for (cli.children.items) |child| child.destroy();
        cli.arena.deinit();
        cli.gpa.destroy(cli);
    }

    /// Takes ownership of another CLI, such as one whose handler serves an MCP source, and
    /// destroys it with this CLI. On error the caller still owns `other`.
    pub fn own(cli: *Cli, other: *Cli) Allocator.Error!void {
        try cli.children.append(cli.arena.allocator(), other);
    }

    /// Registers a command that forwards requests to an HTTP handler, as `curl`-style argv:
    /// path segments, `--key value` query parameters, `-X`, `-H`, and `-d`. With `openapi`, it
    /// registers a group of commands generated from the document instead.
    pub fn gateway(cli: *Cli, name: []const u8, definition: Gateway) CreateError!void {
        const a = cli.arena.allocator();
        const stored = try a.create(Gateway);
        stored.* = definition;
        if (definition.openapi == null) return cli.put(name, .{ .gateway = stored });
        const child = try cli.mount(name, .{
            .description = definition.description,
            .output_policy = definition.output_policy,
            .mcp = if (definition.mcp) .{} else null,
            .sync = null,
            .update = null,
        });
        child.source = .{ .openapi = stored };
    }

    /// Registers a group of commands generated from a remote MCP server's tools.
    pub fn mcpSource(cli: *Cli, name: []const u8, source: McpSource) CreateError!void {
        const a = cli.arena.allocator();
        const stored = try a.create(McpSource);
        stored.* = source;
        const child = try cli.mount(name, .{ .description = source.description, .output_policy = source.output_policy, .sync = null, .update = null });
        child.source = .{ .mcp = stored };
    }

    /// Creates a CLI and mounts it as a command group, which this CLI owns.
    pub fn mount(cli: *Cli, name: []const u8, options: Options) CreateError!*Cli {
        const child = try Cli.create(cli.gpa, name, options);
        cli.group(child) catch |err| {
            child.destroy();
            return err;
        };
        return child;
    }

    /// Generates commands for groups backed by OpenAPI documents and remote MCP servers. Remote
    /// MCP groups mounted directly on this CLI load only when `name` names them or `name` is
    /// null; others load always. Returns the first failure.
    pub fn load(cli: *Cli, a: Allocator, process: *const Process, name: ?[]const u8) ServeError!?Error {
        if (cli.options.openapi) |spec| if (!cli.loaded) {
            cli.loaded = true;
            const source = cli.options.fetch orelse return null;
            if (try openapi.generate(cli, a, process, spec, source, null, cli.options.openapi_config)) |e| return e;
        };
        return cli.loadChildren(a, process, name, true);
    }

    /// Loads generated groups below this CLI.
    fn loadChildren(cli: *Cli, a: Allocator, process: *const Process, name: ?[]const u8, root: bool) ServeError!?Error {
        for (cli.commands.items) |n| {
            if (n.entry != .group) continue;
            const child = n.entry.group;
            if (child.source) |source| if (!child.loaded) {
                const selected = !root or source == .openapi or name == null or std.mem.eql(u8, name.?, n.name);
                if (!selected) continue;
                child.loaded = true;
                const failure = switch (source) {
                    .openapi => |g| try openapi.generate(child, a, process, g.openapi.?, g.fetch, g.base_path, g.openapi_config),
                    .mcp => |m| try mcp_source.load(child, a, process, m),
                };
                if (failure) |e| return e;
            };
            if (try child.loadChildren(a, process, name, false)) |e| return e;
        }
        return null;
    }

    /// Registers a command and its aliases.
    pub fn command(cli: *Cli, name: []const u8, definition: Command) Allocator.Error!void {
        const a = cli.arena.allocator();
        const stored = try a.create(Command);
        stored.* = definition;
        for (definition.aliases) |alias| try cli.put(alias, .{ .alias = stored });
        try cli.put(name, .{ .command = stored });
    }

    /// Adds middleware, which runs around every command in registration order.
    pub fn use(cli: *Cli, middleware: Middleware) Allocator.Error!void {
        try cli.middleware.append(cli.arena.allocator(), middleware);
    }

    /// Mounts another CLI as a command group and takes ownership of it. A CLI with a root
    /// command and no subcommands mounts as a command, keeping its aliases. On error the caller
    /// still owns `child`.
    pub fn group(cli: *Cli, child: *Cli) Allocator.Error!void {
        const a = cli.arena.allocator();
        try cli.children.ensureUnusedCapacity(a, 1);
        child.options.root = child.rootCommand();
        if (child.options.root != null and child.commands.items.len == 0) {
            const root = try a.create(Command);
            root.* = child.options.root.?;
            root.aliases = child.options.aliases;
            for (root.aliases) |alias| try cli.put(alias, .{ .alias = root });
            try cli.put(child.name, .{ .command = root });
        } else try cli.put(child.name, .{ .group = child });
        cli.children.appendAssumeCapacity(child);
    }

    /// Inserts an entry, replacing an existing one in place.
    fn put(cli: *Cli, name: []const u8, entry: Entry) Allocator.Error!void {
        for (cli.commands.items) |*n| if (std.mem.eql(u8, n.name, name)) {
            n.entry = entry;
            return;
        };
        try cli.commands.append(cli.arena.allocator(), .{ .name = name, .entry = entry });
    }

    /// Returns the root command with the CLI description as its fallback.
    pub fn rootCommand(cli: *const Cli) ?Command {
        var root = cli.options.root orelse return null;
        if (root.description == null) root.description = cli.options.description;
        return root;
    }

    /// Runs the CLI with the process arguments, environment, and standard streams, then exits
    /// with the command's exit code when it is not 0. Outgoing HTTP requests use
    /// `std.http.Client`.
    pub fn serve(cli: *Cli, init: std.process.Init) !void {
        const io = init.io;
        const args = try init.minimal.args.toSlice(init.arena.allocator());
        var out_buf: [4096]u8 = undefined;
        var err_buf: [1024]u8 = undefined;
        var in_buf: [4096]u8 = undefined;
        var stdout = std.Io.File.stdout().writer(io, &out_buf);
        var stderr = std.Io.File.stderr().writer(io, &err_buf);
        var stdin = std.Io.File.stdin().reader(io, &in_buf);
        const tty = std.Io.File.stdout().isTty(io) catch false;
        const code = try cli.serveWith(args[1..], .{
            .io = io,
            .env = init.environ_map,
            .stdout = &stdout.interface,
            .stderr = &stderr.interface,
            .stdin = &stdin.interface,
            .tty = tty,
            .program = args[0],
        });
        if (code != 0) std.process.exit(code);
    }

    /// Runs the CLI with explicit arguments and I/O. Returns the exit code; fails only when
    /// allocation fails or the task serving the CLI is canceled.
    pub fn serveWith(cli: *Cli, argv: []const []const u8, process: Process) ServeError!u8 {
        var arena = std.heap.ArenaAllocator.init(cli.gpa);
        defer arena.deinit();
        const display_name = if (process.program) |program| name: {
            const b = std.fs.path.basename(program);
            if (std.mem.eql(u8, b, cli.name)) break :name b;
            for (cli.options.aliases) |alias| if (std.mem.eql(u8, alias, b)) break :name b;
            break :name cli.name;
        } else cli.name;
        var run: Run = .{
            .a = arena.allocator(),
            .cli = cli,
            .display_name = display_name,
            .process = process,
            .root = cli.rootCommand(),
            .start = std.Io.Clock.awake.now(process.io),
        };
        try run.serve(argv);
        process.stdout.flush() catch {};
        process.stderr.flush() catch {};
        return run.exit;
    }

    /// Answers an HTTP request: commands at their paths (`GET /users/list?limit=5`, or a JSON
    /// body for other methods), streaming commands as NDJSON, MCP at `/mcp`, the OpenAPI
    /// document at `/openapi.json`, and Agent Skills at `/.well-known/agent-skills/`. The
    /// response and everything it references are allocated with `a`.
    pub fn fetch(cli: *Cli, a: Allocator, process: *const Process, request: *const http.Request) ServeError!http.Response {
        return server.handle(cli, a, process, request);
    }

    /// Returns a handler that answers requests with `fetch`, for `http.serveConnection` or another
    /// CLI's MCP source.
    pub fn handler(cli: *Cli) http.Handler {
        return .{ .context = cli, .call = struct {
            fn call(context: ?*const anyopaque, a: Allocator, process: *const Process, request: *const http.Request) anyerror!http.Response {
                const self: *Cli = @ptrCast(@alignCast(@constCast(context.?)));
                return self.fetch(a, process, request);
            }
        }.call };
    }
};

/// Built-in flag names that global options may not use.
const builtin_flags = [_][]const u8{ "fullOutput", "format", "json", "llms", "llmsFull", "mcp", "help", "incurBinaryApply", "incurUpdateCheck", "version", "schema", "filterOutput", "tokenLimit", "tokenOffset", "tokenCount" };

/// Rejects global options that collide with built-in flags.
fn checkGlobals(gpa: Allocator, globals: *const Type, config: ?Config, update: bool) CreateError!void {
    const flag = if (config) |c| c.flag else null;
    for (globals.fields()) |f| {
        if (f.alias == 'h') return error.GlobalOptionConflict;
        for (builtin_flags) |b| if (std.mem.eql(u8, b, f.name)) return error.GlobalOptionConflict;
        if (update and std.mem.eql(u8, f.name, "update")) return error.GlobalOptionConflict;
        // The config flag and its `--no-` form are built-ins too.
        if (flag) |c| {
            if (std.mem.eql(u8, f.name, c)) return error.GlobalOptionConflict;
            if (c.len > 0) {
                const negated = try std.fmt.allocPrint(gpa, "no{c}{s}", .{ std.ascii.toUpper(c[0]), c[1..] });
                defer gpa.free(negated);
                if (std.mem.eql(u8, f.name, negated)) return error.GlobalOptionConflict;
            }
        }
    }
}

/// The resolved target of an invocation.
const Resolved = union(enum) {
    /// A command to run.
    command: struct {
        command: *const Command,
        /// Subcommands, when the command is a group root.
        commands: ?Commands = null,
        /// Group middleware collected on the way.
        middleware: []const Middleware = &.{},
        /// Inherited output policy.
        output_policy: ?OutputPolicy = null,
        /// The command path.
        path: []const u8,
        /// Remaining tokens.
        rest: []const []const u8,
    },
    /// An unknown command.
    err: struct {
        /// Siblings of the unknown token.
        commands: Commands,
        /// The unknown token.
        token: []const u8,
        /// The parent path.
        path: []const u8,
    },
    /// A group without a root command.
    help: struct {
        commands: Commands,
        description: ?[]const u8,
        path: []const u8,
    },
    /// A command that forwards requests to an HTTP handler.
    gateway: struct {
        gateway: *const Gateway,
        /// Group middleware collected on the way.
        middleware: []const Middleware = &.{},
        /// Inherited output policy.
        output_policy: ?OutputPolicy = null,
        /// The command path.
        path: []const u8,
        /// Remaining tokens.
        rest: []const []const u8,
    },
};

/// Walks tokens down the command tree.
fn resolve(a: Allocator, commands: Commands, argv: []const []const u8) Allocator.Error!Resolved {
    const first_entry = if (argv.len > 0) lookup(commands, argv[0]) else null;
    var entry = first_entry orelse return .{ .err = .{
        .commands = commands,
        .token = if (argv.len > 0) argv[0] else "(none)",
        .path = "",
    } };
    var path: std.ArrayList([]const u8) = .empty;
    try path.append(a, argv[0]);
    var remaining = argv[1..];
    var inherited: ?OutputPolicy = null;
    var middleware: std.ArrayList(Middleware) = .empty;
    while (true) {
        const g = switch (entry) {
            .gateway => |gw| return .{ .gateway = .{
                .gateway = gw,
                .middleware = middleware.items,
                .output_policy = gw.output_policy orelse inherited,
                .path = try std.mem.join(a, " ", path.items),
                .rest = remaining,
            } },
            .command, .alias => |c| return .{ .command = .{
                .command = c,
                .middleware = middleware.items,
                .output_policy = c.output_policy orelse inherited,
                .path = try std.mem.join(a, " ", path.items),
                .rest = remaining,
            } },
            .group => |g| g,
        };
        if (g.options.output_policy) |p| inherited = p;
        try middleware.appendSlice(a, g.middleware.items);
        const joined = try std.mem.join(a, " ", path.items);
        const root: ?Resolved = if (g.options.root) |*r| .{ .command = .{
            .command = r,
            .commands = g.commands.items,
            .middleware = middleware.items,
            .output_policy = r.output_policy orelse inherited,
            .path = joined,
            .rest = remaining,
        } } else null;
        if (remaining.len == 0) {
            return root orelse .{ .help = .{ .commands = g.commands.items, .description = g.options.description, .path = joined } };
        }
        const next = remaining[0];
        entry = lookup(g.commands.items, next) orelse {
            if (root != null and try suggest(a, next, try names(a, g.commands.items)) == null) return root.?;
            return .{ .err = .{ .commands = g.commands.items, .token = next, .path = joined } };
        };
        try path.append(a, next);
        remaining = remaining[1..];
    }
}

/// Returns the names of entries.
pub fn names(a: Allocator, commands: Commands) Allocator.Error![]const []const u8 {
    const out = try a.alloc([]const u8, commands.len);
    for (commands, out) |n, *slot| slot.* = n.name;
    return out;
}

/// Suggests the closest candidate by prefix, substring, then edit distance.
pub fn suggest(a: Allocator, input: []const u8, candidates: []const []const u8) Allocator.Error!?[]const u8 {
    const len = js.utf16Len(input);
    const threshold = if (len <= 4) 2 else len / 2;
    const lower = try js.lowerString(a, input);
    var best: ?[]const u8 = null;
    var best_score: usize = std.math.maxInt(usize);
    for (candidates) |candidate| {
        const lc = try js.lowerString(a, candidate);
        const distance = try levenshtein(a, lower, lc);
        const score = if (std.mem.startsWith(u8, lc, lower) and !std.mem.eql(u8, lc, lower))
            distance
        else if (std.mem.find(u8, lc, lower) != null)
            100 + distance
        else if (distance <= threshold)
            200 + distance
        else
            continue;
        if (score < best_score) {
            best_score = score;
            best = candidate;
        }
    }
    return best;
}

/// Computes the Levenshtein distance over UTF-16 code units.
fn levenshtein(a: Allocator, x: []const u8, y: []const u8) Allocator.Error!usize {
    const s = try js.toUtf16(a, x);
    const t = try js.toUtf16(a, y);
    const dp = try a.alloc(usize, t.len + 1);
    for (dp, 0..) |*d, j| d.* = j;
    for (1..s.len + 1) |i| {
        var prev = dp[0];
        dp[0] = i;
        for (1..t.len + 1) |j| {
            const tmp = dp[j];
            dp[j] = if (s[i - 1] == t[j - 1]) prev else 1 + @min(prev, dp[j], dp[j - 1]);
            prev = tmp;
        }
    }
    return dp[t.len];
}

/// Built-in flags extracted from argv.
const Flags = struct {
    /// `--no-<config>`.
    config_disabled: bool = false,
    /// `--<config> <path>`.
    config_path: ?[]const u8 = null,
    /// Parsed `--filter-output` paths.
    filter_output: ?[]const filter.Path = null,
    /// `--format` or `--json`.
    format: Format = .toon,
    /// Whether the format was explicit.
    format_explicit: bool = false,
    /// `--full-output`.
    full_output: bool = false,
    /// `--help`.
    help: bool = false,
    /// `--llms`.
    llms: bool = false,
    /// `--llms-full`.
    llms_full: bool = false,
    /// `--mcp`.
    mcp: bool = false,
    /// Remaining tokens.
    rest: []const []const u8 = &.{},
    /// `--schema`.
    schema: bool = false,
    /// `--token-count`.
    token_count: bool = false,
    /// `--token-limit`.
    token_limit: ?f64 = null,
    /// `--token-offset`.
    token_offset: ?f64 = null,
    /// `--update`.
    update: bool = false,
    /// `--incur-update-check`, the flag of detached update checks.
    update_check: bool = false,
    /// `--version`.
    version: bool = false,
};

/// Extracts built-in flags from argv.
fn extractFlags(a: Allocator, argv: []const []const u8, config_flag: ?[]const u8, update: bool) Allocator.Error!parser.Result(Flags) {
    var flags: Flags = .{};
    var rest: std.ArrayList([]const u8) = .empty;
    var i: usize = 0;
    while (i < argv.len) : (i += 1) {
        const token = argv[i];
        const next = if (i + 1 < argv.len and argv[i + 1].len > 0) argv[i + 1] else null;
        const eql = struct {
            fn eql(x: []const u8, y: []const u8) bool {
                return std.mem.eql(u8, x, y);
            }
        }.eql;
        if (eql(token, "--full-output")) {
            flags.full_output = true;
        } else if (eql(token, "--llms")) {
            flags.llms = true;
        } else if (eql(token, "--llms-full")) {
            flags.llms_full = true;
        } else if (eql(token, "--mcp")) {
            flags.mcp = true;
        } else if (eql(token, "--help") or eql(token, "-h")) {
            flags.help = true;
        } else if (eql(token, "--update") and update) {
            flags.update = true;
        } else if (eql(token, "--incur-update-check")) {
            flags.update_check = true;
        } else if (eql(token, "--version") and (next == null or next.?[0] == '-')) {
            // A following value belongs to a command-local `--version` option.
            flags.version = true;
        } else if (eql(token, "--schema")) {
            flags.schema = true;
        } else if (eql(token, "--json")) {
            flags.format = .json;
            flags.format_explicit = true;
        } else if (eql(token, "--format") and next != null) {
            flags.format = std.meta.stringToEnum(Format, next.?) orelse return .{ .err = .{
                .message = try std.fmt.allocPrint(a, "Invalid format: \"{s}\". Expected one of: toon, json, yaml, md, jsonl", .{next.?}),
            } };
            flags.format_explicit = true;
            i += 1;
        } else if (eql(token, "--filter-output") and next != null) {
            flags.filter_output = switch (try filter.parse(a, next.?)) {
                .ok => |paths| paths,
                .err => |err| return .{ .err = err },
            };
            i += 1;
        } else if ((eql(token, "--token-limit") or eql(token, "--token-offset")) and next != null) {
            const value = js.toNumber(next.?);
            if (!std.math.isFinite(value) or value < 0 or js.trim(next.?).len == 0)
                return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Invalid value for {s}: \"{s}\"", .{ token, next.? }) } };
            if (eql(token, "--token-limit")) flags.token_limit = value else flags.token_offset = value;
            i += 1;
        } else if (eql(token, "--token-count")) {
            flags.token_count = true;
        } else if (config_flag) |c| {
            const flag = try std.fmt.allocPrint(a, "--{s}", .{c});
            const eq = try std.fmt.allocPrint(a, "--{s}=", .{c});
            if (eql(token, flag)) {
                if (i + 1 >= argv.len) return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Missing value for flag: {s}", .{flag}) } };
                flags.config_path = argv[i + 1];
                flags.config_disabled = false;
                i += 1;
            } else if (std.mem.startsWith(u8, token, eq)) {
                if (token.len == eq.len) return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Missing value for flag: {s}", .{flag}) } };
                flags.config_path = token[eq.len..];
                flags.config_disabled = false;
            } else if (std.mem.startsWith(u8, token, "--no-") and eql(token[5..], c)) {
                flags.config_path = null;
                flags.config_disabled = true;
            } else {
                try rest.append(a, token);
            }
        } else {
            try rest.append(a, token);
        }
    }
    flags.rest = rest.items;
    return .{ .ok = flags };
}

/// Lists immediate children for help output, sorted by name.
fn helpEntries(a: Allocator, commands: Commands) Allocator.Error![]const help.Entry {
    var out: std.ArrayList(help.Entry) = .empty;
    for (commands) |n| switch (n.entry) {
        .alias => {},
        .command => |c| try out.append(a, .{ .name = n.name, .description = c.description }),
        .group => |g| try out.append(a, .{ .name = n.name, .description = g.options.description }),
        .gateway => |g| try out.append(a, .{ .name = n.name, .description = g.description }),
    };
    std.mem.sort(help.Entry, out.items, {}, struct {
        fn lessThan(_: void, x: help.Entry, y: help.Entry) bool {
            return js.localeCompare(x.name, y.name) == .lt;
        }
    }.lessThan);
    return out.items;
}

/// Returns the hint with the destructive notice appended when needed.
fn hintWithDestructive(a: Allocator, c: *const Command) Allocator.Error!?[]const u8 {
    // MCP annotations that mark a tool destructive mark the command too.
    const annotated = if (c.mcp) |t| if (try t.annotationsValue(a)) |v| (if (v.get("destructiveHint")) |d| d == .bool and d.bool else false) else false else false;
    if (!c.destructive and !annotated) return c.hint;
    const hint = errors.nonEmpty(c.hint) orelse return destructive_hint;
    if (std.mem.find(u8, hint, destructive_hint) != null) return hint;
    return try std.fmt.allocPrint(a, "{s} {s}", .{ hint, destructive_hint });
}

/// Prefixes examples with a command path.
fn prefixedExamples(a: Allocator, examples: []const help.Example, name: []const u8) Allocator.Error![]const help.Example {
    const out = try a.alloc(help.Example, examples.len);
    for (examples, out) |e, *slot| slot.* = .{
        .command = if (e.command.len == 0) name else try std.fmt.allocPrint(a, "{s} {s}", .{ name, e.command }),
        .description = e.description,
    };
    return out;
}

/// Builds a manifest entry for a command.
fn commandInfo(a: Allocator, name: ?[]const u8, c: *const Command) Allocator.Error!skill.CommandInfo {
    return .{
        .args = c.args(),
        .description = c.description,
        .env = c.env(),
        .examples = if (name) |n| try prefixedExamples(a, c.examples, n) else c.examples,
        .hint = try hintWithDestructive(a, c),
        .name = name,
        .options = c.options(),
        .output = c.output,
    };
}

/// Collects commands for Markdown manifests, sorted by name.
fn skillCommands(a: Allocator, out: *std.ArrayList(skill.CommandInfo), commands: Commands, prefix: []const []const u8, groups: *std.ArrayList(skill.Group)) Allocator.Error!void {
    for (commands) |n| {
        const path = try std.mem.concat(a, []const u8, &.{ prefix, &.{n.name} });
        const joined = try std.mem.join(a, " ", path);
        switch (n.entry) {
            .alias => {},
            .command => |c| try out.append(a, try commandInfo(a, joined, c)),
            .gateway => |g| try out.append(a, .{
                .name = joined,
                .description = g.description,
                .hint = "Fetch gateway. Pass path segments and curl-style flags (-X, -H, -d, --key value).",
            }),
            .group => |g| {
                if (g.options.description) |d| try groups.append(a, .{ .name = joined, .description = d });
                if (g.options.root) |*r| try out.append(a, try commandInfo(a, joined, r));
                try skillCommands(a, out, g.commands.items, path, groups);
            },
        }
    }
}

/// The manifest entries of every command, sorted by name, with group descriptions.
pub const SkillInfos = struct { commands: []const skill.CommandInfo, groups: []const skill.Group };

/// Collects the manifest entries of a CLI's commands, its root command included, as skill files
/// and their hash describe them.
pub fn skillInfos(a: Allocator, cli: *const Cli) Allocator.Error!SkillInfos {
    var groups: std.ArrayList(skill.Group) = .empty;
    var infos: std.ArrayList(skill.CommandInfo) = .empty;
    if (cli.rootCommand()) |root| try infos.append(a, try commandInfo(a, null, &root));
    try skillCommands(a, &infos, cli.commands.items, &.{}, &groups);
    sortInfos(infos.items);
    return .{ .commands = infos.items, .groups = groups.items };
}

/// Sorts manifest entries by name.
fn sortInfos(infos: []skill.CommandInfo) void {
    std.mem.sort(skill.CommandInfo, infos, {}, struct {
        fn lessThan(_: void, x: skill.CommandInfo, y: skill.CommandInfo) bool {
            return js.localeCompare(x.name orelse "", y.name orelse "") == .lt;
        }
    }.lessThan);
}

/// Builds a JSON manifest entry for a command.
fn manifestEntry(a: Allocator, path: []const u8, c: *const Command, full: bool) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "name", .{ .string = path });
    if (errors.nonEmpty(c.description)) |d| try out.put(a, "description", .{ .string = d });
    if (!full) return out.finish();
    var schemas: json.ObjectBuilder = .{};
    for ([_]struct { []const u8, ?*const Type }{ .{ "args", c.args() }, .{ "env", c.env() }, .{ "options", c.options() }, .{ "output", c.output } }) |entry| {
        if (entry[1]) |ty| try schemas.put(a, entry[0], try schema.jsonSchema(a, ty));
    }
    if (schemas.entries.items.len > 0) try out.put(a, "schema", schemas.finish());
    if (c.examples.len > 0) {
        const examples = try prefixedExamples(a, c.examples, path);
        const items = try a.alloc(Value, examples.len);
        for (examples, items) |e, *slot| {
            var entry: json.ObjectBuilder = .{};
            try entry.put(a, "command", .{ .string = e.command });
            if (e.description) |d| try entry.put(a, "description", .{ .string = d });
            slot.* = entry.finish();
        }
        try out.put(a, "examples", .{ .array = items });
    }
    return out.finish();
}

/// Collects JSON manifest entries.
fn manifestCommands(a: Allocator, out: *std.ArrayList(Value), commands: Commands, prefix: []const []const u8, full: bool) Allocator.Error!void {
    for (commands) |n| {
        const path = try std.mem.concat(a, []const u8, &.{ prefix, &.{n.name} });
        const joined = try std.mem.join(a, " ", path);
        switch (n.entry) {
            .alias => {},
            .command => |c| try out.append(a, try manifestEntry(a, joined, c, full)),
            .gateway => |g| {
                var entry: json.ObjectBuilder = .{};
                try entry.put(a, "name", .{ .string = joined });
                if (errors.nonEmpty(g.description)) |d| try entry.put(a, "description", .{ .string = d });
                try out.append(a, entry.finish());
            },
            .group => |g| {
                if (g.options.root) |*r| try out.append(a, try manifestEntry(a, joined, r, full));
                try manifestCommands(a, out, g.commands.items, path, full);
            },
        }
    }
}

/// A built-in subcommand: built-in name, subcommand name, description, aliases.
const BuiltinSub = struct { builtin: []const u8, name: []const u8, description: []const u8, aliases: []const []const u8 = &.{} };

/// Built-in subcommands.
const builtin_subcommands = [_]BuiltinSub{
    .{ .builtin = "mcp", .name = "add", .description = "Register as MCP server" },
    .{ .builtin = "mcp", .name = "doctor", .description = "Validate MCP server startup and tool listing" },
    .{ .builtin = "skills", .name = "add", .description = "Sync skill files to agents" },
    .{ .builtin = "skills", .name = "list", .description = "List skills", .aliases = &.{"ls"} },
};

/// Built-in command names and descriptions.
const builtins = [_]struct { []const u8, []const u8 }{
    .{ "completions", "Generate shell completion script" },
    .{ "mcp", "Register as MCP server" },
    .{ "skills", "Sync skill files to agents" },
};

/// Finds a built-in subcommand by name or alias.
fn findSub(subs: []const BuiltinSub, name: []const u8) ?BuiltinSub {
    for (subs) |s| {
        if (std.mem.eql(u8, s.name, name) or contains(s.aliases, name)) return s;
    }
    return null;
}

/// Resolves a token to a built-in command name.
fn findBuiltin(token: []const u8) ?[]const u8 {
    if (std.mem.eql(u8, token, "completions")) return "completions";
    if (std.mem.eql(u8, token, "mcp")) return "mcp";
    if (std.mem.eql(u8, token, "skills") or std.mem.eql(u8, token, "skill")) return "skills";
    return null;
}

/// Resolves a token to a built-in command name, unless a registered command or alias of the same
/// name shadows it.
fn findUnshadowedBuiltin(commands: Commands, token: []const u8) ?[]const u8 {
    if (lookup(commands, token) != null) return null;
    return findBuiltin(token);
}

/// Output settings resolved for a command.
const Output = struct {
    /// The built-in flags.
    flags: *const Flags,
    /// The effective format.
    format: Format,
    /// Whether output targets a terminal.
    human: bool,
    /// Parsed `--filter-output` paths.
    filter: ?[]const filter.Path,
    /// Whether data renders for this consumer.
    render: bool,
};

/// A handler's data and suggested commands, or a failure.
const Result = union(enum) {
    ok: struct { data: ?Value, cta: ?FormattedCtaBlock },
    err: Error,
};

/// The per-invocation serve state.
const Run = struct {
    a: Allocator,
    cli: *Cli,
    /// Suggestions appended to the output: stale skills and available updates.
    notice: ?FormattedCtaBlock = null,
    display_name: []const u8,
    exit: u8 = 0,
    process: Process,
    root: ?Command,
    start: std.Io.Timestamp,

    /// Writes to stdout.
    fn write(run: *Run, text: []const u8) void {
        js.writeWellFormed(run.process.stdout, text) catch {};
    }

    /// Writes a line to stdout.
    fn writeln(run: *Run, text: []const u8) void {
        run.write(text);
        if (!std.mem.endsWith(u8, text, "\n")) run.write("\n");
    }

    /// Returns the elapsed time as `Nms`.
    fn duration(run: *Run) Allocator.Error![]const u8 {
        const elapsed = run.start.durationTo(std.Io.Clock.awake.now(run.process.io));
        return std.fmt.allocPrint(run.a, "{d}ms", .{@divTrunc(elapsed.nanoseconds, std.time.ns_per_ms)});
    }

    /// Returns the config flag name.
    fn configFlag(run: *Run) ?[]const u8 {
        const config = run.cli.options.config orelse return null;
        return config.flag;
    }

    /// Base help options shared by most help output.
    fn helpOptions(run: *Run) help.Options {
        return .{ .config_flag = run.configFlag(), .globals = run.cli.options.globals, .hide_skills = run.cli.options.sync == null, .hide_update = run.cli.options.update == null };
    }

    /// Reports an error before a command resolves.
    fn earlyError(run: *Run, e: Error, human: bool, format: Format) Allocator.Error!void {
        run.writeln(if (human) try errors.humanError(run.a, e) else try formatter.format(run.a, try e.toValue(run.a), format));
        run.exit = 1;
    }

    /// Writes the banner when its mode matches.
    fn banner(run: *Run, human: bool, is_help: bool) ServeError!void {
        const b = run.cli.options.banner orelse return;
        if (is_help) return;
        const matches = switch (b.mode) {
            .all => true,
            .human => human,
            .agent => !human,
        };
        if (!matches) return;
        const text = try command.optional(b.render(run.process.io, run.a)) orelse null;
        if (errors.nonEmpty(text)) |t| run.writeln(t);
    }

    /// Serves one invocation.
    fn serve(run: *Run, argv: []const []const u8) ServeError!void {
        const a = run.a;
        const cli = run.cli;
        if (run.process.env.get("COMPLETE")) |shell| return run.complete(shell, argv);
        const tty = run.process.tty;
        const flags = switch (try extractFlags(a, argv, run.configFlag(), cli.options.update != null)) {
            .ok => |f| f,
            .err => |e| return run.earlyError(e, tty, .toon),
        };
        const human = tty and !flags.format_explicit;

        const filtered = if (cli.options.globals) |globals| switch (try parser.parseGlobals(a, flags.rest, globals, .{ .command = .unknown })) {
            .ok => |g| g.rest,
            .err => |e| return run.earlyError(e, human, flags.format),
        } else flags.rest;

        // Generated groups load only when this invocation can reach them: by name, or through
        // tree-wide modes.
        const first: ?[]const u8 = if (filtered.len > 0) filtered[0] else null;
        const all = flags.mcp or ((flags.llms or flags.llms_full) and first == null) or
            (first != null and (std.mem.eql(u8, first.?, cli.name) or findBuiltin(first.?) != null));
        if (try cli.load(a, &run.process, if (all) null else first orelse "")) |e| return run.earlyError(e, human, flags.format);

        if (flags.update_check) {
            if (cli.options.update) |u| _ = try command.optional(update_api.refresh(a, &run.process, cli.name, run.updateOptions(u)));
            return;
        }
        // --help takes precedence over --update.
        if (flags.update and !flags.help) return run.install(&flags, human);
        if (flags.mcp) {
            if (try mcp.serveStdio(a, cli, &run.process)) |message| {
                run.process.stderr.print("{s}\n", .{message}) catch {};
                run.exit = 1;
            }
            return;
        }

        if (cli.options.sync != null and !flags.llms and !flags.llms_full and !flags.schema and !flags.help and !flags.version and
            builtinIndex(cli, filtered, "skills") == null and builtinIndex(cli, filtered, "mcp") == null)
            run.notice = try sync_api.staleNotice(a, cli, &run.process, run.display_name);

        if (flags.llms or flags.llms_full) return run.llms(&flags, filtered);

        if (builtinIndex(cli, filtered, "completions")) |index| {
            if (index + 1 >= filtered.len or flags.help) return run.completionsHelp();
            const name = filtered[index + 1];
            const shell = std.meta.stringToEnum(completions.Shell, name) orelse {
                run.writeln(try errors.humanError(a, .{
                    .code = "INVALID_SHELL",
                    .message = try std.fmt.allocPrint(a, "Unknown shell '{s}'. Supported: bash, fish, nushell, zsh", .{name}),
                }));
                run.exit = 1;
                return;
            };
            run.writeln(try run.registerAll(shell));
            return;
        }

        for ([_][]const u8{ "skills", "mcp" }) |b| {
            if (std.mem.eql(u8, b, "skills") and cli.options.sync == null) continue;
            if (builtinIndex(cli, filtered, b)) |index| return run.builtin(b, filtered, index, argv, &flags, human);
        }

        if (flags.version and !flags.help) if (cli.options.version) |version| {
            run.writeln(version);
            return;
        };

        if (filtered.len == 0) {
            if (run.root) |*root| {
                const required = if (root.args()) |args| for (args.fields()) |f| {
                    if (!f.ty.isOptional()) break true;
                } else false else false;
                if (human and required) {
                    try run.banner(human, flags.help);
                    const text = try help.formatCommand(a, cli.name, try run.commandHelp(root, cli.options.aliases, cli.options.version, try helpEntries(a, cli.commands.items), true));
                    run.writeln(text);
                    return;
                }
            } else if (cli.options.fetch == null) {
                try run.banner(human, flags.help);
                var options = run.helpOptions();
                options.aliases = cli.options.aliases;
                options.commands = try helpEntries(a, cli.commands.items);
                options.description = cli.options.description;
                options.root = true;
                options.version = cli.options.version;
                run.writeln(try help.formatRoot(a, cli.name, options));
                return;
            }
        }

        const root_gateway: ?*const Gateway = if (cli.options.fetch) |source| gateway: {
            const g = try a.create(Gateway);
            g.* = .{ .description = cli.options.description, .fetch = source };
            break :gateway g;
        } else null;

        var resolved: Resolved = if (run.root != null and filtered.len == 0)
            .{ .command = .{ .command = &run.root.?, .path = cli.name, .rest = &.{} } }
        else if (root_gateway != null and filtered.len == 0)
            .{ .gateway = .{ .gateway = root_gateway.?, .path = cli.name, .rest = &.{} } }
        else
            try resolve(a, cli.commands.items, filtered);

        if (flags.help) return run.showHelp(resolved);
        if (flags.schema) return run.showSchema(resolved, &flags);

        const command_format = if (resolved == .command) resolved.command.command.format else null;
        const format = if (flags.format_explicit) flags.format else command_format orelse cli.options.format orelse .toon;

        if (resolved == .help) {
            const h = resolved.help;
            var options = run.helpOptions();
            options.commands = try helpEntries(a, h.commands);
            options.description = h.description;
            options.hide_skills = false;
            options.hide_update = false;
            run.writeln(try help.formatRoot(a, try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, h.path }), options));
            return;
        }

        if (human) if (cli.options.update) |u| if (try update_api.notice(a, &run.process, cli.name, run.updateOptions(u))) |available| {
            const commands = try a.dupe(FormattedCta, &.{.{
                .command = try std.fmt.allocPrint(a, "{s} --update", .{run.display_name}),
                .description = try std.fmt.allocPrint(a, "upgrade from {s} to {s}", .{ available.current, available.latest }),
            }});
            const block: FormattedCtaBlock = .{ .description = try std.fmt.allocPrint(a, "Update available for {s}:", .{available.name}), .commands = commands };
            run.notice = if (run.notice) |n| try mergeCta(a, n, block) else block;
        };

        // A token that is not a typo of a known command falls back to the root command or root
        // fetch. A token starting with `/` is a request path, never a mistyped command.
        if (resolved == .err and resolved.err.path.len == 0 and (run.root != null or root_gateway != null)) {
            var candidates: std.ArrayList([]const u8) = .empty;
            try candidates.appendSlice(a, try names(a, resolved.err.commands));
            for (builtins) |b| if (cli.options.sync != null or !std.mem.eql(u8, b[0], "skills")) try candidates.append(a, b[0]);
            const blocked = !std.mem.startsWith(u8, resolved.err.token, "/") and try suggest(a, resolved.err.token, candidates.items) != null;
            if (!blocked) resolved = if (root_gateway) |g|
                .{ .gateway = .{ .gateway = g, .path = cli.name, .rest = filtered } }
            else
                .{ .command = .{ .command = &run.root.?, .path = cli.name, .rest = filtered } };
        }

        const policy = switch (resolved) {
            .command => |c| c.output_policy,
            .gateway => |g| g.output_policy,
            else => null,
        } orelse cli.options.output_policy;
        const output: Output = .{
            .flags = &flags,
            .format = format,
            .human = human,
            .filter = flags.filter_output,
            .render = !(human and policy == .agent_only),
        };

        switch (resolved) {
            .err => |e| try run.notFound(e.token, e.path, e.commands, argv, &output),
            .command => |c| try run.execute(c.command, c.middleware, c.path, filtered, c.rest, &output),
            .gateway => |g| try run.executeGateway(g.gateway, g.middleware, g.path, filtered, g.rest, &output),
            // Group help returned above.
            .help => {},
        }
    }

    /// Returns the update settings with the CLI version.
    fn updateOptions(run: *Run, u: Update) update_api.Options {
        return .{ .update = u, .version = run.cli.options.version };
    }

    /// Installs the latest version for `--update`.
    fn install(run: *Run, flags: *const Flags, human: bool) ServeError!void {
        const a = run.a;
        const cli = run.cli;
        const result = switch (try update_api.install(a, &run.process, cli.name, run.updateOptions(cli.options.update.?))) {
            .ok => |r| r,
            .err => |message| return run.earlyError(.{ .code = "UPDATE_FAILED", .message = message }, human, flags.format),
        };
        if (human) {
            var lines: std.ArrayList([]const u8) = .empty;
            try lines.append(a, try std.fmt.allocPrint(a, "{s} {s}", .{ if (result.deferred) "\u{2713} Update staged for" else "\u{2713} Updated", result.name }));
            if (result.command) |c| try lines.append(a, try std.fmt.allocPrint(a, "  {s}", .{c}));
            if (result.deferred) try lines.append(a, "  Installation will finish after this process exits.");
            run.writeln(try std.mem.join(a, "\n", lines.items));
            return;
        }
        var out: json.ObjectBuilder = .{};
        if (result.command) |c| try out.put(a, "command", .{ .string = c });
        if (result.deferred) try out.put(a, "deferred", .{ .bool = true });
        try out.put(a, "name", .{ .string = result.name });
        run.writeln(try formatter.format(a, out.finish(), flags.format));
    }

    /// Returns the completion scripts for every CLI name.
    fn registerAll(run: *Run, shell: completions.Shell) Allocator.Error![]const u8 {
        var scripts: std.ArrayList([]const u8) = .empty;
        try scripts.append(run.a, try completions.register(run.a, shell, run.cli.name));
        for (run.cli.options.aliases) |alias| try scripts.append(run.a, try completions.register(run.a, shell, alias));
        return std.mem.join(run.a, "\n", scripts.items);
    }

    /// Help options for a command.
    fn commandHelp(run: *Run, c: *const Command, aliases: []const []const u8, version: ?[]const u8, commands: []const help.Entry, root: bool) Allocator.Error!help.Options {
        var options = run.helpOptions();
        options.aliases = aliases;
        options.args = c.args();
        options.commands = if (commands.len > 0) commands else null;
        options.description = c.description;
        options.env = c.env();
        options.env_source = run.process.env;
        options.examples = c.examples;
        options.hint = c.hint;
        options.options = c.options();
        options.root = root;
        options.usage = c.usage;
        options.version = version;
        return options;
    }

    /// Prints help for the resolved target.
    fn showHelp(run: *Run, resolved: Resolved) Allocator.Error!void {
        const a = run.a;
        const cli = run.cli;
        const text = switch (resolved) {
            .help => |h| text: {
                var options = run.helpOptions();
                options.commands = try helpEntries(a, h.commands);
                options.description = h.description;
                break :text try help.formatRoot(a, try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, h.path }), options);
            },
            .err => text: {
                const entries = try helpEntries(a, cli.commands.items);
                if (run.root) |*root| if (entries.len > 0)
                    break :text try help.formatCommand(a, cli.name, try run.commandHelp(root, cli.options.aliases, cli.options.version, entries, true));
                var options = run.helpOptions();
                options.aliases = cli.options.aliases;
                options.commands = entries;
                options.description = cli.options.description;
                options.root = true;
                options.version = cli.options.version;
                break :text try help.formatRoot(a, cli.name, options);
            },
            .command => |c| text: {
                const is_root = std.mem.eql(u8, c.path, cli.name);
                const name = if (is_root) cli.name else try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, c.path });
                const entries = if (c.commands != null and c.commands.?.len > 0)
                    try helpEntries(a, c.commands.?)
                else if (is_root) try helpEntries(a, cli.commands.items) else &.{};
                const options = try run.commandHelp(
                    c.command,
                    if (is_root) cli.options.aliases else c.command.aliases,
                    if (is_root) cli.options.version else null,
                    entries,
                    is_root,
                );
                break :text try help.formatCommand(a, name, options);
            },
            .gateway => |g| text: {
                const is_root = std.mem.eql(u8, g.path, cli.name);
                // A root fetch on a CLI with commands shows the CLI's help.
                if (is_root and cli.commands.items.len > 0) {
                    var options = run.helpOptions();
                    options.globals = null;
                    options.aliases = cli.options.aliases;
                    options.commands = try helpEntries(a, cli.commands.items);
                    options.description = cli.options.description;
                    options.root = true;
                    options.version = cli.options.version;
                    break :text try help.formatRoot(a, cli.name, options);
                }
                const name = if (is_root) cli.name else try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, g.path });
                break :text try fetch_api.help(a, name, g.gateway.description);
            },
        };
        run.writeln(text);
    }

    /// Prints the JSON Schema of the resolved command.
    fn showSchema(run: *Run, resolved: Resolved, flags: *const Flags) Allocator.Error!void {
        const a = run.a;
        const cli = run.cli;
        switch (resolved) {
            .help => |h| {
                var options = run.helpOptions();
                options.commands = try helpEntries(a, h.commands);
                options.description = h.description;
                options.hide_skills = false;
                run.writeln(try help.formatRoot(a, try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, h.path }), options));
            },
            .err => |e| {
                const parent = if (e.path.len == 0) cli.name else try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, e.path });
                const suggestion = if (try suggest(a, e.token, try names(a, e.commands))) |s| try std.fmt.allocPrint(a, " Did you mean '{s}'?", .{s}) else "";
                run.writeln(try std.fmt.allocPrint(a, "Error: '{s}' is not a command for '{s}'.{s}", .{ e.token, parent, suggestion }));
                run.exit = 1;
            },
            .gateway => {
                run.writeln("--schema is not supported for fetch commands.");
                run.exit = 1;
            },
            .command => |c| {
                const format: Format = if (flags.format_explicit) flags.format else .toon;
                var out: json.ObjectBuilder = .{};
                for ([_]struct { []const u8, ?*const Type }{
                    .{ "args", c.command.args() },
                    .{ "env", c.command.env() },
                    .{ "options", c.command.options() },
                    .{ "output", c.command.output },
                    .{ "globals", cli.options.globals },
                }) |entry| if (entry[1]) |ty| try out.put(a, entry[0], try schema.jsonSchema(a, ty));
                run.writeln(try formatter.format(a, out.finish(), format));
            },
        }
    }

    /// Prints `--llms` or `--llms-full` output.
    fn llms(run: *Run, flags: *const Flags, filtered: []const []const u8) Allocator.Error!void {
        const a = run.a;
        const cli = run.cli;
        var commands: Commands = cli.commands.items;
        var prefix: std.ArrayList([]const u8) = .empty;
        var description = cli.options.description;
        var root: ?*const Command = if (run.root) |*r| r else null;
        for (filtered) |token| {
            const entry = lookup(commands, token) orelse break;
            switch (entry) {
                .group => |g| {
                    commands = g.commands.items;
                    description = g.options.description;
                    root = if (g.options.root) |*r| r else null;
                    try prefix.append(a, token);
                },
                .alias, .command => |c| {
                    commands = try a.dupe(Named, &.{.{ .name = token, .entry = .{ .command = c } }});
                    root = null;
                    break;
                },
                .gateway => {
                    commands = try a.dupe(Named, &.{.{ .name = token, .entry = entry }});
                    root = null;
                    break;
                },
            }
        }
        if (prefix.items.len == 0) root = if (run.root) |*r| r else null;
        const markdown = !flags.format_explicit or flags.format == .md;
        const scoped = if (prefix.items.len == 0) cli.name else try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, try std.mem.join(a, " ", prefix.items) });
        if (markdown) {
            var groups: std.ArrayList(skill.Group) = .empty;
            var infos: std.ArrayList(skill.CommandInfo) = .empty;
            if (root) |r| try infos.append(a, try commandInfo(a, null, r));
            try skillCommands(a, &infos, commands, &.{}, &groups);
            sortInfos(infos.items);
            run.writeln(if (flags.llms_full)
                try skill.generate(a, scoped, infos.items, groups.items)
            else
                try skill.index(a, scoped, infos.items, description));
            return;
        }
        var entries: std.ArrayList(Value) = .empty;
        try manifestCommands(a, &entries, commands, prefix.items, flags.llms_full);
        if (root) |r| if (prefix.items.len > 0) try entries.append(a, try manifestEntry(a, try std.mem.join(a, " ", prefix.items), r, flags.llms_full));
        std.mem.sort(Value, entries.items, {}, struct {
            fn lessThan(_: void, x: Value, y: Value) bool {
                return js.localeCompare(x.get("name").?.string, y.get("name").?.string) == .lt;
            }
        }.lessThan);
        var manifest: json.ObjectBuilder = .{};
        try manifest.put(a, "version", .{ .string = "incur.v1" });
        try manifest.put(a, "commands", .{ .array = entries.items });
        if (cli.options.globals) |g| try manifest.put(a, "globals", try schema.jsonSchema(a, g));
        run.writeln(try formatter.format(a, manifest.finish(), flags.format));
    }

    /// Prints help for the `completions` built-in.
    fn completionsHelp(run: *Run) Allocator.Error!void {
        const a = run.a;
        const name = run.cli.name;
        const rows = [_][3][]const u8{
            .{ "bash", try std.fmt.allocPrint(a, "eval \"$({s} completions bash)\"", .{name}), "# add to ~/.bashrc" },
            .{ "fish", try std.fmt.allocPrint(a, "{s} completions fish | source", .{name}), "# add to ~/.config/fish/config.fish" },
            .{ "nushell", try std.fmt.allocPrint(a, "see `{s} completions nushell`", .{name}), "# add to config.nu" },
            .{ "zsh", try std.fmt.allocPrint(a, "eval \"$({s} completions zsh)\"", .{name}), "# add to ~/.zshrc" },
        };
        var width: usize = 0;
        for (rows) |r| width = @max(width, js.utf16Len(r[1]));
        var hint: std.ArrayList(u8) = .empty;
        try hint.appendSlice(a, "Setup:");
        for (rows) |r| try hint.print(a, "\n  {s}  {s}  {s}", .{ try js.pad(a, r[0], 7), try js.pad(a, r[1], width), r[2] });
        const args: Type = .{ .kind = .{ .object = &.{.{
            .name = "shell",
            .ty = .{ .kind = .{ .@"enum" = &.{ "bash", "fish", "nushell", "zsh" } }, .description = "Shell to generate completions for" },
        }} } };
        run.writeln(try help.formatCommand(a, try std.fmt.allocPrint(a, "{s} completions", .{name}), .{
            .args = &args,
            .description = "Generate shell completion script",
            .hide_global_options = true,
            .hint = hint.items,
        }));
    }

    /// Handles the `skills` and `mcp` built-ins.
    fn builtin(run: *Run, b: []const u8, filtered: []const []const u8, index: usize, argv: []const []const u8, flags: *const Flags, human: bool) ServeError!void {
        const a = run.a;
        const name = run.cli.name;
        var subs: std.ArrayList(BuiltinSub) = .empty;
        for (builtin_subcommands) |s| if (std.mem.eql(u8, s.builtin, b)) try subs.append(a, s);
        if (index + 1 >= filtered.len) {
            const entries = try a.alloc(help.Entry, subs.items.len);
            for (subs.items, entries) |s, *slot| slot.* = .{ .name = s.name, .description = s.description };
            const skills = std.mem.eql(u8, b, "skills");
            run.writeln(try help.formatRoot(a, try std.fmt.allocPrint(a, "{s} {s}", .{ name, b }), .{
                .aliases = if (skills) &.{"skill"} else &.{},
                .commands = entries,
                .description = if (skills) builtins[2][1] else builtins[1][1],
            }));
            return;
        }
        const sub = filtered[index + 1];
        const found = findSub(subs.items, sub) orelse {
            var candidates: std.ArrayList([]const u8) = .empty;
            for (subs.items) |s| {
                try candidates.append(a, s.name);
                try candidates.appendSlice(a, s.aliases);
            }
            const suggestion = try suggest(a, sub, candidates.items);
            const did_you_mean = if (suggestion) |s| try std.fmt.allocPrint(a, " Did you mean '{s}'?", .{s}) else "";
            const message = try std.fmt.allocPrint(a, "'{s}' is not a command for '{s} {s}'.{s}", .{ sub, name, b, did_you_mean });
            const cta = try notFoundCta(a, name, argv, sub, suggestion, try std.fmt.allocPrint(a, "{s} {s} --help", .{ name, b }));
            const e: Error = .{ .code = "COMMAND_NOT_FOUND", .message = message };
            if (human) {
                run.writeln(try errors.humanError(a, e));
                run.writeln(try cta.human(a));
            } else {
                var value: json.ObjectBuilder = .{};
                try value.put(a, "code", .{ .string = e.code });
                try value.put(a, "message", .{ .string = e.message });
                try value.put(a, "cta", try cta.toValue(a));
                run.writeln(try formatter.format(a, value.finish(), .toon));
            }
            run.exit = 1;
            return;
        };
        if (flags.help) {
            const mcp_add: Type = .{ .kind = .{ .object = &.{
                .{ .name = "agent", .ty = .{ .kind = .{ .string = .{} }, .optional = true, .description = "Target a specific agent (e.g. claude-code, cursor)" } },
                .{ .name = "command", .alias = 'c', .ty = .{ .kind = .{ .string = .{} }, .optional = true, .description = "Override the command agents will run (e.g. \"pnpm my-cli --mcp\")" } },
                .{ .name = "noGlobal", .ty = .{ .kind = .boolean, .optional = true, .description = "Install to project instead of globally" } },
            } } };
            const skills_add: Type = .{ .kind = .{ .object = &.{
                .{ .name = "depth", .ty = .{ .kind = .{ .number = .{} }, .optional = true, .description = "Grouping depth for skill files (default: 1)" } },
                .{ .name = "noGlobal", .ty = .{ .kind = .boolean, .optional = true, .description = "Install to project instead of globally" } },
            } } };
            const is_add = std.mem.eql(u8, found.name, "add");
            const options: ?*const Type = if (!is_add) null else if (std.mem.eql(u8, b, "mcp")) &mcp_add else &skills_add;
            run.writeln(try help.formatCommand(a, try std.fmt.allocPrint(a, "{s} {s} {s}", .{ name, b, found.name }), .{
                .aliases = found.aliases,
                .description = found.description,
                .hide_global_options = true,
                .options = options,
            }));
            return;
        }
        const rest = filtered[index + 2 ..];
        const format: Format = if (flags.format_explicit) flags.format else .toon;
        if (std.mem.eql(u8, b, "mcp")) {
            if (std.mem.eql(u8, found.name, "doctor")) {
                const result = try mcp.doctor(a, run.cli, &run.process);
                run.writeln(try formatter.format(a, result.value, format));
                if (!result.ok) run.exit = 1;
                return;
            }
            return run.mcpAdd(rest, flags, format);
        }
        if (std.mem.eql(u8, found.name, "list")) return run.skillsList();
        return run.skillsAdd(rest, flags, format);
    }

    /// Writes a failed built-in action and sets the exit code.
    fn builtinFailure(run: *Run, code: []const u8, message: []const u8, format: Format) Allocator.Error!void {
        var out: json.ObjectBuilder = .{};
        try out.put(run.a, "code", .{ .string = code });
        try out.put(run.a, "message", .{ .string = message });
        run.writeln(try formatter.format(run.a, out.finish(), format));
        run.exit = 1;
    }

    /// Lists skills with their install status for `skills list`.
    fn skillsList(run: *Run) ServeError!void {
        const a = run.a;
        const skills = try sync_api.list(a, run.cli, &run.process);
        if (skills.len == 0) return run.writeln("No skills found.");
        var width: usize = 0;
        for (skills) |skill_| width = @max(width, js.utf16Len(skill_.name));
        var lines: std.ArrayList([]const u8) = .empty;
        var installed: usize = 0;
        for (skills) |skill_| {
            if (skill_.installed) installed += 1;
            const padding = if (errors.nonEmpty(skill_.description)) |d| try std.fmt.allocPrint(a, "{s}  {s}", .{ try js.repeat(a, " ", width - js.utf16Len(skill_.name)), d }) else "";
            try lines.append(a, try std.fmt.allocPrint(a, "  {s} {s}{s}", .{ if (skill_.installed) "\u{2713}" else "\u{2717}", skill_.name, padding }));
        }
        try lines.append(a, "");
        try lines.append(a, try std.fmt.allocPrint(a, "{d} skill{s} ({d} installed)", .{ skills.len, if (skills.len == 1) "" else "s", installed }));
        run.writeln(try std.mem.join(a, "\n", lines.items));
    }

    /// Generates and installs skill files for `skills add`.
    fn skillsAdd(run: *Run, rest: []const []const u8, flags: *const Flags, format: Format) ServeError!void {
        const a = run.a;
        const sync = run.cli.options.sync.?;
        const depth = for (rest, 0..) |token, i| {
            if (std.mem.eql(u8, token, "--depth")) break js.toNumber(if (i + 1 < rest.len) rest[i + 1] else "undefined");
        } else for (rest) |token| {
            if (std.mem.startsWith(u8, token, "--depth=")) {
                var parts = std.mem.splitScalar(u8, token, '=');
                _ = parts.next();
                break js.toNumber(parts.next().?);
            }
        } else sync.depth;
        const global = !contains(rest, "--no-global");
        run.write("Syncing...");
        const result = switch (try sync_api.add(a, run.cli, &run.process, depth, global)) {
            .ok => |r| r,
            .err => |message| return run.builtinFailure("SYNC_SKILLS_FAILED", message, format),
        };
        run.write("\r\x1b[K");
        var width: usize = 0;
        for (result.skills) |skill_| width = @max(width, js.utf16Len(skill_.name));
        var lines: std.ArrayList([]const u8) = .empty;
        for (result.skills) |skill_| {
            const padding = if (errors.nonEmpty(skill_.description)) |d| try std.fmt.allocPrint(a, "{s}  {s}", .{ try js.repeat(a, " ", width - js.utf16Len(skill_.name)), d }) else "";
            try lines.append(a, try std.fmt.allocPrint(a, "  \u{2713} {s}{s}", .{ skill_.name, padding }));
        }
        try lines.append(a, "");
        try lines.append(a, try std.fmt.allocPrint(a, "{d} skill{s} synced", .{ result.skills.len, if (result.skills.len == 1) "" else "s" }));
        if (errors.nonEmpty(sync.body)) |body| try lines.appendSlice(a, &.{ "", body });
        if (sync.suggestions.len > 0) {
            try lines.appendSlice(a, &.{ "", try std.fmt.allocPrint(a, "Your agent can now use {s}. Try asking:", .{run.cli.name}) });
            for (sync.suggestions) |suggestion| try lines.append(a, try std.fmt.allocPrint(a, "  \"{s}\"", .{suggestion}));
        }
        try lines.appendSlice(a, &.{ "", try std.fmt.allocPrint(a, "Run `{s} --help` to see the full command reference.", .{run.cli.name}) });
        run.writeln(try std.mem.join(a, "\n", lines.items));
        if (flags.full_output or flags.format_explicit) {
            var out: json.ObjectBuilder = .{};
            try out.put(a, "skills", try schema.strings(a, result.paths));
            if (errors.nonEmpty(sync.body)) |body| try out.put(a, "body", .{ .string = body });
            if (flags.full_output and result.agents.len > 0) {
                const agents = try a.alloc(Value, result.agents.len);
                for (result.agents, agents) |agent, *slot| {
                    var entry: json.ObjectBuilder = .{};
                    try entry.put(a, "agent", .{ .string = agent.agent });
                    try entry.put(a, "path", .{ .string = agent.path });
                    try entry.put(a, "mode", .{ .string = agent.mode });
                    slot.* = entry.finish();
                }
                try out.put(a, "agents", .{ .array = agents });
            }
            run.writeln(try formatter.format(a, out.finish(), format));
        }
    }

    /// Registers the CLI as an MCP server for `mcp add`.
    fn mcpAdd(run: *Run, rest: []const []const u8, flags: *const Flags, format: Format) ServeError!void {
        const a = run.a;
        const cli = run.cli;
        const settings = cli.options.mcp orelse Mcp{};
        var command_override = settings.command;
        var agents: std.ArrayList([]const u8) = .empty;
        try agents.appendSlice(a, settings.agents);
        var i: usize = 0;
        while (i < rest.len) : (i += 1) {
            const has_value = i + 1 < rest.len and rest[i + 1].len > 0;
            if ((std.mem.eql(u8, rest[i], "--command") or std.mem.eql(u8, rest[i], "-c")) and has_value) {
                i += 1;
                command_override = rest[i];
            } else if (std.mem.eql(u8, rest[i], "--agent") and has_value) {
                i += 1;
                try agents.append(a, rest[i]);
            }
        }
        const name = settings.name orelse cli.name;
        run.write("Registering MCP server...");
        const result = switch (try sync_api.register(a, cli, &run.process, name, command_override, !contains(rest, "--no-global"), agents.items)) {
            .ok => |r| r,
            .err => |message| return run.builtinFailure("MCP_ADD_FAILED", message, format),
        };
        run.write("\r\x1b[K");
        var lines: std.ArrayList([]const u8) = .empty;
        try lines.append(a, try std.fmt.allocPrint(a, "\u{2713} Registered {s} as MCP server", .{name}));
        if (result.agents.len > 0) try lines.append(a, try std.fmt.allocPrint(a, "  Agents: {s}", .{try std.mem.join(a, ", ", result.agents)}));
        try lines.appendSlice(a, &.{ "", try std.fmt.allocPrint(a, "Agents can now use {s} tools.", .{name}) });
        const suggestions = if (cli.options.sync) |sync| sync.suggestions else &.{};
        if (suggestions.len > 0) {
            try lines.appendSlice(a, &.{ "", "Try asking:" });
            for (suggestions) |suggestion| try lines.append(a, try std.fmt.allocPrint(a, "  \"{s}\"", .{suggestion}));
        }
        run.writeln(try std.mem.join(a, "\n", lines.items));
        if (flags.full_output or flags.format_explicit) {
            var out: json.ObjectBuilder = .{};
            try out.put(a, "name", .{ .string = name });
            try out.put(a, "command", .{ .string = result.command });
            try out.put(a, "agents", try schema.strings(a, result.agents));
            run.writeln(try formatter.format(a, out.finish(), format));
        }
    }

    /// Answers a shell completion request.
    fn complete(run: *Run, shell_name: []const u8, argv: []const []const u8) Allocator.Error!void {
        const a = run.a;
        const cli = run.cli;
        const shell = std.meta.stringToEnum(completions.Shell, shell_name) orelse return;
        const words = for (argv, 0..) |t, i| {
            if (std.mem.eql(u8, t, "--")) break argv[i + 1 ..];
        } else argv;
        if (words.len == 0) return run.write(try run.registerAll(shell));
        // The index is a JavaScript number: shells may send anything, and `slice` and element
        // reads interpret it as JavaScript does.
        const index = if (run.process.env.get("_COMPLETE_INDEX")) |raw| js.toNumber(raw) else @as(f64, @floatFromInt(words.len - 1));
        const cut = js.relativeIndex(index, words.len);
        const before: ?[]const []const u8 = before: {
            const extracted = switch (try extractFlags(a, words[0..cut], run.configFlag(), cli.options.update != null)) {
                .ok => |f| f,
                .err => break :before null,
            };
            var rest: std.ArrayList([]const u8) = .empty;
            try rest.appendSlice(a, extracted.rest);
            if (js.element(words.len, index - 1)) |i| if (std.mem.eql(u8, words[i], "--version")) try rest.append(a, "--version");
            const globals = cli.options.globals orelse break :before rest.items;
            break :before switch (try parser.parseGlobals(a, rest.items, globals, .{})) {
                .ok => |g| g.rest,
                .err => null,
            };
        };
        const input = if (before) |b| try std.mem.concat(a, []const u8, &.{ b, words[cut..] }) else words;
        const at = if (before) |b| b.len else cut;
        const root: completions.Node = try tree(a, cli.commands.items, if (run.root) |*r| r else null, null);
        var candidates: std.ArrayList(completions.Candidate) = .empty;
        try candidates.appendSlice(a, try completions.complete(a, &root, input, at, cli.options.globals));
        const current = if (js.element(words.len, index)) |i| words[i] else "";
        if (before) |b| {
            var non_flags: std.ArrayList([]const u8) = .empty;
            for (b) |w| if (!std.mem.startsWith(u8, w, "-")) try non_flags.append(a, w);
            if (non_flags.items.len <= 1) {
                for (builtins) |entry| {
                    const name, const description = entry;
                    if (std.mem.eql(u8, name, "skills") and cli.options.sync == null) continue;
                    if (std.mem.startsWith(u8, name, current) and !listed(candidates.items, name))
                        try candidates.append(a, .{ .description = description, .no_space = !std.mem.eql(u8, name, "completions"), .value = name });
                }
            } else if (non_flags.items.len == 2) if (findUnshadowedBuiltin(cli.commands.items, non_flags.items[1])) |b_name| {
                // A built-in group completes its own subcommands in place of root commands
                if (!std.mem.eql(u8, b_name, "completions") and (cli.options.sync != null or !std.mem.eql(u8, b_name, "skills")) and !std.mem.startsWith(u8, current, "-")) {
                    candidates.clearRetainingCapacity();
                    for (builtin_subcommands) |s| if (std.mem.eql(u8, s.builtin, b_name)) {
                        for (try std.mem.concat(a, []const u8, &.{ &.{s.name}, s.aliases })) |value| {
                            if (std.mem.startsWith(u8, value, current))
                                try candidates.append(a, .{ .description = s.description, .value = value });
                        }
                    };
                }
            };
        }
        const out = try completions.format(a, shell, candidates.items);
        if (out.len > 0) run.write(out);
    }

    /// Reports an unknown command.
    fn notFound(run: *Run, token: []const u8, path: []const u8, commands: Commands, argv: []const []const u8, output: *const Output) Allocator.Error!void {
        const a = run.a;
        const cli = run.cli;
        const parent = if (path.len == 0) cli.name else try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, path });
        var candidates: std.ArrayList([]const u8) = .empty;
        try candidates.appendSlice(a, try names(a, commands));
        if (path.len == 0) for (builtins) |b| if (cli.options.sync != null or !std.mem.eql(u8, b[0], "skills")) try candidates.append(a, b[0]);
        const suggestion = try suggest(a, token, candidates.items);
        const did_you_mean = if (suggestion) |s| try std.fmt.allocPrint(a, " Did you mean '{s}'?", .{s}) else "";
        const message = try std.fmt.allocPrint(a, "'{s}' is not a command for '{s}'.{s}", .{ token, parent, did_you_mean });
        const cta = try notFoundCta(a, cli.name, argv, token, suggestion, try std.fmt.allocPrint(a, "{s} --help", .{parent}));
        const failure: Error = .{ .code = "COMMAND_NOT_FOUND", .message = message };
        if (output.human and !output.flags.full_output) {
            run.writeln(try errors.humanError(a, failure));
            run.writeln(try (if (run.notice) |n| try mergeCta(a, cta, n) else cta).human(a));
        } else {
            try run.writeOutput(output, false, try failure.toValue(a), token, cta);
        }
        run.exit = 1;
    }

    /// Truncates text to the requested token window. Returns the text, whether it was
    /// truncated, and the next offset.
    fn truncate(run: *Run, flags: *const Flags, text: []const u8) Allocator.Error!struct { []const u8, bool, ?f64 } {
        const a = run.a;
        if (flags.token_limit == null and flags.token_offset == null) return .{ text, false, null };
        const total: f64 = @floatFromInt(try tokens.estimate(a, text));
        const offset = flags.token_offset orelse 0;
        const end = if (flags.token_limit) |limit| offset + limit else total;
        if (offset == 0 and end >= total) return .{ text, false, null };
        const sliced = try tokens.slice(a, text, offset, end);
        const actual_end = @min(end, total);
        return .{
            try std.fmt.allocPrint(a, "{s}\n[truncated: showing tokens {s}\u{2013}{s} of {s}]", .{
                sliced,
                try js.numberToString(a, @min(offset, total)),
                try js.numberToString(a, actual_end),
                try js.numberToString(a, total),
            }),
            true,
            if (actual_end < total) actual_end else null,
        };
    }

    /// Writes a command result.
    fn writeOutput(run: *Run, output: *const Output, ok: bool, raw_body: ?Value, path: []const u8, own_cta: ?FormattedCtaBlock) Allocator.Error!void {
        const a = run.a;
        const cta = if (run.notice) |n| (if (own_cta) |c| try mergeCta(a, c, n) else n) else own_cta;
        const flags = output.flags;
        const format = output.format;
        const body = if (output.filter != null and ok and raw_body != null) try filter.apply(a, raw_body.?, output.filter.?) else raw_body;
        if (flags.token_count) {
            const text = if (body) |b| try formatter.format(a, b, format) else "";
            run.writeln(try std.fmt.allocPrint(a, "{d}", .{try tokens.estimate(a, text)}));
            return;
        }
        if (output.human and !flags.full_output) {
            if (ok) {
                if (body) |data| if (data != .null and output.render) run.writeln((try run.truncate(flags, try formatter.format(a, data, format)))[0]);
            } else if (body) |e| {
                run.writeln(try errors.humanError(a, .{ .code = e.get("code").?.string, .message = e.get("message").?.string, .hint = if (e.get("hint")) |h| h.string else null }));
            }
            if (cta) |c| run.writeln(try c.human(a));
            return;
        }
        var meta: json.ObjectBuilder = .{};
        try meta.put(a, "command", .{ .string = path });
        try meta.put(a, "duration", .{ .string = try run.duration() });
        if (cta) |c| try meta.put(a, "cta", try c.toValue(a));
        if (flags.full_output) {
            const key = if (ok) "data" else "error";
            if (flags.token_limit != null or flags.token_offset != null) {
                const text = if (body) |b| try formatter.format(a, b, format) else "";
                const truncated, const was_truncated, const next = try run.truncate(flags, text);
                if (was_truncated) {
                    var envelope: json.ObjectBuilder = .{};
                    try envelope.put(a, "ok", .{ .bool = ok });
                    try envelope.put(a, key, .{ .string = truncated });
                    if (next) |n| try meta.put(a, "nextOffset", .{ .float = n });
                    try envelope.put(a, "meta", meta.finish());
                    run.writeln(try formatter.format(a, envelope.finish(), format));
                    return;
                }
            }
            var envelope: json.ObjectBuilder = .{};
            try envelope.put(a, "ok", .{ .bool = ok });
            if (body) |b| try envelope.put(a, key, b);
            try envelope.put(a, "meta", meta.finish());
            run.writeln(try formatter.format(a, envelope.finish(), format));
            return;
        }
        const c = cta orelse {
            const text = if (body) |b| try formatter.format(a, b, format) else "";
            if (text.len > 0) run.writeln((try run.truncate(flags, text))[0]);
            return;
        };
        var payload: json.ObjectBuilder = .{};
        if (body) |b| {
            if (b == .object) try payload.entries.appendSlice(a, b.object) else try payload.put(a, "data", b);
        }
        try payload.put(a, "cta", try c.toValue(a));
        run.writeln((try run.truncate(flags, try formatter.format(a, payload.finish(), format)))[0]);
    }

    /// Writes a failure and sets the exit code.
    fn writeFailure(run: *Run, output: *const Output, e: Error, path: []const u8) Allocator.Error!void {
        const cta = try FormattedCtaBlock.init(run.a, run.display_name, e.cta);
        try run.writeOutput(output, false, try e.toValue(run.a), path, cta);
        run.exit = e.exit_code orelse 1;
    }

    /// Writes deprecation warnings for deprecated flags.
    fn deprecations(run: *Run, argv: []const []const u8, options: ?*const Type) Allocator.Error!void {
        const a = run.a;
        const opts = options orelse return;
        var kebabs: std.ArrayList([]const u8) = .empty;
        var aliases: std.ArrayList(?u8) = .empty;
        for (opts.fields()) |f| if (f.ty.deprecated) {
            try kebabs.append(a, try js.toKebab(a, f.name));
            try aliases.append(a, f.alias);
        };
        for (argv) |token| {
            if (std.mem.startsWith(u8, token, "--")) {
                const stripped = token[2 .. 2 + (std.mem.findScalar(u8, token[2..], '=') orelse token.len - 2)];
                const raw = if (std.mem.startsWith(u8, stripped, "no-") and !contains(kebabs.items, stripped)) stripped[3..] else stripped;
                if (contains(kebabs.items, raw)) run.process.stderr.print("Warning: --{s} is deprecated\n", .{raw}) catch {};
            } else if (token.len >= 2 and token[0] == '-') {
                var it = js.Utf8.init(token[1..]);
                while (it.next()) |ch| for (aliases.items, kebabs.items) |alias, kebab| {
                    if (alias != null and alias.? == ch) {
                        run.process.stderr.print("Warning: --{s} is deprecated\n", .{kebab}) catch {};
                        break;
                    }
                };
            }
        }
    }

    /// Resolves a config path: `~` against `HOME`, others against the working directory.
    fn resolvePath(run: *Run, p: []const u8) Allocator.Error![]const u8 {
        const a = run.a;
        if (std.mem.startsWith(u8, p, "~") and (p.len == 1 or p[1] == '/')) {
            const home = run.process.env.get("HOME") orelse "";
            const rest = std.mem.trimStart(u8, p[1..], "/");
            return if (rest.len == 0) home else join(a, home, rest);
        }
        const cwd = std.process.currentPathAlloc(run.process.io, a) catch |err| switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            // Rust's `current_dir().unwrap_or_default()`: an unknown directory resolves relative.
            else => "",
        };
        return join(a, cwd, p);
    }

    /// Loads config-file defaults for a command path.
    fn configDefaults(run: *Run, path: []const u8, flags: *const Flags) ServeError!parser.Result(?[]const Value.Entry) {
        const a = run.a;
        const io = run.process.io;
        const config = run.cli.options.config orelse return .{ .ok = null };
        if (flags.config_disabled) return .{ .ok = null };
        const target: ?[]const u8 = if (flags.config_path) |p| try run.resolvePath(p) else target: {
            const files = if (config.files.len == 0) &[_][]const u8{try std.fmt.allocPrint(a, "{s}.json", .{run.cli.name})} else config.files;
            for (files) |f| {
                const resolved = try run.resolvePath(f);
                if (exists(io, resolved)) break :target resolved;
            }
            break :target null;
        };
        const parsed: Value = if (config.loader) |loader| parsed: {
            var failure: command.Failure = .{};
            var load: Config.Load = .{ .allocator = a, .io = io, .failure = &failure };
            const loaded = loader(&load, target) catch |err| return .{ .err = try failure.take(err) };
            const value = loaded orelse return .{ .ok = null };
            if (value != .object) return .{ .err = .{ .message = "Config loader must return a plain object or undefined" } };
            break :parsed value;
        } else parsed: {
            const t = target orelse return .{ .ok = null };
            const raw = std.Io.Dir.cwd().readFileAlloc(io, t, a, .unlimited) catch |err| return .{
                .err = .{
                    .message = switch (err) {
                        error.OutOfMemory => return error.OutOfMemory,
                        // Search paths only resolve to existing files, so a missing file was named by
                        // flag.
                        error.FileNotFound => try std.fmt.allocPrint(a, "Config file not found: {s}", .{t}),
                        // TypeScript reports Node's `fs` message here, whose wording varies by Node
                        // version; the port reports the Zig error name, such as `IsDir`.
                        else => @errorName(err),
                    },
                },
            };
            var message: []const u8 = undefined;
            const value = json.parse(a, raw, &message) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                error.SyntaxError => return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Invalid JSON config file: {s}\n\nDetails: {s}", .{ t, message }) } },
            };
            if (value != .object) return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Invalid config file: expected a top-level object in {s}", .{t}) } };
            break :parsed value;
        };
        var node = parsed;
        if (!std.mem.eql(u8, path, run.cli.name)) {
            var segments = std.mem.splitScalar(u8, path, ' ');
            while (segments.next()) |segment| {
                const children = node.get("commands") orelse return .{ .ok = null };
                node = children.get(segment) orelse return .{ .ok = null };
            }
        }
        if (node != .object) return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Invalid config section for '{s}': expected an object", .{path}) } };
        const options = node.get("options") orelse return .{ .ok = null };
        if (options != .object) return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Invalid config 'options' for '{s}': expected an object", .{path}) } };
        return .{ .ok = if (options.object.len == 0) null else options.object };
    }

    /// Parses input, runs middleware and the handler, and writes the result.
    fn execute(run: *Run, cmd: *const Command, group_middleware: []const Middleware, path: []const u8, filtered: []const []const u8, rest: []const []const u8, output: *const Output) ServeError!void {
        const a = run.a;
        const cli = run.cli;
        const depth = filtered.len - rest.len;
        var globals: Value = .{ .object = &.{} };
        const all = if (cli.options.globals) |g| switch (try parser.parseGlobals(a, output.flags.rest, g, .{ .command = .{ .known = cmd.options() }, .validate = true })) {
            .ok => |parsed| all: {
                globals = parsed.values;
                break :all parsed.rest;
            },
            .err => |e| return run.earlyError(e, output.human, output.flags.format),
        } else output.flags.rest;
        const argv = all[@min(depth, all.len)..];
        if (output.human) try run.deprecations(argv, cmd.options());
        const defaults = switch (try run.configDefaults(path, output.flags)) {
            .ok => |d| d,
            .err => |e| return run.writeFailure(output, e, path),
        };
        var sink: CliSink = .{ .run = run, .path = path, .output = output };
        const exec: Exec = .{
            .a = a,
            .process = &run.process,
            .cli = cli,
            .display_name = run.display_name,
            .agent = !output.human,
            .format = output.format,
            .format_explicit = output.flags.format_explicit,
            .globals = globals,
            .sink = sink.sink(),
        };
        const result = try exec.run(cmd, group_middleware, path, .{ .argv = .{ .tokens = argv, .defaults = defaults } });
        switch (result) {
            .streamed => {},
            .ok => |r| try run.writeOutput(output, true, r.data, path, try FormattedCtaBlock.init(a, run.display_name, r.cta)),
            .err => |e| if (output.human and !output.flags.format_explicit and e.field_errors != null)
                try run.validationHelp(cmd, path, e)
            else
                try run.writeFailure(output, e, path),
        }
    }

    /// Forwards a fetch-backed invocation as an HTTP request, through CLI and group middleware,
    /// and writes the response.
    fn executeGateway(run: *Run, g: *const Gateway, group_middleware: []const Middleware, path: []const u8, filtered: []const []const u8, rest: []const []const u8, output: *const Output) ServeError!void {
        const a = run.a;
        const cli = run.cli;
        const depth = filtered.len - rest.len;
        var globals: Value = .{ .object = &.{} };
        const all = if (cli.options.globals) |schema_| switch (try parser.parseGlobals(a, output.flags.rest, schema_, .{ .command = .{ .known = null }, .validate = true })) {
            .ok => |parsed| all: {
                globals = parsed.values;
                break :all parsed.rest;
            },
            .err => |e| return run.earlyError(e, output.human, output.flags.format),
        } else output.flags.rest;
        var step: GatewayStep = .{ .run = run, .gateway = g, .argv = all[@min(depth, all.len)..], .path = path, .output = output };
        const env = if (cli.options.env) |env| try parser.parseEnv(a, env, run.process.env) else parser.Result(Value){ .ok = .{ .object = &.{} } };
        const cli_env = switch (env) {
            .ok => |v| v,
            .err => |e| return run.writeFailure(output, e, path),
        };
        var chain: std.ArrayList(Middleware) = .empty;
        try chain.appendSlice(a, cli.middleware.items);
        try chain.appendSlice(a, group_middleware);
        var vars: command.Vars = .{};
        for (cli.options.vars) |v| try vars.put(a, v.key, v.value);
        var failure: command.Failure = .{};
        var context: command.MiddlewareContext = .{
            .allocator = a,
            .io = run.process.io,
            .agent = !output.human,
            .command = path,
            .display_name = run.display_name,
            .env = cli_env,
            .format = output.format,
            .format_explicit = output.flags.format_explicit,
            .globals = globals,
            .name = cli.name,
            .vars = &vars,
            .version = cli.options.version,
            .failure = &failure,
        };
        var runner: command.Chain = .{ .middleware = chain.items, .context = &step, .last = GatewayStep.last };
        try runner.run(0, &context);
        if (runner.err) |e| try run.writeFailure(output, e, path);
    }

    /// Writes human validation errors followed by command help.
    fn validationHelp(run: *Run, cmd: *const Command, path: []const u8, e: Error) Allocator.Error!void {
        const a = run.a;
        const cli = run.cli;
        var lines: std.ArrayList([]const u8) = .empty;
        for (e.field_errors.?) |f| {
            const dot = std.mem.findScalar(u8, f.path, '.');
            const head = f.path[0 .. dot orelse f.path.len];
            const suffix = if (dot) |d| f.path[d..] else "";
            const is_option = if (cmd.options()) |o| o.field(head) != null else false;
            const is_env = !is_option and if (cmd.env()) |env| env.field(head) != null else false;
            const kind = if (is_option) "option" else if (is_env) "environment variable" else "argument";
            const label = if (is_option)
                try std.fmt.allocPrint(a, "--{s}{s}", .{ try js.toKebab(a, head), suffix })
            else if (is_env) try std.fmt.allocPrint(a, "{s}{s}", .{ head, suffix }) else try std.fmt.allocPrint(a, "<{s}>", .{f.path});
            try lines.append(a, if (f.missing)
                try std.fmt.allocPrint(a, "Error: missing required {s} {s}", .{ kind, label })
            else if (is_env)
                try std.fmt.allocPrint(a, "Error: invalid value for environment variable {s}: {s}", .{ label, f.message })
            else
                try std.fmt.allocPrint(a, "Error: invalid value for {s}: {s}", .{ label, f.message }));
        }
        try lines.appendSlice(a, &.{ "See below for usage.", "" });
        const name = if (std.mem.eql(u8, path, cli.name)) cli.name else try std.fmt.allocPrint(a, "{s} {s}", .{ cli.name, path });
        try lines.append(a, try help.formatCommand(a, name, .{
            .args = cmd.args(),
            .config_flag = run.configFlag(),
            .description = cmd.description,
            .env = cmd.env(),
            .env_source = run.process.env,
            .examples = cmd.examples,
            .hint = cmd.hint,
            .options = cmd.options(),
            .usage = cmd.usage,
        }));
        run.writeln(try std.mem.join(a, "\n", lines.items));
        run.exit = 1;
    }

    /// Writes a streamed result.
    fn stream(run: *Run, s: command.Stream, block: ?errors.CtaBlock, path: []const u8, output: *const Output) ServeError!void {
        const a = run.a;
        const jsonl = output.format == .jsonl;
        const incremental = jsonl or (!output.flags.format_explicit and output.format == .toon);
        var buffered: std.ArrayList(Value) = .empty;
        var failure: command.Failure = .{};
        while (true) {
            const next = s.next(s.context, run.process.io, a) catch |err| Chunk{ .failure = try failure.take(err) };
            const chunk = next orelse break;
            switch (chunk) {
                .failure => |e| return run.streamFailure(e, jsonl, incremental, path, output),
                .data => |raw| {
                    const value = try json.normalize(a, raw);
                    if (jsonl) {
                        var record: json.ObjectBuilder = .{};
                        try record.put(a, "type", .{ .string = "chunk" });
                        try record.put(a, "data", value);
                        run.writeln(try json.stringify(a, record.finish()));
                    } else if (incremental) {
                        if (output.render) run.writeln((try run.truncate(output.flags, try formatter.format(a, value, output.format)))[0]);
                    } else {
                        try buffered.append(a, value);
                        continue;
                    }
                    // Incremental chunks reach the reader while the stream waits for the next one.
                    run.process.stdout.flush() catch {};
                },
            }
        }
        const cta = try FormattedCtaBlock.init(a, run.display_name, block);
        if (jsonl) {
            var meta: json.ObjectBuilder = .{};
            try meta.put(a, "command", .{ .string = path });
            try meta.put(a, "duration", .{ .string = try run.duration() });
            if (cta) |c| try meta.put(a, "cta", try c.toValue(a));
            var record: json.ObjectBuilder = .{};
            try record.put(a, "type", .{ .string = "done" });
            try record.put(a, "ok", .{ .bool = true });
            try record.put(a, "meta", meta.finish());
            run.writeln(try json.stringify(a, record.finish()));
        } else if (incremental) {
            if (cta) |c| run.writeln(try c.human(a));
        } else {
            try run.writeOutput(output, true, .{ .array = buffered.items }, path, cta);
        }
    }

    /// Writes a stream failure and sets the exit code.
    fn streamFailure(run: *Run, e: Error, jsonl: bool, incremental: bool, path: []const u8, output: *const Output) Allocator.Error!void {
        const a = run.a;
        const cta = try FormattedCtaBlock.init(a, run.display_name, e.cta);
        if (jsonl) {
            var record: json.ObjectBuilder = .{};
            try record.put(a, "type", .{ .string = "error" });
            try record.put(a, "ok", .{ .bool = false });
            try record.put(a, "error", try e.toValue(a));
            if (cta) |c| {
                var meta: json.ObjectBuilder = .{};
                try meta.put(a, "cta", try c.toValue(a));
                try record.put(a, "meta", meta.finish());
            }
            run.writeln(try json.stringify(a, record.finish()));
        } else if (incremental) {
            run.writeln(try errors.humanError(a, e));
            if (cta) |c| run.writeln(try c.human(a));
        } else {
            try run.writeOutput(output, false, try e.toValue(a), path, cta);
        }
        run.exit = e.exit_code orelse 1;
    }
};

/// A streamed chunk.
const Chunk = command.Chunk;

/// Writes a stream as CLI output.
const CliSink = struct {
    run: *Run,
    path: []const u8,
    output: *const Output,

    fn sink(s: *CliSink) Sink {
        return .{ .context = s, .consume = consume };
    }

    fn consume(context: *anyopaque, stream: command.Stream, cta: ?errors.CtaBlock) ServeError!ExecResult {
        const s: *CliSink = @ptrCast(@alignCast(context));
        try s.run.stream(stream, cta, s.path, s.output);
        return .streamed;
    }
};

/// The final step of a fetch-backed invocation: send the request and write the response.
const GatewayStep = struct {
    run: *Run,
    gateway: *const Gateway,
    argv: []const []const u8,
    path: []const u8,
    output: *const Output,

    fn last(context: *anyopaque, c: *command.MiddlewareContext) ServeError!void {
        const step: *GatewayStep = @ptrCast(@alignCast(context));
        const run = step.run;
        const a = run.a;
        const output = step.output;
        var input = switch (try fetch_api.parseArgv(a, step.argv)) {
            .ok => |i| i,
            .err => |message| return run.writeFailure(output, .{ .message = message }, step.path),
        };
        if (step.gateway.base_path) |prefix| input.path = try std.mem.concat(a, u8, &.{ prefix, input.path });
        const request = try fetch_api.buildRequest(a, &input);
        const response = step.gateway.fetch.send(a, &run.process, &request) catch |err|
            return run.writeFailure(output, try c.failure.take(err), step.path);
        if (fetch_api.isStreaming(&response)) {
            var lines = fetch_api.Lines.init(response.body);
            return run.stream(.{ .context = &lines, .next = struct {
                fn next(ctx: *anyopaque, io: std.Io, al: Allocator) anyerror!?Chunk {
                    const l: *fetch_api.Lines = @ptrCast(@alignCast(ctx));
                    return l.next(io, al);
                }
            }.next }, null, step.path, output);
        }
        const data = try fetch_api.parseBody(a, response.body);
        if (response.ok()) return run.writeOutput(output, true, data, step.path, null);
        try run.writeOutput(output, false, try fetch_api.parseError(a, data, response.status), step.path, null);
        run.exit = 1;
    }
};

/// How a command receives its arguments and options.
pub const Input = union(enum) {
    /// Command-line tokens, with option defaults from a config file.
    argv: struct { tokens: []const []const u8, defaults: ?[]const Value.Entry = null },
    /// Positional arguments from path tokens and options as a JSON object, as over HTTP.
    split: struct { tokens: []const []const u8, options: Value },
    /// Arguments and options in one JSON object, as MCP tool arguments.
    flat: Value,
};

/// The result of running a command, before a front end renders it.
pub const ExecResult = union(enum) {
    /// Data and suggested commands.
    ok: struct { data: ?Value, cta: ?errors.CtaBlock = null },
    /// A failure, with its suggested commands in `Error.cta`.
    err: Error,
    /// The sink consumed a stream.
    streamed,
};

/// Consumes a command's stream inside the middleware chain, so middleware code after
/// `next.run` runs once the stream ends.
pub const Sink = struct {
    /// The sink's state.
    context: *anyopaque,
    /// Consumes the stream and returns the result.
    consume: *const fn (context: *anyopaque, stream: command.Stream, cta: ?errors.CtaBlock) ServeError!ExecResult,
};

/// Runs a command for any front end: the CLI, MCP, or HTTP.
pub const Exec = struct {
    /// Allocator for the invocation.
    a: Allocator,
    /// The process.
    process: *const Process,
    /// The CLI whose environment schema, variables, and middleware apply.
    cli: *const Cli,
    /// The display name.
    display_name: []const u8,
    /// Whether the consumer is an agent.
    agent: bool,
    /// The output format.
    format: Format,
    /// Whether the format was explicit.
    format_explicit: bool,
    /// Parsed global options.
    globals: Value,
    /// The HTTP request, for commands served over HTTP.
    request: ?*const http.Request = null,
    /// Consumes streams.
    sink: Sink,

    /// Parses input, runs CLI, group, and command middleware around the handler, and returns
    /// its result.
    pub fn run(e: *const Exec, cmd: *const Command, group_middleware: []const Middleware, path: []const u8, input: Input) ServeError!ExecResult {
        const a = e.a;
        const cli = e.cli;
        var chain: std.ArrayList(Middleware) = .empty;
        try chain.appendSlice(a, cli.middleware.items);
        try chain.appendSlice(a, group_middleware);
        try chain.appendSlice(a, cmd.middleware);
        var vars: command.Vars = .{};
        for (cli.options.vars) |v| try vars.put(a, v.key, v.value);
        var failure: command.Failure = .{};
        var context: command.MiddlewareContext = .{
            .allocator = a,
            .io = e.process.io,
            .agent = e.agent,
            .command = path,
            .display_name = e.display_name,
            .env = .null,
            .format = e.format,
            .format_explicit = e.format_explicit,
            .globals = e.globals,
            .name = cli.name,
            .vars = &vars,
            .version = cli.options.version,
            .request = e.request,
            .failure = &failure,
        };
        const cli_env = if (cli.options.env) |env| try parser.parseEnv(a, env, e.process.env) else parser.Result(Value){ .ok = .{ .object = &.{} } };
        context.env = switch (cli_env) {
            .err => |err| return .{ .err = err },
            .ok => |env| env,
        };
        var step: Step = .{ .exec = e, .cmd = cmd, .input = input };
        var runner: command.Chain = .{ .middleware = chain.items, .context = &step, .last = Step.last };
        try runner.run(0, &context);
        if (runner.err) |err| return .{ .err = err };
        return step.result orelse .{ .ok = .{ .data = null } };
    }
};

/// The final step of the middleware chain: parse input and call the handler.
const Step = struct {
    exec: *const Exec,
    cmd: *const Command,
    input: Input,
    result: ?ExecResult = null,

    fn last(context: *anyopaque, c: *command.MiddlewareContext) ServeError!void {
        const step: *Step = @ptrCast(@alignCast(context));
        const e = step.exec;
        const a = e.a;
        const cmd = step.cmd;
        const parsed: parser.Parsed = switch (step.input) {
            .argv => |argv| switch (try parser.parse(a, argv.tokens, cmd.args(), cmd.options(), argv.defaults)) {
                .ok => |p| p,
                .err => |err| return step.fail(err),
            },
            .split => |split| parsed: {
                const args = switch (try parser.parse(a, split.tokens, cmd.args(), null, null)) {
                    .ok => |p| p.args,
                    .err => |err| return step.fail(err),
                };
                const options = if (cmd.options()) |o| switch (try parser.validate(a, o, split.options)) {
                    .ok => |v| v,
                    .err => |err| return step.fail(err),
                } else Value{ .object = &.{} };
                break :parsed .{ .args = args, .options = options };
            },
            .flat => |params| parsed: {
                var args: json.ObjectBuilder = .{};
                var options: json.ObjectBuilder = .{};
                if (params == .object) for (params.object) |entry| {
                    const is_arg = if (cmd.args()) |s| s.field(entry.key) != null else false;
                    try (if (is_arg) &args else &options).put(a, entry.key, entry.value);
                };
                const parsed_args = if (cmd.args()) |s| switch (try parser.validate(a, s, args.finish())) {
                    .ok => |v| v,
                    .err => |err| return step.fail(err),
                } else Value{ .object = &.{} };
                const parsed_options = if (cmd.options()) |s| switch (try parser.validate(a, s, options.finish())) {
                    .ok => |v| v,
                    .err => |err| return step.fail(err),
                } else Value{ .object = &.{} };
                break :parsed .{ .args = parsed_args, .options = parsed_options };
            },
        };
        const env = if (cmd.env()) |schema_env| switch (try parser.parseEnv(a, schema_env, e.process.env)) {
            .ok => |v| v,
            .err => |err| return step.fail(err),
        } else Value{ .object = &.{} };
        const h = cmd.run orelse {
            step.result = .{ .ok = .{ .data = null } };
            return;
        };
        const invocation: command.Invocation = .{
            .context = h.context,
            .allocator = a,
            .io = c.io,
            .agent = c.agent,
            .args = parsed.args,
            .display_name = c.display_name,
            .env = env,
            .format = c.format,
            .format_explicit = c.format_explicit,
            .globals = c.globals,
            .name = c.name,
            .options = parsed.options,
            .vars = c.vars,
            .version = c.version,
            .request = c.request,
            .failure = c.failure,
            .process = e.process,
        };
        const outcome = h.call(&invocation) catch |err| return step.fail(try c.failure.take(err));
        step.result = switch (outcome) {
            .data => |d| .{ .ok = .{ .data = d.value, .cta = d.cta } },
            .stream => |s| try e.sink.consume(e.sink.context, s.stream, s.cta),
        };
    }

    /// Records a failure.
    fn fail(step: *Step, err: Error) void {
        step.result = .{ .err = err };
    }
};

/// Whether `list` contains `item`.
fn contains(list: []const []const u8, item: []const u8) bool {
    for (list) |x| if (std.mem.eql(u8, x, item)) return true;
    return false;
}

/// Whether a candidate with this value exists.
fn listed(candidates: []const completions.Candidate, value: []const u8) bool {
    for (candidates) |c| if (std.mem.eql(u8, c.value, value)) return true;
    return false;
}

/// Returns the index of a built-in in the filtered tokens: first, or after the CLI name. A
/// registered command or alias of the same name shadows the built-in.
fn builtinIndex(cli: *const Cli, filtered: []const []const u8, b: []const u8) ?usize {
    const commands = cli.commands.items;
    if (filtered.len > 0) if (findUnshadowedBuiltin(commands, filtered[0])) |found| if (std.mem.eql(u8, found, b)) return 0;
    if (filtered.len > 1 and std.mem.eql(u8, filtered[0], cli.name)) if (findUnshadowedBuiltin(commands, filtered[1])) |found| if (std.mem.eql(u8, found, b)) return 1;
    return null;
}

/// Builds the suggestions for an unknown command: the corrected command line, then help.
fn notFoundCta(a: Allocator, name: []const u8, argv: []const []const u8, token: []const u8, suggestion: ?[]const u8, help_command: []const u8) Allocator.Error!FormattedCtaBlock {
    var commands: std.ArrayList(FormattedCta) = .empty;
    if (suggestion) |s| {
        const corrected = try a.alloc([]const u8, argv.len);
        for (argv, corrected) |t, *slot| slot.* = if (std.mem.eql(u8, t, token)) s else t;
        try commands.append(a, .{ .command = try std.fmt.allocPrint(a, "{s} {s}", .{ name, try std.mem.join(a, " ", corrected) }) });
    }
    try commands.append(a, .{ .command = help_command, .description = "see all available commands" });
    return .{
        .commands = commands.items,
        .description = if (commands.items.len == 1) "Suggested command:" else "Suggested commands:",
    };
}

/// Appends a block's suggestions to another block, keeping its description.
fn mergeCta(a: Allocator, block: FormattedCtaBlock, extra: FormattedCtaBlock) Allocator.Error!FormattedCtaBlock {
    return .{ .description = block.description, .commands = try std.mem.concat(a, FormattedCta, &.{ block.commands, extra.commands }) };
}

/// Joins paths as Rust's `Path::join` does: an absolute or empty base yields `b` unchanged.
fn join(a: Allocator, base: []const u8, b: []const u8) Allocator.Error![]const u8 {
    if (std.fs.path.isAbsolute(b) or base.len == 0) return b;
    if (std.mem.endsWith(u8, base, "/")) return std.mem.concat(a, u8, &.{ base, b });
    return std.mem.concat(a, u8, &.{ base, "/", b });
}

/// Whether a path names something that opens, as a file or a directory.
fn exists(io: std.Io, path: []const u8) bool {
    const file = std.Io.Dir.cwd().openFile(io, path, .{}) catch |err| return err == error.IsDir;
    file.close(io);
    return true;
}

/// Builds the completion tree of a command group.
fn tree(a: Allocator, commands: Commands, root: ?*const Command, description: ?[]const u8) Allocator.Error!completions.Node {
    const children = try a.alloc(completions.Node.Child, commands.len);
    for (commands, children) |n, *slot| slot.* = .{
        .name = n.name,
        .alias = n.entry == .alias,
        .node = switch (n.entry) {
            .alias, .command => |c| .{ .description = c.description, .options = c.options() },
            .gateway => |g| .{ .description = g.description },
            .group => |g| try tree(a, g.commands.items, if (g.options.root) |*r| r else null, g.options.description),
        },
    };
    return .{ .commands = children, .description = description, .options = if (root) |r| r.options() else null };
}
