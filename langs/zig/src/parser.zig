//! Parses argv tokens and environment variables against schemas.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");
const errors = @import("errors.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;
const Error = errors.Error;

/// The result of parsing: a value, or an incur error to report.
pub fn Result(comptime T: type) type {
    return union(enum) {
        /// The parsed value.
        ok: T,
        /// The failure.
        err: Error,
    };
}

/// Parsed positional arguments and options.
pub const Parsed = struct {
    /// Positional arguments.
    args: Value,
    /// Named options.
    options: Value,
};

/// Lookup tables for option names and aliases.
const Names = struct {
    a: Allocator,
    /// The options schema.
    schema: ?*const Type,

    /// Resolves a short alias to its option name.
    fn alias(n: Names, short: u21) ?[]const u8 {
        const s = n.schema orelse return null;
        for (s.fields()) |f| if (f.alias != null and f.alias.? == short) return f.name;
        return null;
    }

    /// Resolves a long option, accepting kebab-case for camelCase names.
    fn long(n: Names, raw: []const u8) Allocator.Error!?[]const u8 {
        const s = n.schema orelse return null;
        for (s.fields()) |f| {
            const kebab = try js.toKebab(n.a, f.name);
            if (std.mem.eql(u8, kebab, raw) and !std.mem.eql(u8, kebab, f.name)) return f.name;
        }
        for (s.fields()) |f| if (std.mem.eql(u8, f.name, raw)) return f.name;
        return null;
    }

    /// Returns the schema of an option, reading a `T | null` union as `T`.
    fn ty(n: Names, name: []const u8) ?*const Type {
        const f = (n.schema orelse return null).field(name) orelse return null;
        return f.ty.unwrap();
    }

    /// Whether an option counts repeated flags.
    fn isCount(n: Names, name: []const u8) bool {
        return n.ty(name).?.count;
    }

    /// Whether an option is a boolean flag.
    fn isBoolean(n: Names, name: []const u8) bool {
        return n.ty(name).?.kind == .boolean;
    }

    /// Whether an option reads the next token as its value.
    fn takesValue(n: Names, name: []const u8) bool {
        return !n.isCount(name) and !n.isBoolean(name);
    }
};

/// Error for an unknown flag or a missing value.
fn parseError(a: Allocator, comptime fmt: []const u8, args: anytype) Allocator.Error!Error {
    return .{ .message = try std.fmt.allocPrint(a, fmt, args), .parse_error = true };
}

/// Raw option values in input order.
const Raw = json.ObjectBuilder;

/// A `true` or `false` token after a boolean flag, which may be the flag's value.
const Candidate = struct {
    /// Index of the token among the positionals.
    index: usize,
    /// The boolean option.
    name: []const u8,
    /// The token's value.
    value: bool,
    /// argv index of the flag.
    flag: usize,
};

/// Reads `argv[i]` as a boolean when it is `true` or `false`.
fn literal(argv: []const []const u8, i: usize) ?bool {
    if (i >= argv.len) return null;
    if (std.mem.eql(u8, argv[i], "true")) return true;
    if (std.mem.eql(u8, argv[i], "false")) return false;
    return null;
}

/// Whether one of the consumed candidates is the positional at `index`.
fn isConsumed(consumed: []const Candidate, index: usize) bool {
    for (consumed) |c| if (c.index == index) return true;
    return false;
}

/// Increments a counter option.
fn increment(a: Allocator, raw: *Raw, name: []const u8) Allocator.Error!void {
    const current = raw.finish().get(name);
    try raw.put(a, name, .{ .integer = if (current != null and current.? == .integer) current.?.integer + 1 else 1 });
}

/// Sets an option value, collecting values of array options.
fn set(a: Allocator, raw: *Raw, names: Names, name: []const u8, value: []const u8) Allocator.Error!void {
    if (names.ty(name).?.kind == .array) {
        const existing = raw.finish().get(name);
        const items = if (existing != null and existing.? == .array) existing.?.array else &.{};
        try raw.put(a, name, .{ .array = try std.mem.concat(a, Value, &.{ items, &.{.{ .string = value }} }) });
    } else {
        try raw.put(a, name, .{ .string = value });
    }
}

/// Coerces a raw string to the option's type before validation.
fn coerce(value: Value, ty: ?*const Type) Value {
    const t = ty orelse return value;
    if (value != .string) return value;
    return switch (t.kind) {
        .number, .integer => .{ .float = js.toNumber(value.string) },
        .boolean => .{ .bool = std.mem.eql(u8, value.string, "true") },
        else => value,
    };
}

/// Validates an object against a schema.
pub fn validate(a: Allocator, ty: *const Type, input: Value) Allocator.Error!Result(Value) {
    var v: schema.Validator = .{ .a = a };
    const parsed = try v.parse(ty, input);
    if (v.issues.items.len == 0) return .{ .ok = parsed orelse .{ .object = &.{} } };
    return .{ .err = try errors.validation(a, v.issues.items, input) };
}

/// Parses argv tokens against an args schema and an options schema.
///
/// `defaults` are config-file option defaults, applied before argv values. Returns an `UNKNOWN`
/// error for unknown flags and missing values, and a `VALIDATION_ERROR` when values do not
/// match the schemas.
pub fn parse(a: Allocator, argv: []const []const u8, args: ?*const Type, options: ?*const Type, defaults: ?[]const Value.Entry) Allocator.Error!Result(Parsed) {
    const names: Names = .{ .a = a, .schema = options };
    var positionals: std.ArrayList([]const u8) = .empty;
    var raw: Raw = .{};
    // `true`/`false` tokens after boolean flags, kept as positionals until the arg count is known.
    var candidates: std.ArrayList(Candidate) = .empty;
    // The argv index of the last token that set each boolean option.
    var last_boolean: std.StringHashMapUnmanaged(usize) = .empty;

    var i: usize = 0;
    while (i < argv.len) {
        const token = argv[i];
        if (std.mem.eql(u8, token, "--")) {
            try positionals.appendSlice(a, argv[i + 1 ..]);
            break;
        } else if (std.mem.startsWith(u8, token, "--no-") and token.len > 5) {
            const name = try names.long(token[5..]) orelse return .{ .err = try parseError(a, "Unknown flag: {s}", .{token}) };
            try raw.put(a, name, .{ .bool = false });
            try last_boolean.put(a, name, i);
            i += 1;
        } else if (std.mem.startsWith(u8, token, "--")) {
            const body = token[2..];
            if (std.mem.findScalar(u8, body, '=')) |eq| {
                const name = try names.long(body[0..eq]) orelse return .{ .err = try parseError(a, "Unknown flag: --{s}", .{body[0..eq]}) };
                try set(a, &raw, names, name, body[eq + 1 ..]);
                if (names.isBoolean(name)) try last_boolean.put(a, name, i);
                i += 1;
            } else {
                const name = try names.long(body) orelse return .{ .err = try parseError(a, "Unknown flag: {s}", .{token}) };
                if (names.isCount(name)) {
                    try increment(a, &raw, name);
                    i += 1;
                } else if (names.isBoolean(name)) {
                    try raw.put(a, name, .{ .bool = true });
                    try last_boolean.put(a, name, i);
                    if (literal(argv, i + 1)) |value| {
                        try candidates.append(a, .{ .index = positionals.items.len, .name = name, .value = value, .flag = i });
                        try positionals.append(a, argv[i + 1]);
                        i += 1;
                    }
                    i += 1;
                } else {
                    if (i + 1 >= argv.len) return .{ .err = try parseError(a, "Missing value for flag: {s}", .{token}) };
                    try set(a, &raw, names, name, argv[i + 1]);
                    i += 2;
                }
            }
        } else if (token.len >= 2 and token[0] == '-') {
            var it = js.Utf8.init(token[1..]);
            while (it.next()) |short| {
                const last = it.i == token.len - 1;
                const name = names.alias(short) orelse return .{ .err = try parseError(a, "Unknown flag: -{u}", .{short}) };
                if (names.isCount(name)) {
                    try increment(a, &raw, name);
                } else if (names.isBoolean(name)) {
                    try raw.put(a, name, .{ .bool = true });
                    try last_boolean.put(a, name, i);
                    if (!last) continue;
                    if (literal(argv, i + 1)) |value| {
                        try candidates.append(a, .{ .index = positionals.items.len, .name = name, .value = value, .flag = i });
                        try positionals.append(a, argv[i + 1]);
                        i += 1;
                    }
                } else if (!last) {
                    return .{ .err = try parseError(a, "Non-boolean flag -{u} must be last in a stacked alias", .{short}) };
                } else {
                    if (i + 1 >= argv.len) return .{ .err = try parseError(a, "Missing value for flag: -{u}", .{short}) };
                    try set(a, &raw, names, name, argv[i + 1]);
                    i += 1;
                }
            }
            i += 1;
        } else {
            try positionals.append(a, token);
            i += 1;
        }
    }

    // A spaced `true`/`false` after a boolean flag is its value only when no positional slot is
    // left for it, earliest first; a later assignment of the same flag still wins.
    const fields = if (args) |s| s.fields() else &.{};
    const variadic = fields.len > 0 and fields[fields.len - 1].ty.unwrap().kind == .array;
    var kept = positionals.items;
    if (!variadic) {
        var consumed: usize = 0;
        for (candidates.items) |c| {
            if (positionals.items.len - consumed <= fields.len) break;
            consumed += 1;
            if (last_boolean.get(c.name).? == c.flag) try raw.put(a, c.name, .{ .bool = c.value });
        }
        kept = try a.alloc([]const u8, positionals.items.len - consumed);
        var n: usize = 0;
        for (positionals.items, 0..) |p, j| {
            if (isConsumed(candidates.items[0..consumed], j)) continue;
            kept[n] = p;
            n += 1;
        }
    }

    // Positionals fill args in order; a final array arg collects the rest.
    var raw_args: json.ObjectBuilder = .{};
    for (fields, 0..) |f, j| {
        if (f.ty.unwrap().kind == .array) {
            if (j != fields.len - 1) return .{ .err = try parseError(a, "Variadic arg \"{s}\" must be the last key in the args schema", .{f.name}) };
            if (j < kept.len) try raw_args.put(a, f.name, try schema.strings(a, kept[j..]));
        } else if (j < kept.len) {
            try raw_args.put(a, f.name, .{ .string = kept[j] });
        }
    }
    if (!variadic and kept.len > fields.len) return .{ .err = try parseError(a, "Unexpected argument: {s}", .{kept[fields.len]}) };
    const parsed_args = if (args) |s| switch (try validate(a, s, raw_args.finish())) {
        .ok => |v| v,
        .err => |e| return .{ .err = e },
    } else Value{ .object = &.{} };

    var merged: json.ObjectBuilder = .{};
    for (defaults orelse &.{}) |entry| {
        const name = try names.long(entry.key) orelse return .{ .err = try parseError(a, "Unknown config option: {s}", .{entry.key}) };
        try merged.put(a, name, entry.value);
    }
    for (raw.entries.items) |entry| try merged.put(a, entry.key, coerce(entry.value, names.ty(entry.key)));
    const parsed_options = if (options) |s| switch (try validate(a, s, merged.finish())) {
        .ok => |v| v,
        .err => |e| return .{ .err = e },
    } else Value{ .object = &.{} };
    return .{ .ok = .{ .args = parsed_args, .options = parsed_options } };
}

/// Parses a config section on its own: normalizes its keys as `parse` does and validates only
/// the options it sets.
pub fn parseDefaults(a: Allocator, defaults: []const Value.Entry, options: ?*const Type) Allocator.Error!Result(Value) {
    const names: Names = .{ .a = a, .schema = options };
    var normalized: json.ObjectBuilder = .{};
    for (defaults) |entry| {
        const name = try names.long(entry.key) orelse return .{ .err = try parseError(a, "Unknown config option: {s}", .{entry.key}) };
        try normalized.put(a, name, entry.value);
    }
    // Without a schema, any key is unknown, so nothing is left to validate.
    return validatePassed(a, options orelse &.{ .kind = .{ .object = &.{} } }, normalized.finish());
}

/// Coerces and validates the globals passed in argv against their fields only, so missing
/// required globals are not an error.
pub fn parsePassedGlobals(a: Allocator, ty: *const Type, raw: Value) Allocator.Error!Result(Value) {
    const names: Names = .{ .a = a, .schema = ty };
    var coerced: json.ObjectBuilder = .{};
    for (raw.object) |entry| try coerced.put(a, entry.key, coerce(entry.value, names.ty(entry.key)));
    return validatePassed(a, ty, coerced.finish());
}

/// Validates values against only their fields of an object schema, in input order.
fn validatePassed(a: Allocator, ty: *const Type, input: Value) Allocator.Error!Result(Value) {
    const fields = try a.alloc(schema.Field, input.object.len);
    for (input.object, fields) |entry, *slot| slot.* = ty.field(entry.key).?.*;
    return validate(a, &.{ .kind = .{ .object = fields } }, input);
}

/// Parses environment variables against a schema. Returns a `VALIDATION_ERROR` when values do
/// not match the schema.
pub fn parseEnv(a: Allocator, ty: *const Type, env: *const std.process.Environ.Map) Allocator.Error!Result(Value) {
    var raw: json.ObjectBuilder = .{};
    for (ty.fields()) |f| if (env.get(f.name)) |value| {
        const coerced: Value = switch (f.ty.unwrap().kind) {
            .number, .integer => .{ .float = js.toNumber(value) },
            .boolean => .{ .bool = std.mem.eql(u8, value, "true") or std.mem.eql(u8, value, "1") },
            else => .{ .string = value },
        };
        try raw.put(a, f.name, coerced);
    };
    return validate(a, ty, raw.finish());
}

/// Options for `parseGlobals`.
pub const GlobalsOptions = struct {
    /// The command that receives the remaining tokens. Values of its value-taking options pass
    /// through untouched, and an unknown flag stops global parsing. `.unknown` means the command
    /// is not yet known.
    command: union(enum) {
        /// No command context: every unknown token passes through.
        none,
        /// The command is not yet known.
        unknown,
        /// The command's options schema.
        known: ?*const Type,
    } = .none,
    /// Whether to validate parsed globals.
    validate: bool = false,
};

/// Parsed globals and the remaining tokens.
pub const Globals = struct {
    /// The parsed globals.
    values: Value,
    /// Tokens that are not globals, in order.
    rest: []const []const u8,
};

/// Parses known global options, passing other tokens through in order. Returns an error for
/// missing values and invalid global values.
pub fn parseGlobals(a: Allocator, argv: []const []const u8, ty: *const Type, options: GlobalsOptions) Allocator.Error!Result(Globals) {
    const names: Names = .{ .a = a, .schema = ty };
    const command: ?Names = switch (options.command) {
        .none => null,
        .unknown => .{ .a = a, .schema = null },
        .known => |s| .{ .a = a, .schema = s },
    };
    var rest: std.ArrayList([]const u8) = .empty;
    var raw: Raw = .{};

    var i: usize = 0;
    while (i < argv.len) {
        const token = argv[i];
        if (std.mem.eql(u8, token, "--") or (command != null and try isUnknownFlag(token, names, command.?))) {
            try rest.appendSlice(a, argv[i..]);
            break;
        }
        if (std.mem.startsWith(u8, token, "--no-") and token.len > 5) {
            if (try names.long(token[5..])) |name| try raw.put(a, name, .{ .bool = false }) else try rest.append(a, token);
            i += 1;
        } else if (std.mem.startsWith(u8, token, "--")) {
            const body = token[2..];
            if (std.mem.findScalar(u8, body, '=')) |eq| {
                if (try names.long(body[0..eq])) |name| try set(a, &raw, names, name, body[eq + 1 ..]) else try rest.append(a, token);
                i += 1;
            } else if (try names.long(body)) |name| {
                if (names.isCount(name)) {
                    try increment(a, &raw, name);
                    i += 1;
                } else if (names.isBoolean(name)) {
                    try raw.put(a, name, .{ .bool = true });
                    i += 1;
                } else {
                    if (i + 1 >= argv.len) return .{ .err = try parseError(a, "Missing value for flag: {s}", .{token}) };
                    try set(a, &raw, names, name, argv[i + 1]);
                    i += 2;
                }
            } else {
                try rest.append(a, token);
                i += 1;
                const takes = if (command) |c| (if (try c.long(body)) |name| c.takesValue(name) else false) else false;
                if (takes and i < argv.len) {
                    try rest.append(a, argv[i]);
                    i += 1;
                }
            }
        } else if (token.len >= 2 and token[0] == '-') {
            var known = true;
            var check = js.Utf8.init(token[1..]);
            while (check.next()) |ch| {
                if (names.alias(ch) == null and (command == null or command.?.alias(ch) == null)) known = false;
            }
            if (!known) {
                try rest.append(a, token);
                i += 1;
                continue;
            }
            var command_chars: std.ArrayList(u8) = .empty;
            var command_value: ?[]const u8 = null;
            var it = js.Utf8.init(token[1..]);
            while (true) {
                const begin = it.i;
                const short = it.next() orelse break;
                const last = it.i == token.len - 1;
                const name = names.alias(short) orelse {
                    try command_chars.appendSlice(a, token[1..][begin..it.i]);
                    // `known` guarantees the alias belongs to the command.
                    const c = command.?;
                    if (!c.takesValue(c.alias(short).?)) continue;
                    if (!last) return .{ .err = try parseError(a, "Non-boolean flag -{u} must be last in a stacked alias", .{short}) };
                    if (i + 1 < argv.len) {
                        command_value = argv[i + 1];
                        i += 1;
                    }
                    continue;
                };
                if (names.isCount(name)) {
                    try increment(a, &raw, name);
                } else if (names.isBoolean(name)) {
                    try raw.put(a, name, .{ .bool = true });
                } else if (!last) {
                    return .{ .err = try parseError(a, "Non-boolean flag -{u} must be last in a stacked alias", .{short}) };
                } else {
                    if (i + 1 >= argv.len) return .{ .err = try parseError(a, "Missing value for flag: -{u}", .{short}) };
                    try set(a, &raw, names, name, argv[i + 1]);
                    i += 1;
                }
            }
            if (command_chars.items.len > 0) try rest.append(a, try std.mem.concat(a, u8, &.{ "-", command_chars.items }));
            if (command_value) |value| try rest.append(a, value);
            i += 1;
        } else {
            try rest.append(a, token);
            i += 1;
        }
    }

    if (!options.validate) return .{ .ok = .{ .values = raw.finish(), .rest = rest.items } };
    var coerced: json.ObjectBuilder = .{};
    for (raw.entries.items) |entry| try coerced.put(a, entry.key, coerce(entry.value, names.ty(entry.key)));
    return switch (try validate(a, ty, coerced.finish())) {
        .ok => |v| .{ .ok = .{ .values = v, .rest = rest.items } },
        .err => |e| .{ .err = e },
    };
}

/// Whether a flag that may read the next token is neither a global nor a command option.
fn isUnknownFlag(token: []const u8, globals: Names, command: Names) Allocator.Error!bool {
    if (std.mem.startsWith(u8, token, "--")) {
        if (std.mem.startsWith(u8, token, "--no-") or std.mem.findScalar(u8, token, '=') != null) return false;
        return try globals.long(token[2..]) == null and try command.long(token[2..]) == null;
    }
    if (token.len < 2 or token[0] != '-') return false;
    var it = js.Utf8.init(token[1..]);
    while (it.next()) |ch| if (globals.alias(ch) == null and command.alias(ch) == null) return true;
    return false;
}
