//! JSON values: exact integers, insertion-ordered objects that list integer-like keys first as
//! JavaScript objects do, `JSON.stringify` output, and `JSON.parse` with V8's error messages.

const std = @import("std");
const js = @import("js.zig");

const Allocator = std.mem.Allocator;

/// A JSON value. Arrays and objects are immutable slices; build objects with `ObjectBuilder`.
///
/// Integers keep their exact value in every output format. Floats format as JavaScript's
/// `String(number)` does, so `1e21` prints as `1e+21` and `0.1` as `0.1`.
pub const Value = union(enum) {
    /// `null`.
    null,
    /// `true` or `false`.
    bool: bool,
    /// An integer.
    integer: i128,
    /// An integer outside the `i128` range, as decimal digits with an optional leading `-`.
    big_integer: []const u8,
    /// A floating-point number. Non-finite floats stringify as `null`, as in `JSON.stringify`.
    float: f64,
    /// A UTF-8 string. Unpaired surrogates, which JSON escapes can produce, are stored as WTF-8.
    string: []const u8,
    /// An array.
    array: []const Value,
    /// An object, in key order.
    object: []const Entry,

    /// An object property.
    pub const Entry = struct {
        /// The key.
        key: []const u8,
        /// The value.
        value: Value,
    };

    /// Returns a float value, or `null` for non-finite floats, as `JSON.stringify` does.
    pub fn fromFloat(float: f64) Value {
        return if (std.math.isFinite(float)) .{ .float = float } else .null;
    }

    /// Returns an integer value of any integer type.
    pub fn fromInt(a: Allocator, int: anytype) Allocator.Error!Value {
        if (std.math.cast(i128, int)) |small| return .{ .integer = small };
        return .{ .big_integer = try std.fmt.allocPrint(a, "{d}", .{int}) };
    }

    /// Returns a number as an `f64`, rounding integers to the nearest float, or null for
    /// non-numbers.
    pub fn toFloat(value: Value) ?f64 {
        return switch (value) {
            .integer => |i| @floatFromInt(i),
            .big_integer => |digits| std.fmt.parseFloat(f64, digits) catch unreachable,
            .float => |f| f,
            else => null,
        };
    }

    /// Returns the value of an object property, or null for missing keys and non-objects.
    pub fn get(value: Value, key: []const u8) ?Value {
        if (value != .object) return null;
        for (value.object) |entry| if (std.mem.eql(u8, entry.key, key)) return entry.value;
        return null;
    }
};

/// Builds an object, keeping the position of a key that is set again, as JavaScript does.
pub const ObjectBuilder = struct {
    /// The entries so far.
    entries: std.ArrayList(Value.Entry) = .empty,

    /// Sets a property, replacing an existing value in place.
    pub fn put(builder: *ObjectBuilder, a: Allocator, key: []const u8, value: Value) Allocator.Error!void {
        for (builder.entries.items) |*entry| if (std.mem.eql(u8, entry.key, key)) {
            entry.value = value;
            return;
        };
        try builder.entries.append(a, .{ .key = key, .value = value });
    }

    /// Returns the object value.
    pub fn finish(builder: ObjectBuilder) Value {
        return .{ .object = builder.entries.items };
    }
};

/// Serializes a value as `JSON.stringify(value)` does.
pub fn stringify(a: Allocator, value: Value) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try write(a, &out, value, null, "");
    return out.items;
}

/// Serializes a value as `JSON.stringify(value, null, 2)` does.
pub fn stringifyPretty(a: Allocator, value: Value) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try write(a, &out, value, "  ", "");
    return out.items;
}

/// Writes JSON with an optional indentation step.
fn write(a: Allocator, out: *std.ArrayList(u8), value: Value, step: ?[]const u8, indent: []const u8) Allocator.Error!void {
    switch (value) {
        .null => try out.appendSlice(a, "null"),
        .bool => |b| try out.appendSlice(a, if (b) "true" else "false"),
        .integer => |i| try out.print(a, "{d}", .{i}),
        .big_integer => |digits| try out.appendSlice(a, digits),
        .float => |f| try out.appendSlice(a, if (std.math.isFinite(f)) try js.numberToString(a, f) else "null"),
        .string => |s| try quote(a, out, s),
        .array, .object => {
            const is_array = value == .array;
            const len = if (is_array) value.array.len else value.object.len;
            if (len == 0) return out.appendSlice(a, if (is_array) "[]" else "{}");
            try out.append(a, if (is_array) '[' else '{');
            const inner = if (step) |s| try std.mem.concat(a, u8, &.{ indent, s }) else "";
            for (0..len) |i| {
                if (i > 0) try out.append(a, ',');
                if (step != null) {
                    try out.append(a, '\n');
                    try out.appendSlice(a, inner);
                }
                if (is_array) {
                    try write(a, out, value.array[i], step, inner);
                } else {
                    try quote(a, out, value.object[i].key);
                    try out.append(a, ':');
                    if (step != null) try out.append(a, ' ');
                    try write(a, out, value.object[i].value, step, inner);
                }
            }
            if (step != null) {
                try out.append(a, '\n');
                try out.appendSlice(a, indent);
            }
            try out.append(a, if (is_array) ']' else '}');
        },
    }
}

/// Writes a JSON string literal with `JSON.stringify` escaping, which escapes unpaired
/// surrogates as `\\uXXXX`.
fn quote(a: Allocator, out: *std.ArrayList(u8), text: []const u8) Allocator.Error!void {
    try out.append(a, '"');
    var it = js.Utf8.init(text);
    while (it.next()) |cp| switch (cp) {
        '"' => try out.appendSlice(a, "\\\""),
        '\\' => try out.appendSlice(a, "\\\\"),
        0x08 => try out.appendSlice(a, "\\b"),
        0x0c => try out.appendSlice(a, "\\f"),
        '\n' => try out.appendSlice(a, "\\n"),
        '\r' => try out.appendSlice(a, "\\r"),
        '\t' => try out.appendSlice(a, "\\t"),
        0...0x07, 0x0b, 0x0e...0x1f, 0xd800...0xdfff => try out.print(a, "\\u{x:0>4}", .{cp}),
        else => {
            var buf: [4]u8 = undefined;
            try out.appendSlice(a, buf[0 .. std.unicode.utf8Encode(cp, &buf) catch unreachable]);
        },
    };
    try out.append(a, '"');
}

/// Formats a value as `String(value)` does.
pub fn toString(a: Allocator, value: Value) Allocator.Error![]const u8 {
    return switch (value) {
        .null => "null",
        .bool => |b| if (b) "true" else "false",
        .integer => |i| std.fmt.allocPrint(a, "{d}", .{i}),
        .big_integer => |digits| digits,
        .float => |f| js.numberToString(a, f),
        .string => |s| s,
        .array => |items| {
            var parts: std.ArrayList([]const u8) = .empty;
            for (items) |item| try parts.append(a, if (item == .null) "" else try toString(a, item));
            return std.mem.join(a, ",", parts.items);
        },
        .object => "[object Object]",
    };
}

/// Reorders object keys as JavaScript objects store them: integer-like keys first in ascending
/// order, then other keys in insertion order. Applies recursively.
pub fn normalize(a: Allocator, value: Value) Allocator.Error!Value {
    switch (value) {
        .array => |items| {
            const out = try a.alloc(Value, items.len);
            for (items, out) |item, *slot| slot.* = try normalize(a, item);
            return .{ .array = out };
        },
        .object => |entries| {
            var indices: std.ArrayList(Value.Entry) = .empty;
            var rest: std.ArrayList(Value.Entry) = .empty;
            for (entries) |entry| {
                const item: Value.Entry = .{ .key = entry.key, .value = try normalize(a, entry.value) };
                try (if (js.arrayIndex(entry.key) != null) &indices else &rest).append(a, item);
            }
            std.mem.sort(Value.Entry, indices.items, {}, struct {
                fn lessThan(_: void, x: Value.Entry, y: Value.Entry) bool {
                    return js.arrayIndex(x.key).? < js.arrayIndex(y.key).?;
                }
            }.lessThan);
            try indices.appendSlice(a, rest.items);
            return .{ .object = indices.items };
        },
        else => return value,
    }
}

/// A JSON syntax error with V8's message.
pub const ParseError = error{SyntaxError} || Allocator.Error;

/// Parses JSON text as `JSON.parse` does, with object keys in JavaScript order. On a syntax error,
/// stores V8's message in `message`.
pub fn parse(a: Allocator, source: []const u8, message: *[]const u8) ParseError!Value {
    var parser: Parser = .{ .a = a, .units = try js.toUtf16(a, source), .source = source };
    const value = parser.value() catch |err| return parser.fail(err, message);
    parser.whitespace();
    if (parser.peek()) |ch| {
        const err = if (ch >= '0' and ch <= '9')
            parser.at("Unexpected number in JSON")
        else
            parser.at("Unexpected non-whitespace character after JSON");
        return parser.fail(err, message);
    }
    return normalize(a, value);
}

/// Internal parse failures.
const Failure = error{
    /// The input ended early.
    End,
    /// A located message, stored in `Parser.located`.
    Located,
    /// An unexpected character at the current position.
    Token,
} || Allocator.Error;

/// A JSON parser over UTF-16 code units that reports failures the way V8 does.
const Parser = struct {
    a: Allocator,
    units: []const u16,
    source: []const u8,
    pos: usize = 0,
    located: []const u8 = "",

    fn peek(p: *Parser) ?u16 {
        return if (p.pos < p.units.len) p.units[p.pos] else null;
    }

    fn is(p: *Parser, ch: u8) bool {
        return p.peek() == ch;
    }

    fn digit(p: *Parser) bool {
        const ch = p.peek() orelse return false;
        return ch >= '0' and ch <= '9';
    }

    fn whitespace(p: *Parser) void {
        while (p.peek()) |ch| switch (ch) {
            ' ', '\t', '\n', '\r' => p.pos += 1,
            else => return,
        };
    }

    /// Records a message located at the current position.
    fn at(p: *Parser, text: []const u8) Failure {
        const before = p.units[0..p.pos];
        const line = std.mem.count(u16, before, &.{'\n'}) + 1;
        const column = p.pos - (if (std.mem.findScalarLast(u16, before, '\n')) |i| i + 1 else 0) + 1;
        p.located = try std.fmt.allocPrint(p.a, "{s} at position {d} (line {d} column {d})", .{ text, p.pos, line, column });
        return error.Located;
    }

    /// Converts a failure to V8's message.
    fn fail(p: *Parser, err: Failure, message: *[]const u8) ParseError {
        message.* = switch (err) {
            error.OutOfMemory => return error.OutOfMemory,
            error.End => "Unexpected end of JSON input",
            error.Located => p.located,
            error.Token => token: {
                const token = try js.fromUtf16(p.a, p.units[p.pos .. p.pos + 1]);
                const context = if (p.units.len < 21)
                    try std.fmt.allocPrint(p.a, "\"{s}\"", .{p.source})
                else context: {
                    const start = p.pos -| 10;
                    const end = @min(p.pos + 10, p.units.len);
                    break :context try std.fmt.allocPrint(p.a, "{s}\"{s}\"{s}", .{
                        if (start > 0) "..." else "",
                        try js.fromUtf16(p.a, p.units[start..end]),
                        if (end < p.units.len) "..." else "",
                    });
                };
                break :token try std.fmt.allocPrint(p.a, "Unexpected token '{s}', {s} is not valid JSON", .{ token, context });
            },
        };
        return error.SyntaxError;
    }

    fn value(p: *Parser) Failure!Value {
        p.whitespace();
        const ch = p.peek() orelse return error.End;
        return switch (ch) {
            '{' => p.object(),
            '[' => p.array(),
            '"' => .{ .string = try p.string() },
            '-', '0'...'9' => p.number(),
            't' => p.literal("true", .{ .bool = true }),
            'f' => p.literal("false", .{ .bool = false }),
            'n' => p.literal("null", .null),
            else => error.Token,
        };
    }

    fn object(p: *Parser) Failure!Value {
        p.pos += 1;
        p.whitespace();
        var builder: ObjectBuilder = .{};
        if (p.is('}')) {
            p.pos += 1;
            return builder.finish();
        }
        var first = true;
        while (true) {
            if (!p.is('"')) return p.at(if (first) "Expected property name or '}' in JSON" else "Expected double-quoted property name in JSON");
            first = false;
            const key = try p.string();
            p.whitespace();
            if (!p.is(':')) return p.at("Expected ':' after property name in JSON");
            p.pos += 1;
            try builder.put(p.a, key, try p.value());
            p.whitespace();
            if (p.is(',')) {
                p.pos += 1;
                p.whitespace();
            } else if (p.is('}')) {
                p.pos += 1;
                return builder.finish();
            } else return p.at("Expected ',' or '}' after property value in JSON");
        }
    }

    fn array(p: *Parser) Failure!Value {
        p.pos += 1;
        p.whitespace();
        var items: std.ArrayList(Value) = .empty;
        if (p.is(']')) {
            p.pos += 1;
            return .{ .array = items.items };
        }
        while (true) {
            try items.append(p.a, try p.value());
            p.whitespace();
            if (p.is(',')) {
                p.pos += 1;
            } else if (p.is(']')) {
                p.pos += 1;
                return .{ .array = items.items };
            } else return p.at("Expected ',' or ']' after array element in JSON");
        }
    }

    fn string(p: *Parser) Failure![]const u8 {
        p.pos += 1;
        var out: std.ArrayList(u16) = .empty;
        while (true) {
            const ch = p.peek() orelse return p.at("Unterminated string in JSON");
            if (ch == '"') {
                p.pos += 1;
                return js.fromUtf16(p.a, out.items);
            }
            if (ch < 0x20) return p.at("Bad control character in string literal in JSON");
            if (ch != '\\') {
                try out.append(p.a, ch);
                p.pos += 1;
                continue;
            }
            p.pos += 1;
            const escape = p.peek() orelse 0;
            const decoded: u16 = switch (escape) {
                'u' => code: {
                    var code: u16 = 0;
                    for (0..4) |_| {
                        p.pos += 1;
                        const hex = p.peek() orelse 0;
                        const nibble = if (hex < 0x80) std.fmt.charToDigit(@intCast(hex), 16) catch null else null;
                        code = code * 16 + (nibble orelse return p.at("Bad Unicode escape in JSON"));
                    }
                    break :code code;
                },
                '"', '\\', '/' => escape,
                'b' => 0x08,
                'f' => 0x0c,
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                else => return p.at("Bad escaped character in JSON"),
            };
            try out.append(p.a, decoded);
            p.pos += 1;
        }
    }

    fn number(p: *Parser) Failure!Value {
        const start = p.pos;
        if (p.is('-')) {
            p.pos += 1;
            if (!p.digit()) return p.at("No number after minus sign in JSON");
        }
        if (p.is('0')) p.pos += 1 else while (p.digit()) p.pos += 1;
        const integer = !p.is('.') and !p.is('e') and !p.is('E');
        if (p.is('.')) {
            p.pos += 1;
            if (!p.digit()) return p.at("Unterminated fractional number in JSON");
            while (p.digit()) p.pos += 1;
        }
        if (p.is('e') or p.is('E')) {
            p.pos += 1;
            if (p.is('+') or p.is('-')) p.pos += 1;
            if (!p.digit()) return p.at("Exponent part is missing a number in JSON");
            while (p.digit()) p.pos += 1;
        }
        // Number characters are ASCII, so code unit offsets are byte offsets of the text.
        const text = try js.fromUtf16(p.a, p.units[start..p.pos]);
        // Integers stay exact. JavaScript has no negative zero integer, so `-0` is a float.
        if (integer and !std.mem.eql(u8, text, "-0")) {
            if (std.fmt.parseInt(i128, text, 10)) |int| return .{ .integer = int } else |_| return .{ .big_integer = text };
        }
        return .{ .float = std.fmt.parseFloat(f64, text) catch unreachable };
    }

    fn literal(p: *Parser, word: []const u8, result: Value) Failure!Value {
        for (word) |expected| {
            const ch = p.peek() orelse return error.End;
            if (ch != expected) return error.Token;
            p.pos += 1;
        }
        return result;
    }
};
