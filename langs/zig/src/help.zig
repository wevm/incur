//! Help text for command groups and commands.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");

const Allocator = std.mem.Allocator;
const Type = schema.Type;
const Lines = std.ArrayList([]const u8);

/// A command listed in help output.
pub const Entry = struct {
    /// What the command does.
    description: ?[]const u8 = null,
    /// The command name.
    name: []const u8,
};

/// An alternative usage line.
pub const Usage = struct {
    /// Arguments shown as `<name>`.
    args: []const []const u8 = &.{},
    /// Options shown as `--name <name>`.
    options: []const []const u8 = &.{},
    /// Text before the command, such as `cat file.txt |`.
    prefix: ?[]const u8 = null,
    /// Text after the command, such as `| head`.
    suffix: ?[]const u8 = null,
};

/// A usage example: the arguments after the command name and a description.
pub const Example = struct {
    /// The arguments and options after the command name.
    command: []const u8 = "",
    /// What the example shows.
    description: ?[]const u8 = null,
};

/// Options for `formatRoot` and `formatCommand`.
pub const Options = struct {
    /// Alternative binary names.
    aliases: []const []const u8 = &.{},
    /// Positional arguments schema.
    args: ?*const Type = null,
    /// Subcommands to list.
    commands: ?[]const Entry = null,
    /// Config file flag name, such as `config`.
    config_flag: ?[]const u8 = null,
    /// Description.
    description: ?[]const u8 = null,
    /// Environment variables schema.
    env: ?*const Type = null,
    /// Environment for showing which variables are set.
    env_source: ?*const std.process.Environ.Map = null,
    /// Usage examples.
    examples: []const Example = &.{},
    /// Global options schema.
    globals: ?*const Type = null,
    /// Hide the global options section.
    hide_global_options: bool = false,
    /// Hide the skills integration.
    hide_skills: bool = false,
    /// Text shown after examples.
    hint: ?[]const u8 = null,
    /// Options schema.
    options: ?*const Type = null,
    /// Whether to show root-only integrations and flags.
    root: bool = false,
    /// Alternative usage lines.
    usage: []const Usage = &.{},
    /// Version shown in the title.
    version: ?[]const u8 = null,
};

/// Returns the text unless it is null or empty.
fn nonEmpty(text: ?[]const u8) ?[]const u8 {
    const t = text orelse return null;
    return if (t.len == 0) null else t;
}

/// Formats the title line.
fn title(a: Allocator, name: []const u8, options: Options) Allocator.Error![]const u8 {
    const t = if (options.version) |v| try std.fmt.allocPrint(a, "{s}@{s}", .{ name, v }) else name;
    if (nonEmpty(options.description)) |d| return std.fmt.allocPrint(a, "{s} \u{2014} {s}", .{ t, d });
    return t;
}

/// Lists commands with aligned descriptions.
fn commands(a: Allocator, lines: *Lines, entries: []const Entry) Allocator.Error!void {
    var width: usize = 0;
    for (entries) |e| width = @max(width, js.utf16Len(e.name));
    for (entries) |e| {
        if (nonEmpty(e.description)) |d|
            try lines.append(a, try std.fmt.allocPrint(a, "  {s}  {s}", .{ try js.pad(a, e.name, width), d }))
        else
            try lines.append(a, try std.fmt.allocPrint(a, "  {s}", .{e.name}));
    }
}

/// Returns the entries unless they are null or empty.
fn someEntries(entries: ?[]const Entry) ?[]const Entry {
    const e = entries orelse return null;
    return if (e.len == 0) null else e;
}

/// Formats help for a command group.
pub fn formatRoot(a: Allocator, name: []const u8, options: Options) Allocator.Error![]const u8 {
    var lines: Lines = .empty;
    try lines.appendSlice(a, &.{ try title(a, name, options), "", try std.fmt.allocPrint(a, "Usage: {s} <command>", .{name}) });
    if (options.aliases.len > 0) try lines.append(a, try std.fmt.allocPrint(a, "Aliases: {s}", .{try std.mem.join(a, ", ", options.aliases)}));
    if (someEntries(options.commands)) |entries| {
        try lines.appendSlice(a, &.{ "", "Commands:" });
        try commands(a, &lines, entries);
    }
    try globalLines(a, &lines, options);
    return std.mem.join(a, "\n", lines.items);
}

/// Formats help for a command.
pub fn formatCommand(a: Allocator, name: []const u8, options: Options) Allocator.Error![]const u8 {
    var lines: Lines = .empty;
    try lines.appendSlice(a, &.{ try title(a, name, options), "" });

    if (options.usage.len == 0) {
        var synopsis: Lines = .empty;
        try synopsis.append(a, name);
        if (options.args) |args| for (args.fields()) |*f| {
            const type_name = try f.ty.typeName(a);
            var label = if (std.mem.findScalar(u8, type_name, '|') != null) type_name else f.name;
            if (std.mem.eql(u8, type_name, "array")) label = try std.mem.concat(a, u8, &.{ label, "..." });
            try synopsis.append(a, try std.mem.concat(a, u8, &.{ if (f.ty.isOptional()) "[" else "<", label, if (f.ty.isOptional()) "]" else ">" }));
        };
        try lines.append(a, try std.fmt.allocPrint(a, "Usage: {s}{s}{s}", .{
            try std.mem.join(a, " ", synopsis.items),
            if (options.options != null) " [options]" else "",
            if (someEntries(options.commands) != null) " | <command>" else "",
        }));
    } else for (options.usage, 0..) |usage, index| {
        var parts: Lines = .empty;
        if (nonEmpty(usage.prefix)) |p| try parts.append(a, p);
        try parts.append(a, name);
        for (usage.args) |arg| try parts.append(a, try std.fmt.allocPrint(a, "<{s}>", .{arg}));
        for (usage.options) |o| try parts.append(a, try std.fmt.allocPrint(a, "--{s} <{s}>", .{ o, o }));
        if (nonEmpty(usage.suffix)) |s| try parts.append(a, s);
        try lines.append(a, try std.fmt.allocPrint(a, "{s}{s}", .{ if (index == 0) "Usage: " else "       ", try std.mem.join(a, " ", parts.items) }));
    }
    if (options.aliases.len > 0) try lines.append(a, try std.fmt.allocPrint(a, "Aliases: {s}", .{try std.mem.join(a, ", ", options.aliases)}));

    if (options.args) |args| if (args.fields().len > 0) {
        try lines.appendSlice(a, &.{ "", "Arguments:" });
        const width = nameWidth(args);
        for (args.fields()) |f| try lines.append(a, try std.fmt.allocPrint(a, "  {s}  {s}", .{ try js.pad(a, f.name, width), f.ty.description orelse "" }));
    };

    if (options.options) |opts| if (opts.fields().len > 0) {
        try lines.appendSlice(a, &.{ "", "Options:" });
        try optionLines(a, &lines, opts);
    };

    if (options.examples.len > 0) {
        try lines.appendSlice(a, &.{ "", "Examples:" });
        const full = try a.alloc([]const u8, options.examples.len);
        var width: usize = 0;
        for (options.examples, full) |e, *slot| {
            slot.* = if (e.command.len == 0) name else try std.fmt.allocPrint(a, "{s} {s}", .{ name, e.command });
            width = @max(width, js.utf16Len(slot.*));
        }
        for (options.examples, full) |e, command| {
            if (nonEmpty(e.description)) |d|
                try lines.append(a, try std.fmt.allocPrint(a, "  {s}  # {s}", .{ try js.pad(a, command, width), d }))
            else
                try lines.append(a, try std.fmt.allocPrint(a, "  {s}", .{command}));
        }
    }

    if (nonEmpty(options.hint)) |hint| try lines.appendSlice(a, &.{ "", hint });

    if (someEntries(options.commands)) |entries| {
        try lines.appendSlice(a, &.{ "", "Commands:" });
        try commands(a, &lines, entries);
    }

    if (!options.hide_global_options) try globalLines(a, &lines, options);

    if (options.env) |env| if (env.fields().len > 0) {
        try lines.appendSlice(a, &.{ "", "Environment Variables:" });
        const width = nameWidth(env);
        for (env.fields()) |*f| {
            var parts: Lines = .empty;
            if (options.env_source) |source| if (source.get(f.name)) |value| {
                try parts.append(a, try std.fmt.allocPrint(a, "set: {s}", .{try redact(a, value)}));
            };
            if (try displayDefault(a, &f.ty)) |d| try parts.append(a, try std.fmt.allocPrint(a, "default: {s}", .{d}));
            const description = f.ty.description orelse "";
            const text = if (parts.items.len > 0)
                try std.fmt.allocPrint(a, "{s} ({s})", .{ description, try std.mem.join(a, ", ", parts.items) })
            else
                description;
            try lines.append(a, try std.fmt.allocPrint(a, "  {s}  {s}", .{ try js.pad(a, f.name, width), text }));
        }
    };

    return std.mem.join(a, "\n", lines.items);
}

/// Returns the widest field name in UTF-16 code units.
fn nameWidth(ty: *const Type) usize {
    var width: usize = 0;
    for (ty.fields()) |f| width = @max(width, js.utf16Len(f.name));
    return width;
}

/// Returns the default shown in help, omitting empty arrays.
fn displayDefault(a: Allocator, ty: *const Type) Allocator.Error!?[]const u8 {
    const d = ty.default orelse return null;
    if (d == .array and d.array.len == 0) return null;
    return try json.toString(a, d);
}

/// Lists options with flags, aliases, value hints, and defaults.
fn optionLines(a: Allocator, lines: *Lines, ty: *const Type) Allocator.Error!void {
    const fields = ty.fields();
    const flags = try a.alloc([]const u8, fields.len);
    const descriptions = try a.alloc([]const u8, fields.len);
    var width: usize = 0;
    for (fields, flags, descriptions) |*f, *flag, *description| {
        const type_name = try f.ty.typeName(a);
        const kebab = try js.toKebab(a, f.name);
        const boolean = std.mem.eql(u8, type_name, "boolean");
        const hint = if (boolean) "" else try std.fmt.allocPrint(a, " <{s}>", .{type_name});
        flag.* = if (f.alias) |alias|
            try std.fmt.allocPrint(a, "--{s}, -{c}{s}", .{ kebab, alias, hint })
        else
            try std.fmt.allocPrint(a, "--{s}{s}", .{ kebab, hint });
        const false_default = boolean and f.ty.default != null and f.ty.default.? == .bool and !f.ty.default.?.bool;
        const default = if (false_default) null else try displayDefault(a, &f.ty);
        const prefix = if (f.ty.deprecated) "[deprecated] " else "";
        const text = f.ty.description orelse "";
        description.* = if (default) |d|
            try std.fmt.allocPrint(a, "{s}{s} (default: {s})", .{ prefix, text, d })
        else
            try std.mem.concat(a, u8, &.{ prefix, text });
        width = @max(width, js.utf16Len(flag.*));
    }
    for (flags, descriptions) |flag, description| try lines.append(a, try std.fmt.allocPrint(a, "  {s}  {s}", .{ try js.pad(a, flag, width), description }));
}

/// A flag and its description in the global options section.
const Flag = struct { []const u8, []const u8 };

/// Writes the integrations and global options sections.
fn globalLines(a: Allocator, lines: *Lines, options: Options) Allocator.Error!void {
    if (options.root) {
        const integrations = [_]Flag{
            .{ "completions", "Generate shell completion script" },
            .{ "mcp", "Register as MCP server (add, doctor)" },
            .{ "skills", "Sync skill files to agents (add, list)" },
        };
        const shown = if (options.hide_skills) integrations[0..2] else integrations[0..];
        // `completions` is the longest name either way.
        const width = "completions".len;
        try lines.appendSlice(a, &.{ "", "Integrations:" });
        for (shown) |entry| try lines.append(a, try std.fmt.allocPrint(a, "  {s}  {s}", .{ try js.pad(a, entry[0], width), entry[1] }));
    }

    if (options.globals) |globals| if (globals.fields().len > 0) {
        try lines.appendSlice(a, &.{ "", "Custom Global Options:" });
        try optionLines(a, lines, globals);
    };

    var flags: std.ArrayList(Flag) = .empty;
    if (options.config_flag) |flag| {
        try flags.append(a, .{ try std.fmt.allocPrint(a, "--{s} <path>", .{flag}), "Load JSON option defaults from a file" });
        try flags.append(a, .{ try std.fmt.allocPrint(a, "--no-{s}", .{flag}), "Disable JSON option defaults for this run" });
    }
    try flags.appendSlice(a, &.{
        .{ "--filter-output <keys>", "Filter output by key paths (e.g. foo,bar.baz,a[0,3])" },
        .{ "--format <toon|json|yaml|md|jsonl>", "Output format" },
        .{ "--help", "Show help" },
        .{ "--llms, --llms-full", "Print LLM-readable manifest" },
        .{ "--schema", "Show JSON Schema for command" },
        .{ "--token-count", "Print token count of output (instead of output)" },
        .{ "--token-limit <n>", "Limit output to n tokens" },
        .{ "--token-offset <n>", "Skip first n tokens of output" },
        .{ "--full-output", "Show full output envelope" },
    });
    if (options.root) try flags.appendSlice(a, &.{ .{ "--mcp", "Start as MCP stdio server" }, .{ "--version", "Show version" } });
    std.mem.sort(Flag, flags.items, {}, struct {
        fn lessThan(_: void, x: Flag, y: Flag) bool {
            return js.localeCompare(x[0], y[0]) == .lt;
        }
    }.lessThan);
    var width: usize = 0;
    for (flags.items) |f| width = @max(width, f[0].len);
    try lines.appendSlice(a, &.{ "", "Global Options:" });
    for (flags.items) |f| try lines.append(a, try std.fmt.allocPrint(a, "  {s}  {s}", .{ try js.pad(a, f[0], width), f[1] }));
}

/// Redacts a value, keeping only the last four characters of long values.
fn redact(a: Allocator, value: []const u8) Allocator.Error![]const u8 {
    const units = try js.toUtf16(a, value);
    if (units.len <= 4) return "****";
    return std.mem.concat(a, u8, &.{ "****", try js.sliceUtf16(a, units, units.len - 4, units.len) });
}
