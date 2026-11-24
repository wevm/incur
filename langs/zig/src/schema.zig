//! Schemas for arguments, options, environment variables, and outputs.
//!
//! A `Type` is the Zig counterpart of the Zod schemas the TypeScript package accepts. Derive one
//! from a plain struct with `incur.schema(T)`; see `derive.zig` for the field rules and
//! metadata. Types can also be written by hand.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const regex = @import("regex.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// A schema node: a `Kind` with the metadata Zod attaches through `.describe()`, `.default()`,
/// `.optional()`, and `.meta()`.
pub const Type = struct {
    /// Whether the option counts repeated flags (`-vvv`).
    count: bool = false,
    /// The value used when the input omits the field.
    default: ?Value = null,
    /// Whether the option is deprecated.
    deprecated: bool = false,
    /// Human-readable description.
    description: ?[]const u8 = null,
    /// The shape of accepted values.
    kind: Kind,
    /// Whether the input may omit the field.
    optional: bool = false,
    /// The range of the Zig integer type that stores the value, which `incur.schema` sets for
    /// integer fields. Validation checks it after the declared bounds; JSON Schema omits it.
    int_range: ?IntRange = null,
    /// Whether number and boolean input is converted first, as `z.coerce.number()` and
    /// `z.coerce.boolean()` do with `Number(value)` and `Boolean(value)`.
    coerce: bool = false,
    /// Whether `.optional()` wraps the default, so the parsed value may still be absent in JSON
    /// Schema and help even though parsing applies the default.
    optional_outer: bool = false,
    /// Whether an object keeps unknown keys, as `.passthrough()` does.
    passthrough: bool = false,
    /// The JSON Schema to emit instead of the derived one, as schemas converted from JSON Schema
    /// carry to reproduce Zod's output exactly.
    json: ?*const Emitted = null,

    /// Returns the fields of an object schema, or an empty slice.
    pub fn fields(ty: *const Type) []const Field {
        return if (ty.kind == .object) ty.kind.object else &.{};
    }

    /// Returns the field with the given name.
    pub fn field(ty: *const Type, name: []const u8) ?*const Field {
        for (ty.fields()) |*f| if (std.mem.eql(u8, f.name, name)) return f;
        return null;
    }

    /// Whether the input may omit the field without a default, as Zod's `optout` reports.
    pub fn isOptional(ty: *const Type) bool {
        return ty.optional and (ty.default == null or ty.optional_outer);
    }

    /// Whether the option reads no value from the next token.
    pub fn isFlag(ty: *const Type) bool {
        return ty.count or ty.kind == .boolean;
    }

    /// Returns the only non-null option of a union, such as `type: ["array", "null"]` converts
    /// to, as the parser and help read it; any other schema is itself.
    pub fn unwrap(ty: *const Type) *const Type {
        const options = switch (ty.kind) {
            .@"union" => |options| options,
            else => return ty,
        };
        var inner: ?*const Type = null;
        for (options) |*option| if (option.kind != .null) {
            if (inner != null) return ty;
            inner = option;
        };
        return if (inner) |t| t.unwrap() else ty;
    }

    /// Returns the type label help output shows.
    pub fn typeName(ty: *const Type, a: Allocator) Allocator.Error![]const u8 {
        if (ty.count) return "count";
        return switch (ty.unwrap().kind) {
            .array => "array",
            .boolean => "boolean",
            .@"enum" => |values| std.mem.join(a, "|", values),
            .integer, .number => "number",
            .string => "string",
            .object, .unknown, .null, .literal, .@"union" => "value",
        };
    }
};

/// An inclusive integer range.
pub const IntRange = struct {
    /// Minimum.
    min: i128,
    /// Maximum.
    max: i128,
};

/// The JSON Schema of a node for each side.
pub const Emitted = struct {
    /// The output JSON Schema.
    output: Value,
    /// The input JSON Schema.
    input: Value,
};

/// A string format Zod checks with a regular expression, such as `z.iso.datetime()`.
pub const Format = struct {
    /// Zod's format name, reported in issues.
    name: []const u8,
    /// The JSON Schema `format` value, or null to omit it.
    json_name: ?[]const u8,
    /// The regular expression source.
    pattern: []const u8,
    /// The issue message.
    message: []const u8,
};

/// String constraints.
pub const StringKind = struct {
    /// Maximum UTF-16 length, inclusive.
    max: ?f64 = null,
    /// Minimum UTF-16 length, inclusive.
    min: ?f64 = null,
    /// A format check.
    format: ?Format = null,
    /// Regular expression sources the string must match, as `.regex()` adds.
    patterns: []const []const u8 = &.{},
};

/// Numeric bounds: values for numbers, UTF-16 length for strings, item count for arrays.
pub const Bounds = struct {
    /// Maximum, inclusive.
    max: ?f64 = null,
    /// Minimum, inclusive.
    min: ?f64 = null,
};

/// The shape of a schema node.
pub const Kind = union(enum) {
    /// A list of values.
    array: struct {
        /// The schema of each item.
        items: *const Type,
        /// Item count bounds.
        bounds: Bounds = .{},
    },
    /// `true` or `false`.
    boolean,
    /// One of a fixed set of strings.
    @"enum": []const []const u8,
    /// A safe integer.
    integer: Bounds,
    /// A finite number.
    number: Bounds,
    /// An object with named fields, in declaration order.
    object: []const Field,
    /// A string.
    string: StringKind,
    /// Any value.
    unknown,
    /// `null`.
    null,
    /// One exact value.
    literal: Value,
    /// Any of several schemas, tried in order.
    @"union": []const Type,
};

/// A named field of an object schema.
pub const Field = struct {
    /// Single-character alias for the option (`-D`).
    alias: ?u8 = null,
    /// The field name as it appears in input and output.
    name: []const u8,
    /// The field schema.
    ty: Type,
};

/// Which side of a schema JSON Schema describes.
pub const Io = enum {
    /// Parsed values: fields with defaults are required and objects reject unknown keys.
    output,
    /// Accepted input: fields with defaults are optional and objects accept unknown keys.
    input,
};

/// Converts a schema to the JSON Schema Zod's `z.toJSONSchema()` emits, with the same key order.
pub fn jsonSchema(a: Allocator, ty: *const Type) Allocator.Error!Value {
    return jsonSchemaIo(a, ty, .output);
}

/// Converts a schema to JSON Schema for its output or its input, as Zod's `io` option does.
pub fn jsonSchemaIo(a: Allocator, ty: *const Type, io: Io) Allocator.Error!Value {
    if (ty.json) |emitted| return if (io == .output) emitted.output else emitted.input;
    var out: json.ObjectBuilder = .{};
    const wrapped = ty.optional or ty.default != null;
    // Zod lists wrapper metadata before the inner type and plain metadata after it.
    if (wrapped) try metadata(a, ty, &out);
    switch (ty.kind) {
        .array => |array| {
            // Zod lists array bounds before the type.
            try bound(a, &out, "minItems", array.bounds.min);
            try bound(a, &out, "maxItems", array.bounds.max);
            try out.put(a, "type", .{ .string = "array" });
            try out.put(a, "items", try jsonSchemaIo(a, array.items, io));
        },
        .boolean => try out.put(a, "type", .{ .string = "boolean" }),
        .@"enum" => |values| {
            try out.put(a, "type", .{ .string = "string" });
            try out.put(a, "enum", try strings(a, values));
        },
        .integer => |b| {
            try out.put(a, "type", .{ .string = "integer" });
            try bound(a, &out, "minimum", b.min orelse -js.max_safe_integer);
            try bound(a, &out, "maximum", b.max orelse js.max_safe_integer);
        },
        .number => |b| {
            try out.put(a, "type", .{ .string = "number" });
            try bound(a, &out, "minimum", b.min);
            try bound(a, &out, "maximum", b.max);
        },
        .object => |fs| {
            try out.put(a, "type", .{ .string = "object" });
            var properties: json.ObjectBuilder = .{};
            var required: std.ArrayList(Value) = .empty;
            for (fs) |*f| {
                try properties.put(a, f.name, try jsonSchemaIo(a, &f.ty, io));
                const optional = if (io == .input) f.ty.optional or f.ty.default != null else f.ty.isOptional();
                if (!optional) try required.append(a, .{ .string = f.name });
            }
            try out.put(a, "properties", properties.finish());
            if (required.items.len > 0) try out.put(a, "required", .{ .array = required.items });
            if (ty.passthrough)
                try out.put(a, "additionalProperties", .{ .object = &.{} })
            else if (io == .output)
                try out.put(a, "additionalProperties", .{ .bool = false });
        },
        .string => |b| {
            try out.put(a, "type", .{ .string = "string" });
            try bound(a, &out, "minLength", b.min);
            try bound(a, &out, "maxLength", b.max);
            var patterns: std.ArrayList([]const u8) = .empty;
            if (b.format) |f| {
                // A `pattern` check replaces the format Zod reports.
                if (f.json_name) |name| if (b.patterns.len == 0) try out.put(a, "format", .{ .string = name });
                try patterns.append(a, f.pattern);
            }
            try patterns.appendSlice(a, b.patterns);
            // Several patterns combine with `allOf`.
            if (patterns.items.len == 1) try out.put(a, "pattern", .{ .string = patterns.items[0] }) else if (patterns.items.len > 1) {
                const all = try a.alloc(Value, patterns.items.len);
                for (patterns.items, all) |pattern, *slot| {
                    var entry: json.ObjectBuilder = .{};
                    try entry.put(a, "pattern", .{ .string = pattern });
                    slot.* = entry.finish();
                }
                try out.put(a, "allOf", .{ .array = all });
            }
        },
        .unknown => {},
        .null => try out.put(a, "type", .{ .string = "null" }),
        .literal => |v| {
            try out.put(a, "type", .{ .string = switch (v) {
                .null => "null",
                .bool => "boolean",
                .integer, .big_integer, .float => "number",
                .string => "string",
                .array, .object => "object",
            } });
            try out.put(a, "const", v);
        },
        .@"union" => |options| {
            const items = try a.alloc(Value, options.len);
            for (options, items) |*option, *slot| slot.* = try jsonSchemaIo(a, option, io);
            try out.put(a, "anyOf", .{ .array = items });
        },
    }
    if (!wrapped) try metadata(a, ty, &out);
    return out.finish();
}

/// Returns a JSON array of strings.
pub fn strings(a: Allocator, values: []const []const u8) Allocator.Error!Value {
    const out = try a.alloc(Value, values.len);
    for (values, out) |v, *slot| slot.* = .{ .string = v };
    return .{ .array = out };
}

/// Writes the default, description, and `.meta()` keys of a node.
fn metadata(a: Allocator, ty: *const Type, out: *json.ObjectBuilder) Allocator.Error!void {
    if (ty.default) |d| try out.put(a, "default", d);
    if (ty.description) |d| try out.put(a, "description", .{ .string = d });
    if (ty.count) try out.put(a, "count", .{ .bool = true });
    if (ty.deprecated) try out.put(a, "deprecated", .{ .bool = true });
}

/// Writes a numeric bound when present.
fn bound(a: Allocator, out: *json.ObjectBuilder, key: []const u8, value: ?f64) Allocator.Error!void {
    if (value) |v| try out.put(a, key, .{ .float = v });
}

/// A validation issue, matching the issues Zod reports.
pub const Issue = struct {
    /// What failed.
    kind: IssueKind,
    /// Human-readable message.
    message: []const u8,
    /// Path to the failing value: object keys as strings and array indices as numbers.
    path: []const Value,

    /// Returns the Zod issue code.
    pub fn code(issue: Issue) []const u8 {
        return switch (issue.kind) {
            .invalid_type => "invalid_type",
            .invalid_value => "invalid_value",
            .invalid_format => "invalid_format",
            .invalid_union => "invalid_union",
            .too_big => "too_big",
            .too_small => "too_small",
        };
    }

    /// Returns the issue as Zod serializes it in `ZodError.message`, with the same key order.
    pub fn toJson(issue: Issue, a: Allocator) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        switch (issue.kind) {
            .invalid_type => |t| {
                try out.put(a, "expected", .{ .string = t.expected });
                if (t.format) |f| try out.put(a, "format", .{ .string = f });
                try out.put(a, "code", .{ .string = issue.code() });
                if (t.received) |r| try out.put(a, "received", .{ .string = r });
            },
            .invalid_value => |values| {
                try out.put(a, "code", .{ .string = issue.code() });
                try out.put(a, "values", .{ .array = values });
            },
            .invalid_format => |f| {
                try out.put(a, "origin", .{ .string = "string" });
                try out.put(a, "code", .{ .string = issue.code() });
                try out.put(a, "format", .{ .string = f.format });
                try out.put(a, "pattern", .{ .string = f.pattern });
            },
            .invalid_union => |options| {
                try out.put(a, "code", .{ .string = issue.code() });
                const errors = try a.alloc(Value, options.len);
                for (options, errors) |list, *slot| {
                    const items = try a.alloc(Value, list.len);
                    for (list, items) |nested, *item| item.* = try nested.toJson(a);
                    slot.* = .{ .array = items };
                }
                try out.put(a, "errors", .{ .array = errors });
            },
            .too_big, .too_small => |b| {
                const key = if (issue.kind == .too_big) "maximum" else "minimum";
                // Zod's safe-integer check reports its issue with a note and a different key order.
                if (std.mem.eql(u8, b.origin, "int")) {
                    try out.put(a, "code", .{ .string = issue.code() });
                    try out.put(a, key, b.bound);
                    try out.put(a, "note", .{ .string = "Integers must be within the safe integer range." });
                    try out.put(a, "origin", .{ .string = b.origin });
                } else {
                    try out.put(a, "origin", .{ .string = b.origin });
                    try out.put(a, "code", .{ .string = issue.code() });
                    try out.put(a, key, b.bound);
                }
                try out.put(a, "inclusive", .{ .bool = true });
            },
        }
        try out.put(a, "path", .{ .array = issue.path });
        try out.put(a, "message", .{ .string = issue.message });
        return out.finish();
    }
};

/// A bound check that failed.
pub const BoundIssue = struct {
    /// The bound, an integer or a float.
    bound: Value,
    /// The checked type.
    origin: []const u8,
};

/// The kind of a validation issue.
pub const IssueKind = union(enum) {
    /// The value has the wrong type.
    invalid_type: struct {
        /// The expected type name.
        expected: []const u8,
        /// Zod's numeric format, for integers.
        format: ?[]const u8 = null,
        /// The received value, reported for non-finite numbers.
        received: ?[]const u8 = null,
    },
    /// The value is not one of the allowed values.
    invalid_value: []const Value,
    /// A string does not match a format or pattern.
    invalid_format: struct {
        /// Zod's format name: `regex` for patterns.
        format: []const u8,
        /// The pattern: the regular expression source for formats and `/source/` for patterns.
        pattern: []const u8,
    },
    /// No option of a union matched. Holds each option's issues.
    invalid_union: []const []const Issue,
    /// The value exceeds a maximum.
    too_big: BoundIssue,
    /// The value is under a minimum.
    too_small: BoundIssue,
};

/// Validation state: the current path and the issues found.
pub const Validator = struct {
    /// Allocator for results.
    a: Allocator,
    /// The current path.
    path: std.ArrayList(Value) = .empty,
    /// Issues found.
    issues: std.ArrayList(Issue) = .empty,

    /// Validates `value` against `ty`, applying defaults and stripping unknown object keys.
    /// Returns null when an optional value is absent.
    pub fn parse(v: *Validator, ty: *const Type, value: ?Value) Allocator.Error!?Value {
        if (value == null) {
            if (ty.default) |d| return d;
            if (ty.optional or ty.kind == .unknown) return null;
        }
        if (ty.kind == .@"enum") {
            const values = ty.kind.@"enum";
            if (value) |given| if (given == .string) for (values) |allowed| {
                if (std.mem.eql(u8, allowed, given.string)) return given;
            };
            const message = if (values.len == 1)
                try std.fmt.allocPrint(v.a, "Invalid input: expected {s}", .{try json.stringify(v.a, .{ .string = values[0] })})
            else message: {
                var list: std.ArrayList([]const u8) = .empty;
                for (values) |allowed| try list.append(v.a, try json.stringify(v.a, .{ .string = allowed }));
                break :message try std.fmt.allocPrint(v.a, "Invalid option: expected one of {s}", .{try std.mem.join(v.a, "|", list.items)});
            };
            try v.issue(.{ .invalid_value = (try strings(v.a, values)).array }, message);
            return null;
        }
        if (ty.kind == .literal) {
            const expected = ty.kind.literal;
            if (value) |given| if (try equal(v.a, given, expected)) return given;
            try v.issue(.{ .invalid_value = try v.a.dupe(Value, &.{expected}) }, try std.fmt.allocPrint(v.a, "Invalid input: expected {s}", .{try json.stringify(v.a, expected)}));
            return null;
        }
        // Coercion converts a missing value too: `Number(undefined)` is NaN and
        // `Boolean(undefined)` is false.
        const present = value orelse if (ty.coerce) (if (ty.kind == .boolean) Value{ .bool = false } else Value{ .string = "NaN" }) else {
            try v.invalidType(ty, "undefined", null);
            return null;
        };
        return v.parsePresent(ty, if (ty.coerce) try coerced(v.a, ty, present) else present);
    }

    /// Validates a value that is present in the input.
    fn parsePresent(v: *Validator, ty: *const Type, value: Value) Allocator.Error!?Value {
        switch (ty.kind) {
            .array => |array| if (value == .array) {
                const out = try v.a.alloc(Value, value.array.len);
                for (value.array, out, 0..) |item, *slot, index| {
                    try v.path.append(v.a, .{ .integer = index });
                    slot.* = try v.parse(array.items, item) orelse .null;
                    _ = v.path.pop();
                }
                try v.checkBounds(.{ .integer = value.array.len }, array.bounds, "array");
                return .{ .array = out };
            },
            .boolean => if (value == .bool) return value,
            .unknown => return value,
            .null => if (value == .null) return value,
            .@"union" => |options| {
                // Options validate on their own, so their issue paths are relative.
                var failures: std.ArrayList([]const Issue) = .empty;
                var continuing: std.ArrayList([]const Issue) = .empty;
                for (options) |*option| {
                    var nested: Validator = .{ .a = v.a };
                    const parsed = try nested.parse(option, value);
                    if (nested.issues.items.len == 0) return parsed;
                    try failures.append(v.a, nested.issues.items);
                    if (!aborted(nested.issues.items)) try continuing.append(v.a, nested.issues.items);
                }
                // The one option that failed only checks reports its issues, as Zod does.
                if (continuing.items.len == 1) {
                    for (continuing.items[0]) |found| try v.issues.append(v.a, .{ .kind = found.kind, .message = found.message, .path = try std.mem.concat(v.a, Value, &.{ v.path.items, found.path }) });
                    return null;
                }
                try v.issue(.{ .invalid_union = failures.items }, "Invalid input");
                return null;
            },
            .integer, .number => |b| {
                const number = value.toFloat() orelse {
                    try v.invalidType(ty, received(value), null);
                    return null;
                };
                if (!std.math.isFinite(number)) {
                    // Zod names NaN in the message but reports infinities as numbers.
                    const nan = std.math.isNan(number);
                    try v.invalidType(ty, if (nan) "NaN" else "number", if (nan) "NaN" else "Infinity");
                    return null;
                }
                const issues = v.issues.items.len;
                if (ty.kind == .integer) {
                    if (value == .float and @trunc(number) != number) {
                        // Only a finite fraction reports the integer format.
                        try v.issue(.{ .invalid_type = .{ .expected = "int", .format = "safeint" } }, "Invalid input: expected int, received number");
                        return null;
                    }
                    const min = b.min orelse -js.max_safe_integer;
                    const max = b.max orelse js.max_safe_integer;
                    const safe = (min == -js.max_safe_integer and compare(value, min) == .lt) or (max == js.max_safe_integer and compare(value, max) == .gt);
                    try v.checkBounds(value, .{ .min = min, .max = max }, if (safe) "int" else "number");
                } else {
                    try v.checkBounds(value, b, "number");
                }
                if (v.issues.items.len > issues) return null;
                if (ty.int_range) |range| try v.checkRange(value, range);
                // Integers coerced from argv and the environment are floats until here.
                return if (ty.kind == .integer and value == .float) .{ .integer = @intFromFloat(number) } else value;
            },
            .object => |fs| if (value == .object) {
                var out: json.ObjectBuilder = .{};
                for (fs) |*f| {
                    try v.path.append(v.a, .{ .string = f.name });
                    if (try v.parse(&f.ty, value.get(f.name))) |parsed| try out.put(v.a, f.name, parsed);
                    _ = v.path.pop();
                }
                if (ty.passthrough) for (value.object) |entry| {
                    if (ty.field(entry.key) == null) try out.put(v.a, entry.key, entry.value);
                };
                return out.finish();
            },
            .string => |b| if (value == .string) {
                const issues = v.issues.items.len;
                try v.checkBounds(.{ .integer = js.utf16Len(value.string) }, .{ .min = b.min, .max = b.max }, "string");
                if (b.format) |f| if (!try v.test_(f.pattern, value.string))
                    try v.issue(.{ .invalid_format = .{ .format = f.name, .pattern = f.pattern } }, f.message);
                for (b.patterns) |pattern| if (!try v.test_(pattern, value.string)) {
                    const shown = try std.fmt.allocPrint(v.a, "/{s}/", .{pattern});
                    try v.issue(.{ .invalid_format = .{ .format = "regex", .pattern = shown } }, try std.fmt.allocPrint(v.a, "Invalid string: must match pattern {s}", .{shown}));
                };
                return if (v.issues.items.len > issues) null else value;
            },
            // `parse` handles enums and literals before reaching here.
            .@"enum", .literal => {},
        }
        try v.invalidType(ty, received(value), null);
        return null;
    }

    /// Whether a pattern matches. Patterns this port cannot compile always match.
    fn test_(v: *Validator, pattern: []const u8, text: []const u8) Allocator.Error!bool {
        const compiled = try regex.Regex.compile(v.a, pattern) orelse return true;
        return compiled.matches(v.a, text);
    }

    /// Records an issue at the current path.
    fn issue(v: *Validator, kind: IssueKind, message: []const u8) Allocator.Error!void {
        try v.issues.append(v.a, .{ .kind = kind, .message = message, .path = try v.a.dupe(Value, v.path.items) });
    }

    /// Reports an `invalid_type` issue for `ty`.
    fn invalidType(v: *Validator, ty: *const Type, got: []const u8, reported: ?[]const u8) Allocator.Error!void {
        const expected = switch (ty.kind) {
            .array => "array",
            .boolean => "boolean",
            .integer, .number => "number",
            .object => "object",
            .null => "null",
            // Enums, literals, unions, and unknown values never report a type mismatch.
            .@"enum", .string, .unknown, .literal, .@"union" => "string",
        };
        try v.issue(
            .{ .invalid_type = .{ .expected = expected, .received = reported } },
            try std.fmt.allocPrint(v.a, "Invalid input: expected {s}, received {s}", .{ expected, got }),
        );
    }

    /// Reports `too_small` and `too_big` issues for a number, length, or item count.
    fn checkBounds(v: *Validator, value: Value, b: Bounds, origin: []const u8) Allocator.Error!void {
        if (b.min) |minimum| if (compare(value, minimum) == .lt) try v.tooSmall(.{ .float = minimum }, origin);
        if (b.max) |maximum| if (compare(value, maximum) == .gt) try v.tooBig(.{ .float = maximum }, origin);
    }

    /// Reports a number that is not an integer or does not fit the Zig integer type storing it.
    fn checkRange(v: *Validator, value: Value, range: IntRange) Allocator.Error!void {
        const int: i128 = switch (value) {
            .integer => |i| i,
            .float => |f| if (@trunc(f) != f)
                return v.issue(.{ .invalid_type = .{ .expected = "int" } }, "Invalid input: expected int, received number")
            else if (@abs(f) < 0x1p127) @intFromFloat(f) else return v.outOfRange(f < 0, range),
            else => return v.outOfRange(value.big_integer[0] == '-', range),
        };
        if (int < range.min or int > range.max) try v.outOfRange(int < range.min, range);
    }

    /// Reports a number below or above an integer range.
    fn outOfRange(v: *Validator, below: bool, range: IntRange) Allocator.Error!void {
        if (below) try v.tooSmall(.{ .integer = range.min }, "number") else try v.tooBig(.{ .integer = range.max }, "number");
    }

    /// Reports a `too_small` issue.
    fn tooSmall(v: *Validator, minimum: Value, origin: []const u8) Allocator.Error!void {
        try v.issue(.{ .too_small = .{ .bound = minimum, .origin = origin } }, try std.fmt.allocPrint(v.a, "Too small: expected {s} to {s} >={s}{s}", .{ origin, verb(origin), try json.toString(v.a, minimum), unit(origin) }));
    }

    /// Reports a `too_big` issue.
    fn tooBig(v: *Validator, maximum: Value, origin: []const u8) Allocator.Error!void {
        try v.issue(.{ .too_big = .{ .bound = maximum, .origin = origin } }, try std.fmt.allocPrint(v.a, "Too big: expected {s} to {s} <={s}{s}", .{ origin, verb(origin), try json.toString(v.a, maximum), unit(origin) }));
    }
};

/// Returns the unit Zod's bound messages name for an origin.
fn unit(origin: []const u8) []const u8 {
    return if (std.mem.eql(u8, origin, "string")) " characters" else if (std.mem.eql(u8, origin, "array")) " items" else "";
}

/// Returns the verb Zod's bound messages use for an origin.
fn verb(origin: []const u8) []const u8 {
    return if (unit(origin).len == 0) "be" else "have";
}

/// Compares a number with a finite bound exactly, without rounding integers to floats.
fn compare(value: Value, limit: f64) std.math.Order {
    switch (value) {
        .integer => |int| {
            // Bounds beyond the `i128` range compare by sign; others compare as integers, with a
            // fractional limit between its floor and the next integer.
            if (limit >= 0x1p127) return .lt;
            if (limit < -0x1p127) return .gt;
            const floor = @floor(limit);
            const order = std.math.order(int, @as(i128, @intFromFloat(floor)));
            return if (order == .eq and floor != limit) .lt else order;
        },
        else => return std.math.order(value.toFloat().?, limit),
    }
}

/// Returns Zod's name for the type of a received value.
fn received(value: Value) []const u8 {
    return switch (value) {
        .array => "array",
        .bool => "boolean",
        .null => "null",
        .integer, .big_integer, .float => "number",
        .object => "object",
        .string => "string",
    };
}

/// Converts input as `Number(value)` or `Boolean(value)` does for coerced schemas.
fn coerced(a: Allocator, ty: *const Type, value: Value) Allocator.Error!Value {
    return switch (ty.kind) {
        .boolean => .{ .bool = switch (value) {
            .null => false,
            .bool => |b| b,
            .string => |text| text.len > 0,
            .integer => |i| i != 0,
            .big_integer => true,
            .float => |f| f != 0 and !std.math.isNan(f),
            .array, .object => true,
        } },
        .integer, .number => switch (value) {
            .null => .{ .integer = 0 },
            .bool => |b| .{ .integer = @intFromBool(b) },
            .string => |text| .{ .float = js.toNumber(text) },
            .integer, .big_integer, .float => value,
            // An array converts through its string form.
            .array => |items| if (items.len == 0) .{ .integer = 0 } else if (items.len == 1) coerced(a, ty, .{ .string = try json.toString(a, items[0]) }) else .{ .float = std.math.nan(f64) },
            .object => .{ .float = std.math.nan(f64) },
        },
        else => value,
    };
}

/// Whether issues stop Zod from trying later checks: type and value mismatches do, while failed
/// bounds and formats let parsing continue.
fn aborted(issues: []const Issue) bool {
    for (issues) |found| switch (found.kind) {
        .too_big, .too_small, .invalid_format => {},
        else => return true,
    };
    return false;
}

/// Whether two JSON values are equal, as a literal check compares them.
fn equal(a: Allocator, x: Value, y: Value) Allocator.Error!bool {
    return std.mem.eql(u8, try json.stringify(a, x), try json.stringify(a, y));
}
