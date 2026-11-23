//! TOON encoding, ported from `@toon-format/toon` 2.3.1 with its default options: two-space
//! indentation, comma delimiters, and no key folding.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Lines = std.ArrayList([]const u8);

/// Encodes a JSON value as TOON. Scalars format as `String(value)`, as incur's formatter does.
pub fn encode(a: Allocator, value: Value) Allocator.Error![]const u8 {
    var lines: Lines = .empty;
    switch (value) {
        .array => |items| try arrayLines(a, &lines, null, items, 0),
        .object => |entries| try objectLines(a, &lines, entries, 0),
        else => return json.toString(a, value),
    }
    return std.mem.join(a, "\n", lines.items);
}

/// Whether a value is a JSON primitive.
fn isPrimitive(value: Value) bool {
    return value != .array and value != .object;
}

/// Whether every item is a primitive.
fn allPrimitive(items: []const Value) bool {
    for (items) |item| if (!isPrimitive(item)) return false;
    return true;
}

/// Encodes a primitive value.
fn primitive(a: Allocator, value: Value) Allocator.Error![]const u8 {
    if (value == .string) {
        if (isSafeUnquoted(value.string)) return value.string;
        return std.fmt.allocPrint(a, "\"{s}\"", .{try escape(a, value.string)});
    }
    return json.toString(a, value);
}

/// Escapes backslashes, quotes, and control characters.
fn escape(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (text) |ch| switch (ch) {
        '\\' => try out.appendSlice(a, "\\\\"),
        '"' => try out.appendSlice(a, "\\\""),
        '\n' => try out.appendSlice(a, "\\n"),
        '\r' => try out.appendSlice(a, "\\r"),
        '\t' => try out.appendSlice(a, "\\t"),
        0...0x08, 0x0b...0x0c, 0x0e...0x1f => try out.print(a, "\\u{x:0>4}", .{ch}),
        else => try out.append(a, ch),
    };
    return out.items;
}

/// Whether a string encodes unquoted without changing meaning.
fn isSafeUnquoted(text: []const u8) bool {
    if (text.len == 0 or text.len != js.trim(text).len) return false;
    if (std.mem.eql(u8, text, "true") or std.mem.eql(u8, text, "false") or std.mem.eql(u8, text, "null")) return false;
    if (isNumericLike(text)) return false;
    for (text) |ch| switch (ch) {
        ':', '"', '\\', '[', ']', '{', '}', ',', 0...0x1f => return false,
        else => {},
    };
    return text[0] != '-';
}

/// Whether a string is non-empty ASCII digits.
fn allDigits(text: []const u8) bool {
    if (text.len == 0) return false;
    for (text) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

/// Matches `/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i` or `/^0\d+$/`.
fn isNumericLike(text: []const u8) bool {
    const body = if (std.mem.startsWith(u8, text, "-")) text[1..] else text;
    const e = std.mem.findAny(u8, body, "eE");
    const mantissa = body[0 .. e orelse body.len];
    const mantissa_ok = if (std.mem.findScalar(u8, mantissa, '.')) |dot|
        allDigits(mantissa[0..dot]) and allDigits(mantissa[dot + 1 ..])
    else
        allDigits(mantissa);
    const exponent_ok = if (e) |index| exp: {
        const exp = body[index + 1 ..];
        break :exp allDigits(if (exp.len > 0 and (exp[0] == '+' or exp[0] == '-')) exp[1..] else exp);
    } else true;
    return mantissa_ok and exponent_ok;
}

/// Encodes a key, quoting it unless it matches `/^[A-Z_][\w.]*$/i`.
fn key(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    const valid = text.len > 0 and (std.ascii.isAlphabetic(text[0]) or text[0] == '_') and for (text) |ch| {
        if (!std.ascii.isAlphanumeric(ch) and ch != '_' and ch != '.') break false;
    } else true;
    if (valid) return text;
    return std.fmt.allocPrint(a, "\"{s}\"", .{try escape(a, text)});
}

/// Formats an array header such as `key[2]{a,b}:`.
fn header(a: Allocator, length: usize, key_name: ?[]const u8, fields: ?[]const []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    if (key_name) |name| try out.appendSlice(a, try key(a, name));
    try out.print(a, "[{d}]", .{length});
    if (fields) |fs| {
        var keys: std.ArrayList([]const u8) = .empty;
        for (fs) |f| try keys.append(a, try key(a, f));
        try out.print(a, "{{{s}}}", .{try std.mem.join(a, ",", keys.items)});
    }
    try out.append(a, ':');
    return out.items;
}

/// Joins encoded primitives with the delimiter.
fn join(a: Allocator, values: []const Value) Allocator.Error![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    for (values) |value| try parts.append(a, try primitive(a, value));
    return std.mem.join(a, ",", parts.items);
}

/// Appends a line indented by `depth` levels.
fn line(a: Allocator, lines: *Lines, depth: usize, content: []const u8) Allocator.Error!void {
    try lines.append(a, try std.mem.concat(a, u8, &.{ try js.repeat(a, "  ", depth), content }));
}

/// Appends a list item indented by `depth` levels.
fn listLine(a: Allocator, lines: *Lines, depth: usize, content: []const u8) Allocator.Error!void {
    try line(a, lines, depth, try std.mem.concat(a, u8, &.{ "- ", content }));
}

/// Encodes every key-value pair of an object.
fn objectLines(a: Allocator, lines: *Lines, entries: []const Value.Entry, depth: usize) Allocator.Error!void {
    for (entries) |entry| {
        const encoded = try key(a, entry.key);
        switch (entry.value) {
            .array => |items| try arrayLines(a, lines, entry.key, items, depth),
            .object => |nested| {
                try line(a, lines, depth, try std.fmt.allocPrint(a, "{s}:", .{encoded}));
                try objectLines(a, lines, nested, depth + 1);
            },
            else => try line(a, lines, depth, try std.fmt.allocPrint(a, "{s}: {s}", .{ encoded, try primitive(a, entry.value) })),
        }
    }
}

/// Encodes an inline array of primitives.
fn inlineArray(a: Allocator, values: []const Value, key_name: ?[]const u8) Allocator.Error![]const u8 {
    const head = try header(a, values.len, key_name, null);
    if (values.len == 0) return head;
    return std.fmt.allocPrint(a, "{s} {s}", .{ head, try join(a, values) });
}

/// Encodes an array under an optional key.
fn arrayLines(a: Allocator, lines: *Lines, key_name: ?[]const u8, items: []const Value, depth: usize) Allocator.Error!void {
    if (items.len == 0) {
        const content = if (key_name) |name| try std.fmt.allocPrint(a, "{s}: []", .{try key(a, name)}) else "[]";
        return line(a, lines, depth, content);
    }
    if (allPrimitive(items)) return line(a, lines, depth, try inlineArray(a, items, key_name));
    const arrays = for (items) |value| {
        if (value != .array or !allPrimitive(value.array)) break false;
    } else true;
    if (arrays) {
        try line(a, lines, depth, try header(a, items.len, key_name, null));
        for (items) |value| try listLine(a, lines, depth + 1, try inlineArray(a, value.array, null));
        return;
    }
    if (try tabularHeader(a, items)) |fields| {
        try line(a, lines, depth, try header(a, items.len, key_name, fields));
        return rows(a, lines, items, fields, depth + 1);
    }
    try line(a, lines, depth, try header(a, items.len, key_name, null));
    for (items) |value| try listItem(a, lines, value, depth + 1);
}

/// Returns the shared keys when every item is an object of the same primitive-valued keys.
fn tabularHeader(a: Allocator, items: []const Value) Allocator.Error!?[]const []const u8 {
    const first = items[0];
    if (first != .object or first.object.len == 0) return null;
    const fields = try a.alloc([]const u8, first.object.len);
    for (first.object, fields) |entry, *slot| slot.* = entry.key;
    for (items) |value| {
        if (value != .object or value.object.len != fields.len) return null;
        for (fields) |f| {
            const v = value.get(f) orelse return null;
            if (!isPrimitive(v)) return null;
        }
    }
    return fields;
}

/// Writes tabular rows.
fn rows(a: Allocator, lines: *Lines, items: []const Value, fields: []const []const u8, depth: usize) Allocator.Error!void {
    for (items) |value| {
        const values = try a.alloc(Value, fields.len);
        for (fields, values) |f, *slot| slot.* = value.get(f).?;
        try line(a, lines, depth, try join(a, values));
    }
}

/// Encodes one item of a mixed list.
fn listItem(a: Allocator, lines: *Lines, value: Value, depth: usize) Allocator.Error!void {
    switch (value) {
        .array => |inner| if (allPrimitive(inner)) {
            try listLine(a, lines, depth, try inlineArray(a, inner, null));
        } else {
            try listLine(a, lines, depth, try header(a, inner.len, null, null));
            for (inner) |v| try listItem(a, lines, v, depth + 1);
        },
        .object => |entries| try objectItem(a, lines, entries, depth),
        else => try listLine(a, lines, depth, try primitive(a, value)),
    }
}

/// Encodes an object as a list item, with its first field on the marker line.
fn objectItem(a: Allocator, lines: *Lines, entries: []const Value.Entry, depth: usize) Allocator.Error!void {
    if (entries.len == 0) return line(a, lines, depth, "-");
    const first = entries[0];
    const encoded = try key(a, first.key);
    switch (first.value) {
        .array => |items| {
            const objects = items.len > 0 and for (items) |v| {
                if (v != .object) break false;
            } else true;
            if (objects) {
                if (try tabularHeader(a, items)) |fields| {
                    try listLine(a, lines, depth, try header(a, items.len, first.key, fields));
                    try rows(a, lines, items, fields, depth + 2);
                } else {
                    try listLine(a, lines, depth, try std.mem.concat(a, u8, &.{ encoded, try header(a, items.len, null, null) }));
                    for (items) |v| try listItem(a, lines, v, depth + 2);
                }
            } else if (items.len == 0) {
                try listLine(a, lines, depth, try std.fmt.allocPrint(a, "{s}: []", .{encoded}));
            } else if (allPrimitive(items)) {
                try listLine(a, lines, depth, try std.mem.concat(a, u8, &.{ encoded, try inlineArray(a, items, null) }));
            } else {
                try listLine(a, lines, depth, try std.mem.concat(a, u8, &.{ encoded, try header(a, items.len, null, null) }));
                for (items) |v| try listItem(a, lines, v, depth + 2);
            }
        },
        .object => |nested| {
            try listLine(a, lines, depth, try std.fmt.allocPrint(a, "{s}:", .{encoded}));
            try objectLines(a, lines, nested, depth + 2);
        },
        else => try listLine(a, lines, depth, try std.fmt.allocPrint(a, "{s}: {s}", .{ encoded, try primitive(a, first.value) })),
    }
    try objectLines(a, lines, entries[1..], depth + 1);
}
