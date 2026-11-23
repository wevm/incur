//! Output filtering with `--filter-output` key paths such as `foo,bar.baz,a[0,3]`.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// One step of a filter path.
pub const Segment = union(enum) {
    /// An object key.
    key: []const u8,
    /// An array slice from `start` (inclusive) to `end` (exclusive).
    slice: struct {
        /// Start index.
        start: f64,
        /// End index.
        end: f64,
    },
};

/// A filter path.
pub const Path = []const Segment;

/// Parses a filter expression into paths.
pub fn parse(a: Allocator, expression: []const u8) Allocator.Error![]const Path {
    var tokens: std.ArrayList([]const u8) = .empty;
    var depth: i32 = 0;
    var start: usize = 0;
    for (expression, 0..) |ch, i| {
        if (ch == '[') depth += 1;
        if (ch == ']') depth -= 1;
        if (ch == ',' and depth == 0) {
            try tokens.append(a, expression[start..i]);
            start = i + 1;
        }
    }
    if (start < expression.len) try tokens.append(a, expression[start..]);

    const paths = try a.alloc(Path, tokens.items.len);
    for (tokens.items, paths) |token, *slot| {
        var path: std.ArrayList(Segment) = .empty;
        var remaining = token;
        while (remaining.len > 0) {
            const open = std.mem.findScalar(u8, remaining, '[') orelse {
                try keys(a, remaining, &path);
                break;
            };
            try keys(a, remaining[0..open], &path);
            const close = if (std.mem.findScalar(u8, remaining[open..], ']')) |i| open + i else null;
            var bounds = std.mem.splitScalar(u8, remaining[open + 1 .. close orelse remaining.len], ',');
            const first = js.toNumber(bounds.first());
            const end = if (bounds.next()) |b| js.toNumber(b) else std.math.nan(f64);
            try path.append(a, .{ .slice = .{ .start = first, .end = end } });
            remaining = if (close) |c| remaining[c + 1 ..] else "";
            if (std.mem.startsWith(u8, remaining, ".")) remaining = remaining[1..];
        }
        slot.* = path.items;
    }
    return paths;
}

/// Appends the non-empty dot-separated keys of `text`.
fn keys(a: Allocator, text: []const u8, path: *std.ArrayList(Segment)) Allocator.Error!void {
    var parts = std.mem.tokenizeScalar(u8, text, '.');
    while (parts.next()) |part| try path.append(a, .{ .key = part });
}

/// Applies filter paths to a value and returns the filtered copy. Null means `undefined`.
pub fn apply(a: Allocator, data: Value, paths: []const Path) Allocator.Error!?Value {
    if (paths.len == 0) return data;
    if (paths.len == 1 and paths[0].len == 1 and paths[0][0] == .key) {
        const key = paths[0][0].key;
        return switch (data) {
            .array => try mapItems(a, data.array, paths),
            .object => {
                const value = get(data, key) orelse return null;
                if (value != .object and value != .array) return value;
                return .{ .object = try a.dupe(Value.Entry, &.{.{ .key = key, .value = value }}) };
            },
            else => null,
        };
    }
    if (data == .array) return try mapItems(a, data.array, paths);
    var out: Node = .{ .object = .empty };
    for (paths) |path| try merge(a, &out, data, path, 0);
    return try out.freeze(a);
}

/// Applies paths to each item of an array.
fn mapItems(a: Allocator, items: []const Value, paths: []const Path) Allocator.Error!Value {
    const out = try a.alloc(Value, items.len);
    for (items, out) |item, *slot| slot.* = try apply(a, item, paths) orelse .null;
    return .{ .array = out };
}

/// A mutable copy of a value under construction.
const Node = union(enum) {
    /// An immutable value.
    value: Value,
    /// An object being built.
    object: std.ArrayList(Entry),
    /// An array being built.
    array: std.ArrayList(Node),

    const Entry = struct { key: []const u8, node: Node };

    /// Converts the node to an immutable value.
    fn freeze(node: Node, a: Allocator) Allocator.Error!Value {
        switch (node) {
            .value => |v| return v,
            .object => |entries| {
                const out = try a.alloc(Value.Entry, entries.items.len);
                for (entries.items, out) |entry, *slot| slot.* = .{ .key = entry.key, .value = try entry.node.freeze(a) };
                return .{ .object = out };
            },
            .array => |items| {
                const out = try a.alloc(Value, items.items.len);
                for (items.items, out) |item, *slot| slot.* = try item.freeze(a);
                return .{ .array = out };
            },
        }
    }

    /// Converts an immutable object or array into a mutable node in place.
    fn thaw(node: *Node, a: Allocator) Allocator.Error!void {
        const value = node.value;
        if (value == .object) {
            var entries: std.ArrayList(Entry) = .empty;
            for (value.object) |entry| try entries.append(a, .{ .key = entry.key, .node = .{ .value = entry.value } });
            node.* = .{ .object = entries };
        } else {
            var items: std.ArrayList(Node) = .empty;
            for (value.array) |item| try items.append(a, .{ .value = item });
            node.* = .{ .array = items };
        }
    }

    /// Returns a mutable object property or array element.
    fn child(node: *Node, key: []const u8) ?*Node {
        switch (node.*) {
            .object => |entries| for (entries.items) |*entry| {
                if (std.mem.eql(u8, entry.key, key)) return &entry.node;
            },
            else => if (index(key)) |i| if (i < node.array.items.len) return &node.array.items[i],
        }
        return null;
    }

    /// Writes a property as JavaScript does. Arrays take indices, filling holes with `null`, and
    /// `length`; other array properties are not serialized, so they are dropped.
    fn set(node: *Node, a: Allocator, key: []const u8, value: Node) Allocator.Error!void {
        switch (node.*) {
            .object => |*entries| {
                for (entries.items) |*entry| if (std.mem.eql(u8, entry.key, key)) {
                    entry.node = value;
                    return;
                };
                try entries.append(a, .{ .key = key, .node = value });
            },
            else => {
                const items = &node.array;
                if (index(key)) |i| {
                    while (items.items.len <= i) try items.append(a, .{ .value = .null });
                    items.items[i] = value;
                } else if (std.mem.eql(u8, key, "length") and value == .value and value.value == .integer) {
                    // Filters read `length` from the same array, so it is a valid length.
                    const len: usize = @intCast(value.value.integer);
                    while (items.items.len < len) try items.append(a, .{ .value = .null });
                    items.shrinkRetainingCapacity(len);
                }
            },
        }
    }
};

/// Whether a node is an object or array, mutable or not.
fn isCollection(node: Node) bool {
    return switch (node) {
        .value => |v| v == .object or v == .array,
        else => true,
    };
}

/// Slices an array as `Array.prototype.slice` does.
fn slice(items: []const Value, start: f64, end: f64) []const Value {
    const from = js.relativeIndex(start, items.len);
    const to = js.relativeIndex(end, items.len);
    return items[from..@max(from, to)];
}

/// Copies the value at `segments[at..]` from `data` into `target`, an object or array.
fn merge(a: Allocator, target: *Node, data: Value, segments: Path, at: usize) Allocator.Error!void {
    if (at >= segments.len or segments[at] != .key) return;
    const key = segments[at].key;
    const value = get(data, key) orelse return;
    if (at + 1 == segments.len) return target.set(a, key, .{ .value = value });
    switch (segments[at + 1]) {
        .slice => |s| {
            if (value != .array) return;
            const sliced = slice(value.array, s.start, s.end);
            if (at + 2 >= segments.len) return target.set(a, key, .{ .value = .{ .array = sliced } });
            var mapped: std.ArrayList(Node) = .empty;
            for (sliced) |item| {
                var sub: Node = .{ .object = .empty };
                try merge(a, &sub, item, segments, at + 2);
                try mapped.append(a, sub);
            }
            try target.set(a, key, .{ .array = mapped });
        },
        .key => {
            if (value != .object and value != .array) return;
            // Existing objects and arrays are reused; anything else is replaced.
            const existing = target.child(key);
            if (existing == null or !isCollection(existing.?.*)) try target.set(a, key, .{ .object = .empty });
            const entry = target.child(key).?;
            if (entry.* == .value) try entry.thaw(a);
            try merge(a, entry, value, segments, at + 1);
        },
    }
}

/// Reads a property as JavaScript does: object keys, and the indices and `length` of arrays.
fn get(data: Value, key: []const u8) ?Value {
    if (data != .array) return data.get(key);
    if (std.mem.eql(u8, key, "length")) return .{ .integer = data.array.len };
    const i = index(key) orelse return null;
    return if (i < data.array.len) data.array[i] else null;
}

/// Parses a canonical array index.
fn index(key: []const u8) ?usize {
    return if (js.arrayIndex(key)) |i| i else null;
}
