//! Schemas for arguments, options, environment variables, and outputs.
//!
//! A `Type` is the Zig counterpart of the Zod schemas the TypeScript package accepts. Derive one
//! from a plain struct with `incur.schema(T)`; see `derive.zig` for the field rules and
//! metadata. Types can also be written by hand.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");

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
        return ty.optional and ty.default == null;
    }

    /// Whether the option reads no value from the next token.
    pub fn isFlag(ty: *const Type) bool {
        return ty.count or ty.kind == .boolean;
    }

    /// Returns the type label help output shows.
    pub fn typeName(ty: *const Type, a: Allocator) Allocator.Error![]const u8 {
        if (ty.count) return "count";
        return switch (ty.kind) {
            .array => "array",
            .boolean => "boolean",
            .@"enum" => |values| std.mem.join(a, "|", values),
            .integer, .number => "number",
            .string => "string",
            .object, .unknown => "value",
        };
    }
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
    string: Bounds,
    /// Any value.
    unknown,
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

/// Converts a schema to the JSON Schema Zod's `z.toJSONSchema()` emits, with the same key order.
pub fn jsonSchema(a: Allocator, ty: *const Type) Allocator.Error!Value {
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
            try out.put(a, "items", try jsonSchema(a, array.items));
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
                try properties.put(a, f.name, try jsonSchema(a, &f.ty));
                if (!f.ty.isOptional()) try required.append(a, .{ .string = f.name });
            }
            try out.put(a, "properties", properties.finish());
            if (required.items.len > 0) try out.put(a, "required", .{ .array = required.items });
            try out.put(a, "additionalProperties", .{ .bool = false });
        },
        .string => |b| {
            try out.put(a, "type", .{ .string = "string" });
            try bound(a, &out, "minLength", b.min);
            try bound(a, &out, "maxLength", b.max);
        },
        .unknown => {},
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
    if (value) |v| try out.put(a, key, .{ .number = v });
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
                try out.put(a, "values", try strings(a, values));
            },
            .too_big, .too_small => |b| {
                const key = if (issue.kind == .too_big) "maximum" else "minimum";
                // Zod's safe-integer check reports its issue with a note and a different key order.
                if (std.mem.eql(u8, b.origin, "int")) {
                    try out.put(a, "code", .{ .string = issue.code() });
                    try out.put(a, key, .{ .number = b.bound });
                    try out.put(a, "note", .{ .string = "Integers must be within the safe integer range." });
                    try out.put(a, "origin", .{ .string = b.origin });
                } else {
                    try out.put(a, "origin", .{ .string = b.origin });
                    try out.put(a, "code", .{ .string = issue.code() });
                    try out.put(a, key, .{ .number = b.bound });
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
    /// The bound.
    bound: f64,
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
    /// The value is not one of the enum values.
    invalid_value: []const []const u8,
    /// The value exceeds a maximum.
    too_big: BoundIssue,
    /// The value is under a minimum.
    too_small: BoundIssue,
};

/// The marker a coerced non-finite number carries through validation. JSON has no NaN.
pub const non_finite = "\x00incur:non-finite:";

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
            try v.issue(.{ .invalid_value = values }, message);
            return null;
        }
        const present = value orelse {
            try v.invalidType(ty, "undefined", null);
            return null;
        };
        return v.parsePresent(ty, present);
    }

    /// Validates a value that is present in the input.
    fn parsePresent(v: *Validator, ty: *const Type, value: Value) Allocator.Error!?Value {
        switch (ty.kind) {
            .array => |array| if (value == .array) {
                const out = try v.a.alloc(Value, value.array.len);
                for (value.array, out, 0..) |item, *slot, index| {
                    try v.path.append(v.a, .{ .number = @floatFromInt(index) });
                    slot.* = try v.parse(array.items, item) orelse .null;
                    _ = v.path.pop();
                }
                try v.checkBounds(@floatFromInt(value.array.len), array.bounds, "array");
                return .{ .array = out };
            },
            .boolean => if (value == .bool) return value,
            .unknown => return value,
            .integer, .number => |b| {
                const integer = ty.kind == .integer;
                if (value == .string and std.mem.startsWith(u8, value.string, non_finite)) {
                    // Zod names NaN in the message but reports infinities as numbers.
                    const nan = std.mem.eql(u8, value.string[non_finite.len..], "NaN");
                    try v.invalidType(ty, if (nan) "NaN" else "number", if (nan) "NaN" else "Infinity");
                    return null;
                }
                if (value != .number) {
                    try v.invalidType(ty, received(value), null);
                    return null;
                }
                const number = value.number;
                if (integer and @trunc(number) != number) {
                    // Only a finite fraction reports the integer format.
                    try v.issue(.{ .invalid_type = .{ .expected = "int", .format = "safeint" } }, "Invalid input: expected int, received number");
                    return null;
                }
                if (integer) {
                    const min = b.min orelse -js.max_safe_integer;
                    const max = b.max orelse js.max_safe_integer;
                    const safe = (min == -js.max_safe_integer and number < min) or (max == js.max_safe_integer and number > max);
                    try v.checkBounds(number, .{ .min = min, .max = max }, if (safe) "int" else "number");
                } else {
                    try v.checkBounds(number, b, "number");
                }
                return value;
            },
            .object => |fs| if (value == .object) {
                var out: json.ObjectBuilder = .{};
                for (fs) |*f| {
                    try v.path.append(v.a, .{ .string = f.name });
                    if (try v.parse(&f.ty, value.get(f.name))) |parsed| try out.put(v.a, f.name, parsed);
                    _ = v.path.pop();
                }
                return out.finish();
            },
            .string => |b| if (value == .string) {
                try v.checkBounds(@floatFromInt(js.utf16Len(value.string)), b, "string");
                return value;
            },
            // `parse` handles enums before reaching here.
            .@"enum" => {},
        }
        try v.invalidType(ty, received(value), null);
        return null;
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
            // Enums and unknown values never report a type mismatch.
            .@"enum", .string, .unknown => "string",
        };
        try v.issue(
            .{ .invalid_type = .{ .expected = expected, .received = reported } },
            try std.fmt.allocPrint(v.a, "Invalid input: expected {s}, received {s}", .{ expected, got }),
        );
    }

    /// Reports `too_small` and `too_big` issues.
    fn checkBounds(v: *Validator, value: f64, b: Bounds, origin: []const u8) Allocator.Error!void {
        const unit = if (std.mem.eql(u8, origin, "string")) " characters" else if (std.mem.eql(u8, origin, "array")) " items" else "";
        const verb = if (unit.len == 0) "be" else "have";
        if (b.min) |minimum| if (value < minimum) try v.issue(
            .{ .too_small = .{ .bound = minimum, .origin = origin } },
            try std.fmt.allocPrint(v.a, "Too small: expected {s} to {s} >={s}{s}", .{ origin, verb, try js.numberToString(v.a, minimum), unit }),
        );
        if (b.max) |maximum| if (value > maximum) try v.issue(
            .{ .too_big = .{ .bound = maximum, .origin = origin } },
            try std.fmt.allocPrint(v.a, "Too big: expected {s} to {s} <={s}{s}", .{ origin, verb, try js.numberToString(v.a, maximum), unit }),
        );
    }
};

/// Returns Zod's name for the type of a received value.
fn received(value: Value) []const u8 {
    return switch (value) {
        .array => "array",
        .bool => "boolean",
        .null => "null",
        .number => "number",
        .object => "object",
        .string => "string",
    };
}
