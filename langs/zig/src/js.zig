//! JavaScript string and number semantics that reach output.
//!
//! The TypeScript package formats values with `String(number)`, `Number(string)`, and
//! `localeCompare`, and measures strings in UTF-16 code units. Every module that formats output
//! reuses these functions, so the Zig port prints the same bytes.

const std = @import("std");

const Allocator = std.mem.Allocator;

/// The largest integer a JavaScript number represents exactly.
pub const max_safe_integer: f64 = 9_007_199_254_740_991.0;

/// Formats a number as ECMAScript `Number.prototype.toString` does.
pub fn numberToString(a: Allocator, value: f64) Allocator.Error![]const u8 {
    if (std.math.isNan(value)) return "NaN";
    if (std.math.isInf(value)) return if (value > 0) "Infinity" else "-Infinity";
    if (value == 0) return "0";
    // `{e}` prints the shortest round-trip digits as `d.ddde±x`.
    var buf: [64]u8 = undefined;
    const sci = std.fmt.bufPrint(&buf, "{e}", .{@abs(value)}) catch unreachable;
    const e = std.mem.findScalar(u8, sci, 'e').?;
    var digits: [32]u8 = undefined;
    var k: usize = 0;
    for (sci[0..e]) |ch| {
        if (ch == '.') continue;
        digits[k] = ch;
        k += 1;
    }
    const exponent = std.fmt.parseInt(i32, sci[e + 1 ..], 10) catch unreachable;
    const n = exponent + 1;
    const d = digits[0..k];
    var out: std.ArrayList(u8) = .empty;
    if (value < 0) try out.append(a, '-');
    const ki: i32 = @intCast(k);
    if (ki <= n and n <= 21) {
        try out.appendSlice(a, d);
        try out.appendNTimes(a, '0', @intCast(n - ki));
    } else if (0 < n and n <= 21) {
        const split: usize = @intCast(n);
        try out.print(a, "{s}.{s}", .{ d[0..split], d[split..] });
    } else if (-6 < n and n <= 0) {
        try out.appendSlice(a, "0.");
        try out.appendNTimes(a, '0', @intCast(-n));
        try out.appendSlice(a, d);
    } else {
        try out.append(a, d[0]);
        if (k > 1) try out.print(a, ".{s}", .{d[1..]});
        try out.print(a, "e{s}{d}", .{ if (n - 1 < 0) "-" else "+", @abs(n - 1) });
    }
    return out.items;
}

/// Converts a string to a number as ECMAScript `Number(string)` does.
pub fn toNumber(input: []const u8) f64 {
    const text = trim(input);
    if (text.len == 0) return 0;
    const prefixes = [_]struct { []const u8, u8 }{
        .{ "0x", 16 }, .{ "0X", 16 }, .{ "0o", 8 }, .{ "0O", 8 }, .{ "0b", 2 }, .{ "0B", 2 },
    };
    for (prefixes) |entry| {
        const prefix, const radix = entry;
        if (!std.mem.startsWith(u8, text, prefix)) continue;
        const digits = text[2..];
        if (digits.len == 0) return std.math.nan(f64);
        var acc: f64 = 0;
        for (digits) |ch| {
            const digit = std.fmt.charToDigit(ch, radix) catch return std.math.nan(f64);
            acc = acc * @as(f64, @floatFromInt(radix)) + @as(f64, @floatFromInt(digit));
        }
        return acc;
    }
    const negative = text[0] == '-';
    const unsigned = if (text[0] == '+' or negative) text[1..] else text;
    if (std.mem.eql(u8, unsigned, "Infinity")) return if (negative) -std.math.inf(f64) else std.math.inf(f64);
    if (!isDecimalLiteral(unsigned)) return std.math.nan(f64);
    const parsed = std.fmt.parseFloat(f64, unsigned) catch unreachable;
    return if (negative) -parsed else parsed;
}

/// Whether `text` matches ECMAScript's `StrUnsignedDecimalLiteral` without `Infinity`.
fn isDecimalLiteral(text: []const u8) bool {
    var i: usize = 0;
    var mantissa = countDigits(text, &i);
    if (i < text.len and text[i] == '.') {
        i += 1;
        mantissa += countDigits(text, &i);
    }
    if (mantissa == 0) return false;
    if (i < text.len and (text[i] == 'e' or text[i] == 'E')) {
        i += 1;
        if (i < text.len and (text[i] == '+' or text[i] == '-')) i += 1;
        if (countDigits(text, &i) == 0) return false;
    }
    return i == text.len;
}

/// Advances past ASCII digits and returns how many there were.
fn countDigits(text: []const u8, i: *usize) usize {
    const start = i.*;
    while (i.* < text.len and std.ascii.isDigit(text[i.*])) i.* += 1;
    return i.* - start;
}

/// Whether a code point is ECMAScript white space or a line terminator, as
/// `String.prototype.trim` and `\s` match.
pub fn isWhitespace(cp: u21) bool {
    return switch (cp) {
        '\t', '\n', 0x0b, 0x0c, '\r', ' ', 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff => true,
        else => false,
    };
}

/// Trims ECMAScript white space from both ends, as `String.prototype.trim` does.
pub fn trim(text: []const u8) []const u8 {
    var start: usize = 0;
    var it = Utf8.init(text);
    while (it.next()) |cp| {
        if (!isWhitespace(cp)) break;
        start = it.i;
    }
    var end = text.len;
    while (end > start) {
        var begin = end - 1;
        while (text[begin] & 0xc0 == 0x80) begin -= 1;
        if (!isWhitespace(decode(text[begin..end]))) break;
        end = begin;
    }
    return text[start..end];
}

/// A lenient UTF-8 code point iterator. Invalid bytes decode as U+FFFD.
pub const Utf8 = struct {
    /// The text.
    bytes: []const u8,
    /// The byte offset of the next code point.
    i: usize = 0,

    /// Starts iterating `bytes`.
    pub fn init(bytes: []const u8) Utf8 {
        return .{ .bytes = bytes };
    }

    /// Returns the next code point, or null at the end.
    pub fn next(it: *Utf8) ?u21 {
        if (it.i >= it.bytes.len) return null;
        const len = std.unicode.utf8ByteSequenceLength(it.bytes[it.i]) catch 1;
        const end = @min(it.i + len, it.bytes.len);
        const cp = decode(it.bytes[it.i..end]);
        it.i = end;
        return cp;
    }
};

/// Decodes one UTF-8 sequence, or returns U+FFFD.
fn decode(bytes: []const u8) u21 {
    return std.unicode.utf8Decode(bytes) catch 0xfffd;
}

/// Returns the length of a string in UTF-16 code units, as `String.prototype.length` does.
pub fn utf16Len(text: []const u8) usize {
    var len: usize = 0;
    for (text) |byte| {
        if (byte & 0xc0 != 0x80) len += 1;
        if (byte >= 0xf0) len += 1;
    }
    return len;
}

/// Encodes UTF-8 text as UTF-16 code units.
pub fn toUtf16(a: Allocator, text: []const u8) Allocator.Error![]const u16 {
    var out: std.ArrayList(u16) = .empty;
    var it = Utf8.init(text);
    while (it.next()) |cp| {
        if (cp >= 0x10000) {
            const v = cp - 0x10000;
            try out.append(a, @intCast(0xd800 + (v >> 10)));
            try out.append(a, @intCast(0xdc00 + (v & 0x3ff)));
        } else {
            try out.append(a, @intCast(cp));
        }
    }
    return out.items;
}

/// Decodes UTF-16 code units as UTF-8, replacing unpaired surrogates with U+FFFD, as Rust's
/// `String::from_utf16_lossy` and JavaScript output do.
pub fn fromUtf16(a: Allocator, units: []const u16) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < units.len) : (i += 1) {
        var cp: u21 = units[i];
        if (cp >= 0xd800 and cp <= 0xdbff and i + 1 < units.len and units[i + 1] >= 0xdc00 and units[i + 1] <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (units[i + 1] - 0xdc00);
            i += 1;
        } else if (cp >= 0xd800 and cp <= 0xdfff) {
            cp = 0xfffd;
        }
        var buf: [4]u8 = undefined;
        const n = std.unicode.utf8Encode(cp, &buf) catch unreachable;
        try out.appendSlice(a, buf[0..n]);
    }
    return out.items;
}

/// Returns the UTF-16 code units `start..end` of `text`, clamped to its length.
pub fn sliceUtf16(a: Allocator, units: []const u16, start: usize, end: usize) Allocator.Error![]const u8 {
    const from = @min(start, units.len);
    return fromUtf16(a, units[from..@max(from, @min(end, units.len))]);
}

/// Lowercases a code point for the Latin scripts the reference data uses.
pub fn lower(cp: u21) u21 {
    return switch (cp) {
        'A'...'Z', 0xc0...0xd6, 0xd8...0xde => cp + 0x20,
        0x100...0x137, 0x14a...0x177 => cp | 1,
        0x139...0x148, 0x179...0x17e => if (cp & 1 == 1) cp + 1 else cp,
        0x178 => 0xff,
        0x1e9e => 0xdf,
        else => cp,
    };
}

/// Lowercases a string with `lower`.
pub fn lowerString(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var it = Utf8.init(text);
    while (it.next()) |cp| {
        var buf: [4]u8 = undefined;
        const n = std.unicode.utf8Encode(lower(cp), &buf) catch unreachable;
        try out.appendSlice(a, buf[0..n]);
    }
    return out.items;
}

/// Converts a camelCase name to kebab-case.
pub fn toKebab(a: Allocator, value: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (value) |ch| {
        if (std.ascii.isUpper(ch)) {
            try out.append(a, '-');
            try out.append(a, std.ascii.toLower(ch));
        } else {
            try out.append(a, ch);
        }
    }
    return out.items;
}

/// Compares strings as `String.prototype.localeCompare` does under the ICU root collation.
///
/// Compares case-insensitive primary weights first, where whitespace, punctuation, and symbols
/// sort before digits and digits before letters. Lowercase letters then sort before uppercase,
/// and code points break remaining ties.
pub fn localeCompare(a: []const u8, b: []const u8) std.math.Order {
    var x = Utf8.init(a);
    var y = Utf8.init(b);
    while (true) {
        const p = x.next() orelse return if (y.next() == null) tertiary(a, b) else .lt;
        const q = y.next() orelse return .gt;
        const order = std.math.order(primaryWeight(p), primaryWeight(q));
        if (order != .eq) return order;
    }
}

/// Breaks primary ties: lowercase before uppercase, then code points.
fn tertiary(a: []const u8, b: []const u8) std.math.Order {
    var x = Utf8.init(a);
    var y = Utf8.init(b);
    while (x.next()) |p| {
        const q = y.next().?;
        const order = std.math.order(@intFromBool(lower(p) != p), @intFromBool(lower(q) != q));
        if (order != .eq) return order;
    }
    return std.mem.order(u8, a, b);
}

/// Returns the primary collation weight of a code point.
fn primaryWeight(cp: u21) u32 {
    // Root collation order of ASCII whitespace, punctuation, and symbols.
    const symbols = "\t\n\x0b\x0c\r _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    if (cp < 0x80) {
        if (std.mem.findScalar(u8, symbols, @intCast(cp))) |index| return @intCast(index);
        if (std.ascii.isDigit(@intCast(cp))) return 100 + @as(u32, cp);
        if (std.ascii.isAlphabetic(@intCast(cp))) return 200 + @as(u32, lower(cp));
    }
    return 1000 + @as(u32, cp);
}

/// Resolves a `slice` bound as JavaScript does: truncated toward zero, counted from the end when
/// negative, and clamped to `0..len`. NaN resolves to 0.
pub fn relativeIndex(value: f64, len: usize) usize {
    const length: f64 = @floatFromInt(len);
    const truncated = if (std.math.isNan(value)) 0 else @trunc(value);
    const index = if (truncated < 0) length + truncated else truncated;
    return @intFromFloat(std.math.clamp(index, 0, length));
}

/// Returns the index JavaScript reads at `array[value]`: only exact non-negative integers below
/// the length index an array.
pub fn element(len: usize, value: f64) ?usize {
    if (!(value >= 0) or @trunc(value) != value or value >= @as(f64, @floatFromInt(len))) return null;
    return @intFromFloat(value);
}

/// Parses a canonical array index, the keys JavaScript orders first.
pub fn arrayIndex(key: []const u8) ?u32 {
    if (key.len == 0 or (key.len > 1 and key[0] == '0')) return null;
    for (key) |ch| if (!std.ascii.isDigit(ch)) return null;
    const index = std.fmt.parseInt(u32, key, 10) catch return null;
    return if (index == std.math.maxInt(u32)) null else index;
}

/// Returns `count` copies of `text`.
pub fn repeat(a: Allocator, text: []const u8, count: usize) Allocator.Error![]const u8 {
    const out = try a.alloc(u8, text.len * count);
    for (0..count) |i| @memcpy(out[i * text.len ..][0..text.len], text);
    return out;
}

/// Pads `text` with spaces to a UTF-16 width.
pub fn pad(a: Allocator, text: []const u8, width: usize) Allocator.Error![]const u8 {
    const len = utf16Len(text);
    return std.mem.concat(a, u8, &.{ text, try repeat(a, " ", width -| len) });
}
