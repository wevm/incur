//! Output serialization in TOON, JSON, YAML, Markdown, and JSONL.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const toon = @import("toon.zig");
const yaml = @import("yaml.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// A supported output format.
pub const Format = enum {
    /// Token-oriented object notation, the default.
    toon,
    /// Pretty-printed JSON.
    json,
    /// YAML.
    yaml,
    /// Markdown tables and headings.
    md,
    /// One JSON value per line.
    jsonl,
};

/// Serializes a value in the given format. `null` formats as an empty string.
pub fn format(a: Allocator, value: Value, fmt: Format) Allocator.Error![]const u8 {
    if (value == .null) return "";
    return switch (fmt) {
        .json => {
            if (value == .string) {
                const trimmed = js.trim(value.string);
                if (trimmed.len > 0 and (trimmed[0] == '{' or trimmed[0] == '[')) {
                    var message: []const u8 = undefined;
                    if (json.parse(a, value.string, &message)) |parsed| {
                        return json.stringifyPretty(a, parsed);
                    } else |err| if (err == error.OutOfMemory) return error.OutOfMemory;
                }
            }
            return json.stringifyPretty(a, value);
        },
        .jsonl => {
            if (value != .array) return json.stringify(a, value);
            var lines: std.ArrayList([]const u8) = .empty;
            for (value.array) |item| try lines.append(a, try json.stringify(a, item));
            return std.mem.join(a, "\n", lines.items);
        },
        .yaml => yaml.stringify(a, value),
        .md => markdown(a, value),
        .toon => toon.encode(a, value),
    };
}

/// Whether every value of an object is a scalar.
fn isFlat(entries: []const Value.Entry) bool {
    for (entries) |entry| if (entry.value == .array or entry.value == .object) return false;
    return true;
}

/// Whether a value is a non-empty array of objects.
fn isArrayOfObjects(value: Value) bool {
    if (value != .array or value.array.len == 0) return false;
    for (value.array) |item| if (item != .object) return false;
    return true;
}

/// Renders an aligned Markdown table.
fn table(a: Allocator, headers: []const []const u8, rows: []const []const []const u8) Allocator.Error![]const u8 {
    const widths = try a.alloc(usize, headers.len);
    for (headers, widths, 0..) |h, *w, i| {
        w.* = js.utf16Len(h);
        for (rows) |row| w.* = @max(w.*, js.utf16Len(row[i]));
    }
    const cells = try a.alloc([]const u8, widths.len);
    for (headers, widths, cells) |h, w, *cell| cell.* = try js.pad(a, h, w);
    const header_row = try std.mem.join(a, " | ", cells);
    for (widths, cells) |w, *cell| cell.* = try js.repeat(a, "-", w + 2);
    const sep = try std.mem.join(a, "|", cells);
    const lines = try a.alloc([]const u8, rows.len);
    for (rows, lines) |row, *line| {
        for (widths, cells, 0..) |w, *cell, i| cell.* = try js.pad(a, row[i], w);
        line.* = try std.fmt.allocPrint(a, "| {s} |", .{try std.mem.join(a, " | ", cells)});
    }
    return std.fmt.allocPrint(a, "| {s} |\n|{s}|\n{s}", .{ header_row, sep, try std.mem.join(a, "\n", lines) });
}

/// Renders a key-value table from a flat object.
fn kvTable(a: Allocator, entries: []const Value.Entry) Allocator.Error![]const u8 {
    const rows = try a.alloc([]const []const u8, entries.len);
    for (entries, rows) |entry, *row| row.* = try a.dupe([]const u8, &.{ entry.key, try json.toString(a, entry.value) });
    return table(a, &.{ "Key", "Value" }, rows);
}

/// Renders a columnar table from an array of objects. Nested cells render as compact JSON.
fn columnarTable(a: Allocator, items: []const Value) Allocator.Error![]const u8 {
    var keys: std.ArrayList([]const u8) = .empty;
    for (items) |item| for (item.object) |entry| {
        for (keys.items) |k| {
            if (std.mem.eql(u8, k, entry.key)) break;
        } else try keys.append(a, entry.key);
    };
    const rows = try a.alloc([]const []const u8, items.len);
    for (items, rows) |item, *row| {
        const cells = try a.alloc([]const u8, keys.items.len);
        for (keys.items, cells) |k, *cell| {
            const v = item.get(k) orelse Value.null;
            cell.* = switch (v) {
                .null => "",
                // Escape pipes so the JSON stays inside its cell.
                .array, .object => try std.mem.replaceOwned(u8, a, try json.stringify(a, v), "|", "\\|"),
                else => try json.toString(a, v),
            };
        }
        row.* = cells;
    }
    return table(a, keys.items, rows);
}

/// Formats a value as Markdown: tables for flat objects and arrays of objects, and headed
/// sections for nested objects.
fn markdown(a: Allocator, value: Value) Allocator.Error![]const u8 {
    if (isArrayOfObjects(value)) return columnarTable(a, value.array);
    if (value == .object) return if (isFlat(value.object)) kvTable(a, value.object) else sections(a, value.object, &.{});
    return json.toString(a, value);
}

/// Formats each entry of a nested object as a section headed by its dotted path.
fn sections(a: Allocator, entries: []const Value.Entry, path: []const []const u8) Allocator.Error![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    for (entries) |entry| {
        const child = try std.mem.concat(a, []const u8, &.{ path, &.{entry.key} });
        const heading = try std.mem.join(a, ".", child);
        const body = switch (entry.value) {
            .object => |nested| if (isFlat(nested)) try kvTable(a, nested) else {
                try parts.append(a, try sections(a, nested, child));
                continue;
            },
            else => if (isArrayOfObjects(entry.value)) try columnarTable(a, entry.value.array) else try json.toString(a, entry.value),
        };
        try parts.append(a, try std.fmt.allocPrint(a, "## {s}\n\n{s}", .{ heading, body }));
    }
    return std.mem.join(a, "\n\n", parts.items);
}
