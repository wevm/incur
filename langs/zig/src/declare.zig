//! CLIs declared as types: a struct is a command, a `union(enum)` a group of commands.
//!
//! ```zig
//! const MyCli = union(enum) {
//!     status,
//!     install: struct {
//!         package: ?[]const u8 = null,
//!         save_dev: bool = false,
//!
//!         pub const incur = .{ .fields = .{
//!             .package = .{ .arg = true, .description = "Package name" },
//!             .save_dev = .{ .alias = 'D', .description = "Save as dev dependency" },
//!         } };
//!     },
//!
//!     pub const incur = .{ .name = "my-cli", .fields = .{
//!         .status = .{ .description = "Show repo status" },
//!         .install = .{ .description = "Install a package" },
//!     } };
//! };
//!
//! pub fn main(init: std.process.Init) !void {
//!     switch (try incur.parse(MyCli, init)) {
//!         .status => ...,
//!         .install => |install| ...,
//!     }
//! }
//! ```
//!
//! A struct's fields are its options, or with `.arg = true` positional arguments and with
//! `.env = true` environment variables; see `derive.zig` for field types and options. A union's
//! members are its commands, named after the member in kebab-case: `void` for a command without
//! input, a struct for a command, or another union for a nested group.
//!
//! The `incur` declaration of the type passed to `cli` takes `name` (required), `version`,
//! `aliases` (binary names), and `description`. A struct also takes the command options
//! `hint`, `destructive`, `output` (a type), `middleware`, `examples`, and `usage`, and a union
//! takes `middleware` (group middleware). A union's `fields` describe its members: `name`,
//! `description`, and for command members `aliases` and the command options above. Command
//! options on a group are compile errors.
//!
//! Inside a declared type, `incur` names its own declaration, so refer to library types through
//! aliases declared outside it, such as `const Value = incur.Value;`.

const std = @import("std");
const cli_ = @import("cli.zig");
const command = @import("command.zig");
const derive = @import("derive.zig");
const help = @import("help.zig");

const Allocator = std.mem.Allocator;
const Cli = cli_.Cli;
const Command = command.Command;
const Context = command.Context;
const Handler = command.Handler;
const Invocation = command.Invocation;
const Middleware = command.Middleware;
const Outcome = command.Outcome;
const Process = cli_.Process;
const ServeError = command.ServeError;

/// The handler that `Cli.handle` and `serve` run with a parsed command. The context declares no
/// input: everything the command takes is in the command value.
pub fn Run(comptime T: type) type {
    return fn (c: *Context(.{}), command: T) anyerror!Outcome;
}

/// The result of `parseWith`: the parsed command, or the exit code of an invocation that did not
/// produce one, whose output has been written.
pub fn Parsed(comptime T: type) type {
    return union(enum) {
        /// The parsed command. Its strings and slices are allocated with the allocator passed
        /// to `parseWith`.
        command: T,
        /// The exit code when a built-in such as `--help` ran, the input was invalid, or
        /// middleware failed: 0 for success, 1 for errors.
        exit: u8,
    };
}

/// The CLI-level metadata keys of a union.
const group_keys = [_][]const u8{ "name", "version", "aliases", "description", "middleware", "fields" };

/// The metadata keys that describe a command, which a group does not take.
const command_only = [_][]const u8{ "aliases", "destructive", "examples", "hint", "middleware", "output", "usage" };

/// The metadata keys of a union member.
const member_keys = [_][]const u8{ "name", "description" } ++ command_only;

/// Returns the `incur` declaration of a type, or an empty literal.
fn declaration(comptime T: type) Declaration(T) {
    return if (T != void and @hasDecl(T, "incur")) T.incur else .{};
}

/// The type of the `incur` declaration of a type.
fn Declaration(comptime T: type) type {
    return if (T != void and @hasDecl(T, "incur")) @TypeOf(T.incur) else @TypeOf(.{});
}

/// Returns `@field(meta, key)` as `R`, or `default` when absent.
fn get(comptime meta: anytype, comptime key: []const u8, comptime R: type, comptime default: R) R {
    return if (@hasField(@TypeOf(meta), key)) @field(meta, key) else default;
}

/// Converts a list literal, such as `&.{ .{ .command = "a" } }`, to a slice of `E` structs.
fn listOf(comptime E: type, comptime meta: anytype, comptime key: []const u8) []const E {
    if (!@hasField(@TypeOf(meta), key)) return &.{};
    const out = comptime out: {
        var out: []const E = &.{};
        for (@field(meta, key)) |item| {
            var element: E = .{};
            for (@typeInfo(@TypeOf(item)).@"struct".field_names) |name| @field(element, name) = @field(item, name);
            out = out ++ .{element};
        }
        break :out out[0..out.len].*;
    };
    return &out;
}

/// Whether `T` declares a command group.
fn isGroup(comptime T: type) bool {
    return @typeInfo(T) == .@"union";
}

/// Checks the metadata of a union and its members.
fn checkGroup(comptime T: type) void {
    comptime {
        const info = @typeInfo(T).@"union";
        if (info.tag_type == null) @compileError("incur command group " ++ @typeName(T) ++ " must be a union(enum)");
        const meta = declaration(T);
        for (@typeInfo(@TypeOf(meta)).@"struct".field_names) |key| {
            if (derive.contains(&command_only, key) and !derive.contains(&group_keys, key))
                @compileError("incur option '" ++ key ++ "' describes a command, but " ++ @typeName(T) ++ " is a command group");
            if (!derive.contains(&group_keys, key))
                @compileError("unknown incur option '" ++ key ++ "' on " ++ @typeName(T) ++ "; expected name, version, aliases, description, middleware, or fields");
        }
        const fields = members(T);
        for (@typeInfo(@TypeOf(fields)).@"struct".field_names) |name| {
            if (!@hasField(T, name)) @compileError("incur metadata names unknown command '" ++ name ++ "' of " ++ @typeName(T));
            const M = @FieldType(T, name);
            for (@typeInfo(@TypeOf(@field(fields, name))).@"struct".field_names) |key| {
                if (!derive.contains(&member_keys, key))
                    @compileError("unknown incur command option '" ++ key ++ "' on " ++ @typeName(T) ++ "." ++ name ++ "; expected name, description, aliases, destructive, examples, hint, middleware, output, or usage");
                if (isGroup(M) and derive.contains(&command_only, key))
                    @compileError("incur option '" ++ key ++ "' on " ++ @typeName(T) ++ "." ++ name ++ " describes a command, but " ++ @typeName(M) ++ " is a command group");
            }
        }
        for (info.field_names, info.field_types) |name, M| switch (@typeInfo(M)) {
            .void, .@"struct", .@"union" => {},
            else => @compileError("incur command " ++ @typeName(T) ++ "." ++ name ++ " must be void, a struct, or a union(enum)"),
        };
    }
}

/// Returns the member metadata of a union, or an empty literal.
fn members(comptime T: type) Members(T) {
    return if (@hasField(Declaration(T), "fields")) declaration(T).fields else .{};
}

/// The type of the member metadata of a union.
fn Members(comptime T: type) type {
    return if (@hasField(Declaration(T), "fields")) @TypeOf(declaration(T).fields) else @TypeOf(.{});
}

/// Returns the metadata of a union member, or an empty literal.
fn memberMeta(comptime T: type, comptime name: []const u8) MemberMeta(T, name) {
    return if (@hasField(Members(T), name)) @field(members(T), name) else .{};
}

/// The type of the metadata of a union member.
fn MemberMeta(comptime T: type, comptime name: []const u8) type {
    return if (@hasField(Members(T), name)) @FieldType(Members(T), name) else @TypeOf(.{});
}

/// Creates a CLI named and described by the `incur` declaration of `T`: its `name`,
/// `description`, `version`, and `aliases` fill the options `options` leaves unset, and a union's
/// `middleware` becomes CLI middleware. Add the commands with `Cli.handle`, `Cli.parse`, or
/// `Cli.parseWith`. Destroy the CLI with `destroy`.
pub fn cli(comptime T: type, gpa: Allocator, options: cli_.Options) cli_.CreateError!*Cli {
    const meta = declaration(T);
    switch (@typeInfo(T)) {
        .@"struct" => {},
        .@"union" => checkGroup(T),
        else => @compileError("incur cannot declare a CLI from " ++ @typeName(T) ++ "; use a struct or a union(enum)"),
    }
    if (!@hasField(@TypeOf(meta), "name")) @compileError("incur.cli needs a name: add .name to " ++ @typeName(T) ++ ".incur");
    var o = options;
    o.description = o.description orelse get(meta, "description", ?[]const u8, null);
    o.version = o.version orelse get(meta, "version", ?[]const u8, null);
    if (o.aliases.len == 0) o.aliases = get(meta, "aliases", []const []const u8, &.{});
    const c = try Cli.create(gpa, meta.name, o);
    errdefer c.destroy();
    if (isGroup(T)) for (get(meta, "middleware", []const Middleware, &.{})) |m| try c.use(m);
    return c;
}

/// Adds the commands of `T` to `c`: a struct as the root command, a union's members as
/// commands and groups. Commands call `run` with the command value, or with no `run` store it in
/// the `Capture(T)` that `context` points to.
pub fn attach(c: *Cli, comptime T: type, comptime run: ?*const Run(T), context: ?*const anyopaque) Allocator.Error!void {
    return attachTo(c, T, T, struct {
        fn wrap(value: T) T {
            return value;
        }
    }.wrap, run, context);
}

/// Adds the commands of `T`, whose values `wrap` turns into `Root` values.
fn attachTo(c: *Cli, comptime Root: type, comptime T: type, comptime wrap: fn (T) Root, comptime run: ?*const Run(Root), context: ?*const anyopaque) Allocator.Error!void {
    if (comptime !isGroup(T)) {
        // The root command takes its description from the CLI, and aliases name the CLI.
        var root = commandOf(Root, T, .{}, wrap, run, context);
        root.aliases = &.{};
        root.description = null;
        c.options.root = root;
    } else inline for (@typeInfo(T).@"union".field_names, @typeInfo(T).@"union".field_types) |member, M| {
        const meta = memberMeta(T, member);
        const name = get(meta, "name", []const u8, derive.kebabCase(member));
        const inner = struct {
            fn inner(value: M) Root {
                return wrap(@unionInit(T, member, value));
            }
        }.inner;
        if (comptime isGroup(M)) {
            checkGroup(M);
            const own = declaration(M);
            const description = get(meta, "description", ?[]const u8, get(own, "description", ?[]const u8, null));
            // Options without global options cannot conflict with built-in flags.
            const child = c.mount(name, .{ .description = description }) catch |err| return @errorCast(err);
            for (get(own, "middleware", []const Middleware, &.{})) |m| try child.use(m);
            try attachTo(child, Root, M, inner, run, context);
        } else try c.command(name, commandOf(Root, M, meta, inner, run, context));
    }
}

/// Returns the command of a struct or `void` member: member metadata first, then the struct's
/// own `incur` declaration.
fn commandOf(comptime Root: type, comptime T: type, comptime meta: anytype, comptime wrap: fn (T) Root, comptime run: ?*const Run(Root), context: ?*const anyopaque) Command {
    const own = declaration(T);
    const output = if (@hasField(@TypeOf(meta), "output")) meta.output else if (@hasField(@TypeOf(own), "output")) own.output else null;
    return .{
        .aliases = get(meta, "aliases", []const []const u8, get(own, "aliases", []const []const u8, &.{})),
        .description = get(meta, "description", ?[]const u8, get(own, "description", ?[]const u8, null)),
        .destructive = get(meta, "destructive", bool, false) or get(own, "destructive", bool, false),
        .examples = comptime listOf(help.Example, own, "examples") ++ listOf(help.Example, meta, "examples"),
        .hint = get(meta, "hint", ?[]const u8, get(own, "hint", ?[]const u8, null)),
        .middleware = comptime get(own, "middleware", []const Middleware, &.{}) ++ get(meta, "middleware", []const Middleware, &.{}),
        .output = if (@TypeOf(output) == @TypeOf(null)) null else derive.of(output),
        .usage = comptime listOf(help.Usage, own, "usage") ++ listOf(help.Usage, meta, "usage"),
        .run = leaf(Root, T, wrap, run, context),
    };
}

/// Where `parseWith` stores the parsed command.
pub fn Capture(comptime T: type) type {
    return struct {
        /// Allocates the command's strings and slices.
        allocator: Allocator,
        /// The parsed command.
        value: ?T = null,
        /// Whether `value` is set.
        parsed: bool = false,
    };
}

/// Returns the handler of a command whose input decodes into `T`.
fn leaf(comptime Root: type, comptime T: type, comptime wrap: fn (T) Root, comptime run: ?*const Run(Root), context: ?*const anyopaque) Handler {
    return .{
        .context = context,
        .args = derive.inputOf(T, .args),
        .options = derive.inputOf(T, .options),
        .env = derive.inputOf(T, .env),
        .call = struct {
            fn call(i: *const Invocation) anyerror!Outcome {
                if (run) |f| {
                    var c = command.contextOf(Context(.{}), i, {}, {}, {});
                    return f(&c, wrap(try derive.decodeCommand(T, i.allocator, i.args, i.options, i.env)));
                }
                // The command outlives the invocation, so it is copied to the caller's allocator.
                const capture: *Capture(Root) = @ptrCast(@alignCast(@constCast(i.context.?)));
                const a = capture.allocator;
                capture.value = wrap(try derive.decodeCommand(T, a, try i.args.clone(a), try i.options.clone(a), try i.env.clone(a)));
                capture.parsed = true;
                return .none;
            }
        }.call,
    };
}

/// Standard output that holds writes back once a command is parsed: output after the command
/// belongs to the caller, unless the middleware chain fails.
const Gate = struct {
    /// The underlying output.
    out: *std.Io.Writer,
    /// Output written after the command was parsed.
    held: std.Io.Writer.Allocating,
    /// Whether a command was parsed.
    closed: *const bool,
    /// The writer, unbuffered so that every write lands on the right side of the gate.
    interface: std.Io.Writer = .{ .vtable = &.{ .drain = drain, .flush = flush }, .buffer = &.{} },

    fn drain(w: *std.Io.Writer, data: []const []const u8, splat: usize) std.Io.Writer.Error!usize {
        const gate: *Gate = @alignCast(@fieldParentPtr("interface", w));
        const sink = if (gate.closed.*) &gate.held.writer else gate.out;
        for (data[0 .. data.len - 1]) |bytes| try sink.writeAll(bytes);
        for (0..splat) |_| try sink.writeAll(data[data.len - 1]);
        var n = data[data.len - 1].len * splat;
        for (data[0 .. data.len - 1]) |bytes| n += bytes.len;
        return n;
    }

    fn flush(w: *std.Io.Writer) std.Io.Writer.Error!void {
        const gate: *Gate = @alignCast(@fieldParentPtr("interface", w));
        return gate.out.flush();
    }
};

/// Adds the commands of `T` to `c` and serves `argv`, returning the parsed command instead of
/// running it. See `Cli.parseWith`.
pub fn parseCli(c: *Cli, comptime T: type, a: Allocator, argv: []const []const u8, process: Process) ServeError!Parsed(T) {
    var capture: Capture(T) = .{ .allocator = a };
    c.parse_only = true;
    try attach(c, T, null, &capture);
    var gate: Gate = .{ .out = process.stdout, .held = .init(c.gpa), .closed = &capture.parsed };
    defer gate.held.deinit();
    var gated = process;
    gated.stdout = &gate.interface;
    const code = try c.serveWith(argv, gated);
    if (capture.value) |value| if (code == 0) return .{ .command = value };
    process.stdout.writeAll(gate.held.written()) catch {};
    process.stdout.flush() catch {};
    return .{ .exit = code };
}

/// Declares the CLI `T` and parses the process arguments into a `T`, exiting when a built-in
/// ran or the input was invalid. The command is allocated in `init.arena`. See `Cli.parse`.
pub fn parse(comptime T: type, init: std.process.Init) !T {
    const c = try cli(T, init.gpa, .{});
    defer c.destroy();
    return c.parse(T, init);
}

/// Declares the CLI `T` and parses `argv` with explicit I/O. Everything, including the returned
/// command, is allocated with `a`, which should be an arena. See `Cli.parseWith`.
pub fn parseWith(comptime T: type, a: Allocator, argv: []const []const u8, process: Process) ServeError!Parsed(T) {
    // A CLI without global options cannot conflict with built-in flags.
    const c = cli(T, a, .{}) catch |err| return @errorCast(err);
    defer c.destroy();
    return c.parseWith(T, a, argv, process);
}

/// Declares the CLI `T` and serves the process arguments, running `run` with the parsed command
/// and writing what it returns, then exits with the command's exit code. Serves `--mcp` too.
pub fn serve(comptime T: type, init: std.process.Init, comptime run: *const Run(T)) !void {
    const c = try cli(T, init.gpa, .{});
    defer c.destroy();
    try c.handle(T, run);
    return c.serve(init);
}
