//! Token estimation and slicing, ported from `tokenx` 1.3.0 with its default options.

const std = @import("std");
const js = @import("js.zig");

const Allocator = std.mem.Allocator;

/// The character class that splits segments.
const Class = enum { punctuation, space, word };

/// Returns the class of a code point.
fn class(cp: u21) Class {
    if (js.isWhitespace(cp)) return .space;
    if (isPunctuation(cp)) return .punctuation;
    return .word;
}

/// Splits text into whitespace runs, punctuation runs, and words.
fn segments(a: Allocator, text: []const u8) Allocator.Error![]const []const u8 {
    var out: std.ArrayList([]const u8) = .empty;
    var it = js.Utf8.init(text);
    var start: usize = 0;
    var last: ?Class = null;
    while (true) {
        const at = it.i;
        const cp = it.next() orelse break;
        const kind = class(cp);
        // Words split from separators; separators of one class form one run.
        if (last != null and last.? != kind) {
            try out.append(a, text[start..at]);
            start = at;
        }
        last = kind;
    }
    if (start < text.len) try out.append(a, text[start..]);
    return out.items;
}

/// Matches ``/[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_-]/``.
fn isPunctuation(cp: u21) bool {
    return cp < 0x80 and std.mem.findScalar(u8, ".,!?;(){}[]<>:/\\|@#$%^&*+=`~_-", @intCast(cp)) != null;
}

/// Matches the CJK ranges `tokenx` counts one token per character.
fn isCjk(cp: u21) bool {
    return switch (cp) {
        0x4E00...0x9FFF, 0x3400...0x4DBF, 0x3000...0x303F, 0xFF00...0xFFEF, 0x30A0...0x30FF, 0x2E80...0x2EFF, 0x31C0...0x31EF, 0x3200...0x32FF, 0x3300...0x33FF, 0xAC00...0xD7AF, 0x1100...0x11FF, 0x3130...0x318F, 0xA960...0xA97F, 0xD7B0...0xD7FF => true,
        else => false,
    };
}

/// Matches `/^\d+(?:[.,]\d+)*$/`.
fn isNumeric(segment: []const u8) bool {
    var parts = std.mem.splitAny(u8, segment, ".,");
    while (parts.next()) |part| {
        if (part.len == 0) return false;
        for (part) |ch| if (!std.ascii.isDigit(ch)) return false;
    }
    return true;
}

/// Whether any lowercased code point of the segment is in `set`.
fn has(segment: []const u8, set: []const u8) bool {
    var it = js.Utf8.init(segment);
    while (it.next()) |cp| {
        var chars = js.Utf8.init(set);
        while (chars.next()) |ch| if (js.lower(cp) == ch) return true;
    }
    return false;
}

/// Estimates the tokens of one segment.
fn segmentTokens(segment: []const u8) usize {
    var all_space = true;
    var cjk = false;
    var punctuation = false;
    var chars: usize = 0;
    var it = js.Utf8.init(segment);
    while (it.next()) |cp| {
        all_space = all_space and js.isWhitespace(cp);
        cjk = cjk or isCjk(cp);
        punctuation = punctuation or isPunctuation(cp);
        chars += 1;
    }
    if (all_space) return 0;
    if (cjk) return chars;
    if (isNumeric(segment)) return 1;
    const len = js.utf16Len(segment);
    if (len <= 3) return 1;
    if (punctuation) return (len + 1) / 2;
    const ratio: f64 = if (has(segment, "äöüßẞ") or has(segment, "éèêëàâîïôûùüÿçœæáíóúñ"))
        3
    else if (has(segment, "ąćęłńóśźżěščřžýůúďťň")) 3.5 else 6;
    return @intFromFloat(@ceil(@as(f64, @floatFromInt(len)) / ratio));
}

/// Estimates the number of tokens in a string.
pub fn estimate(a: Allocator, text: []const u8) Allocator.Error!usize {
    var total: usize = 0;
    for (try segments(a, text)) |segment| total += segmentTokens(segment);
    return total;
}

/// Returns the text between token positions `start` and `end`. Negative positions count from
/// the end, as in `Array.prototype.slice`.
pub fn slice(a: Allocator, text: []const u8, start_pos: f64, end_pos: f64) Allocator.Error![]const u8 {
    const total: f64 = if (start_pos < 0 or end_pos < 0) @floatFromInt(try estimate(a, text)) else 0;
    const start = if (start_pos < 0) @max(total + start_pos, 0) else start_pos;
    const end = if (end_pos < 0) @max(total + end_pos, 0) else end_pos;
    if (start >= end) return "";
    var out: std.ArrayList(u8) = .empty;
    var position: f64 = 0;
    for (try segments(a, text)) |segment| {
        if (position >= end) break;
        const count: f64 = @floatFromInt(segmentTokens(segment));
        try out.appendSlice(a, try extract(a, segment, position, count, start, end));
        position += count;
    }
    return out.items;
}

/// Extracts the part of a segment that overlaps the target token range.
fn extract(a: Allocator, segment: []const u8, seg_start: f64, count: f64, start: f64, end: f64) Allocator.Error![]const u8 {
    if (count == 0) return if (seg_start >= start and seg_start < end) segment else "";
    const seg_end = seg_start + count;
    if (seg_start >= end or seg_end <= start) return "";
    const overlap_start = @max(start - seg_start, 0);
    const overlap_end = @min(count, end - seg_start);
    if (overlap_start == 0 and overlap_end == count) return segment;
    const units = try js.toUtf16(a, segment);
    const len: f64 = @floatFromInt(units.len);
    const from: usize = @intFromFloat(@floor(overlap_start / count * len));
    const to: usize = @intFromFloat(@ceil(overlap_end / count * len));
    return js.sliceUtf16(a, units, from, to);
}
