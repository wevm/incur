//! Command errors and call-to-action suggestions.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// A command failure with a machine-readable code, rendered like the TypeScript `c.error()`.
///
/// Handlers and middleware report one with `Context.fail`.
pub const Error = struct {
    /// Machine-readable error code.
    code: []const u8 = "UNKNOWN",
    /// Human-readable message.
    message: []const u8,
    /// Suggested commands to run next.
    cta: ?CtaBlock = null,
    /// Process exit code. Defaults to 1.
    exit_code: ?u8 = null,
    /// Per-field validation errors.
    field_errors: ?[]const FieldError = null,
    /// Actionable hint.
    hint: ?[]const u8 = null,
    /// Whether the operation can be retried.
    retryable: ?bool = null,

    /// Returns the `error` object of the output envelope.
    pub fn toValue(e: Error, a: Allocator) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        try out.put(a, "code", .{ .string = e.code });
        try out.put(a, "message", .{ .string = e.message });
        if (e.hint) |hint| try out.put(a, "hint", .{ .string = hint });
        if (e.retryable) |r| try out.put(a, "retryable", .{ .bool = r });
        if (e.field_errors) |fields| {
            const items = try a.alloc(Value, fields.len);
            for (fields, items) |f, *slot| slot.* = try f.toValue(a);
            try out.put(a, "fieldErrors", .{ .array = items });
        }
        return out.finish();
    }
};

/// Builds a validation error from schema issues, with Zod's message and details.
pub fn validation(a: Allocator, issues: []const schema.Issue, input: Value) Allocator.Error!Error {
    var short: std.ArrayList([]const u8) = .empty;
    const details = try a.alloc(Value, issues.len);
    const fields = try a.alloc(FieldError, issues.len);
    for (issues, details, fields) |issue, *detail, *f| {
        try short.append(a, issue.message);
        detail.* = try issue.toJson(a);
        var parts: std.ArrayList([]const u8) = .empty;
        for (issue.path) |part| try parts.append(a, try json.toString(a, part));
        const expected, const received = switch (issue.kind) {
            .invalid_type => |t| .{ t.expected, t.received orelse "" },
            else => .{ "", "" },
        };
        f.* = .{
            .code = issue.code(),
            .expected = expected,
            .message = issue.message,
            .missing = !hasPath(input, issue.path),
            .path = try std.mem.join(a, ".", parts.items),
            .received = received,
        };
    }
    return .{
        .code = "VALIDATION_ERROR",
        .message = try std.fmt.allocPrint(a, "{s}\n\nDetails: {s}", .{
            try std.mem.join(a, "; ", short.items),
            try json.stringifyPretty(a, .{ .array = details }),
        }),
        .field_errors = fields,
    };
}

/// Whether the input contains the full issue path.
fn hasPath(input: Value, path: []const Value) bool {
    var current = input;
    for (path) |part| {
        // Issue paths hold object keys and array indices.
        current = switch (part) {
            .number => |index| if (current == .array and index < @as(f64, @floatFromInt(current.array.len)))
                current.array[@intFromFloat(index)]
            else
                return false,
            else => current.get(part.string) orelse return false,
        };
    }
    return true;
}

/// A field-level validation error.
pub const FieldError = struct {
    /// The Zod issue code.
    code: []const u8,
    /// The expected type.
    expected: []const u8,
    /// Human-readable message.
    message: []const u8,
    /// Whether the input omitted the field.
    missing: bool,
    /// The dotted field path.
    path: []const u8,
    /// The received value, when reported.
    received: []const u8,

    /// Returns the field error as output data.
    fn toValue(f: FieldError, a: Allocator) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        try out.put(a, "code", .{ .string = f.code });
        try out.put(a, "missing", .{ .bool = f.missing });
        try out.put(a, "path", .{ .string = f.path });
        try out.put(a, "expected", .{ .string = f.expected });
        try out.put(a, "received", .{ .string = f.received });
        try out.put(a, "message", .{ .string = f.message });
        return out.finish();
    }
};

/// A suggested command.
pub const Cta = struct {
    /// The command to run, without the CLI name.
    command: []const u8,
    /// What the command does.
    description: ?[]const u8 = null,
    /// Positional arguments appended as bare values. `true` renders `<name>`.
    args: []const Value.Entry = &.{},
    /// Options appended as `--key value`. `true` renders `--key <key>`.
    options: []const Value.Entry = &.{},
};

/// A list of suggested commands with an optional label.
pub const CtaBlock = struct {
    /// Suggested commands.
    commands: []const Cta,
    /// Label. Defaults to `Suggested command:` or `Suggested commands:`.
    description: ?[]const u8 = null,
};

/// A suggestion with the CLI name and arguments folded into one command line.
pub const FormattedCta = struct {
    /// The full command line.
    command: []const u8,
    /// What the command does.
    description: ?[]const u8 = null,
};

/// A formatted block of suggestions.
pub const FormattedCtaBlock = struct {
    /// Formatted suggestions.
    commands: []const FormattedCta,
    /// Label.
    description: []const u8,

    /// Formats a block, prefixing commands with the CLI name. Empty blocks format as null.
    pub fn init(a: Allocator, name: []const u8, block: ?CtaBlock) Allocator.Error!?FormattedCtaBlock {
        const b = block orelse return null;
        if (b.commands.len == 0) return null;
        const program = name[0 .. std.mem.findScalar(u8, name, ' ') orelse name.len];
        const commands = try a.alloc(FormattedCta, b.commands.len);
        for (b.commands, commands) |cta, *slot| {
            const prefixed = std.mem.eql(u8, cta.command, program) or
                (std.mem.startsWith(u8, cta.command, program) and cta.command.len > program.len and cta.command[program.len] == ' ');
            var command: std.ArrayList(u8) = .empty;
            if (!prefixed) try command.print(a, "{s} ", .{name});
            try command.appendSlice(a, cta.command);
            for (cta.args) |arg| {
                if (isTrue(arg.value))
                    try command.print(a, " <{s}>", .{arg.key})
                else
                    try command.print(a, " {s}", .{try json.toString(a, arg.value)});
            }
            for (cta.options) |option| {
                if (isTrue(option.value))
                    try command.print(a, " --{s} <{s}>", .{ option.key, option.key })
                else
                    try command.print(a, " --{s} {s}", .{ option.key, try json.toString(a, option.value) });
            }
            slot.* = .{ .command = command.items, .description = nonEmpty(cta.description) };
        }
        return .{
            .commands = commands,
            .description = b.description orelse if (commands.len == 1) "Suggested command:" else "Suggested commands:",
        };
    }

    /// Returns the block as output data.
    pub fn toValue(block: FormattedCtaBlock, a: Allocator) Allocator.Error!Value {
        const commands = try a.alloc(Value, block.commands.len);
        for (block.commands, commands) |cta, *slot| {
            var entry: json.ObjectBuilder = .{};
            try entry.put(a, "command", .{ .string = cta.command });
            if (cta.description) |d| try entry.put(a, "description", .{ .string = d });
            slot.* = entry.finish();
        }
        var out: json.ObjectBuilder = .{};
        try out.put(a, "description", .{ .string = block.description });
        try out.put(a, "commands", .{ .array = commands });
        return out.finish();
    }

    /// Renders the block for a terminal.
    pub fn human(block: FormattedCtaBlock, a: Allocator) Allocator.Error![]const u8 {
        var width: usize = 0;
        for (block.commands) |cta| width = @max(width, js.utf16Len(cta.command));
        var out: std.ArrayList(u8) = .empty;
        try out.print(a, "\n{s}", .{block.description});
        for (block.commands) |cta| {
            try out.print(a, "\n  {s}", .{cta.command});
            if (cta.description) |d| try out.print(a, "  {s}# {s}", .{ try js.repeat(a, " ", width - js.utf16Len(cta.command)), d });
        }
        return out.items;
    }
};

/// Whether a value is `true`.
fn isTrue(value: Value) bool {
    return value == .bool and value.bool;
}

/// Returns the text unless it is null or empty.
pub fn nonEmpty(text: ?[]const u8) ?[]const u8 {
    const t = text orelse return null;
    return if (t.len == 0) null else t;
}

/// Renders an error for a terminal.
pub fn humanError(a: Allocator, e: Error) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    if (std.mem.eql(u8, e.code, "UNKNOWN") or std.mem.eql(u8, e.code, "COMMAND_NOT_FOUND"))
        try out.appendSlice(a, "Error")
    else
        try out.print(a, "Error ({s})", .{e.code});
    try out.print(a, ": {s}", .{e.message});
    for (e.field_errors orelse &.{}) |f| try out.print(a, "\n  {s}: {s}", .{ f.path, f.message });
    if (nonEmpty(e.hint)) |hint| try out.print(a, "\nHint: {s}", .{hint});
    return out.items;
}
