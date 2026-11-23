//! YAML serialization of JSON data, ported from `yaml` 2.8.2 `stringify` with its default
//! options (core schema, block collections, two-space indentation).
//!
//! String folding indexes UTF-16 code units, as the JavaScript implementation does.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// Maximum line width before folding.
const line_width: usize = 80;

/// Minimum content width of a folded line.
const min_content_width: usize = 20;

/// The stringify context of one node.
const Ctx = struct {
    /// Whether the scalar is a mapping key.
    implicit_key: bool = false,
    /// Current indentation.
    indent: []const u8 = "",
    /// Columns already used on the scalar's first line.
    indent_at_start: ?usize = null,
    /// Whether a top-level block scalar must be indented.
    force_block_indent: bool = false,
};

/// Serializes a value as a YAML document, ending with a newline.
pub fn stringify(a: Allocator, value: Value) Allocator.Error![]const u8 {
    return std.mem.concat(a, u8, &.{ try node(a, value, .{}), "\n" });
}

/// Stringifies any node.
fn node(a: Allocator, value: Value, ctx: Ctx) Allocator.Error![]const u8 {
    switch (value) {
        .null, .bool, .integer, .big_integer, .float => return json.toString(a, value),
        .string => |s| return stringScalar(a, s, ctx),
        .array => |items| {
            if (items.len == 0) return "[]";
            var item_ctx = ctx;
            item_ctx.indent = try std.mem.concat(a, u8, &.{ ctx.indent, "  " });
            item_ctx.indent_at_start = null;
            var lines: std.ArrayList([]const u8) = .empty;
            for (items) |item| try lines.append(a, try std.mem.concat(a, u8, &.{ "- ", try node(a, item, item_ctx) }));
            return std.mem.join(a, try std.mem.concat(a, u8, &.{ "\n", ctx.indent }), lines.items);
        },
        .object => |entries| {
            if (entries.len == 0) return "{}";
            var lines: std.ArrayList([]const u8) = .empty;
            for (entries) |entry| try lines.append(a, try pair(a, entry.key, entry.value, ctx));
            return std.mem.join(a, try std.mem.concat(a, u8, &.{ "\n", ctx.indent }), lines.items);
        },
    }
}

/// Stringifies a `key: value` pair.
fn pair(a: Allocator, key: []const u8, value: Value, ctx: Ctx) Allocator.Error![]const u8 {
    var pair_ctx = ctx;
    pair_ctx.implicit_key = true;
    pair_ctx.indent = try std.mem.concat(a, u8, &.{ ctx.indent, "  " });
    pair_ctx.indent_at_start = null;
    const key_str = try stringScalar(a, key, pair_ctx);
    // Keys longer than 1024 characters need explicit `? key` syntax.
    const explicit = js.utf16Len(key_str) > 1024;
    const out = if (explicit)
        try std.fmt.allocPrint(a, "? {s}\n{s}:", .{ key_str, ctx.indent })
    else
        try std.fmt.allocPrint(a, "{s}:", .{key_str});
    pair_ctx.implicit_key = false;
    const collection = value == .array or value == .object;
    if (!explicit and !collection) pair_ctx.indent_at_start = js.utf16Len(out) + 1;
    const value_str = try node(a, value, pair_ctx);
    const ws = if (!explicit and collection) ws: {
        const empty = (value == .array and value.array.len == 0) or (value == .object and value.object.len == 0);
        break :ws if (contains(value_str, '\n') or !empty) try std.mem.concat(a, u8, &.{ "\n", pair_ctx.indent }) else " ";
    } else if (value_str.len == 0 or value_str[0] == '\n') "" else " ";
    return std.mem.concat(a, u8, &.{ out, ws, value_str });
}

/// Whether `text` contains `ch`.
fn contains(text: []const u8, ch: u8) bool {
    return std.mem.findScalar(u8, text, ch) != null;
}

/// Whether a string matches `/^(%|---|\.\.\.)/m`.
fn containsDocumentMarker(text: []const u8) bool {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |l| {
        if (std.mem.startsWith(u8, l, "%") or std.mem.startsWith(u8, l, "---") or std.mem.startsWith(u8, l, "...")) return true;
    }
    return false;
}

/// Stringifies a string scalar in the default plain style. Control characters and unpaired
/// surrogates force double quotes.
fn stringScalar(a: Allocator, text: []const u8, ctx: Ctx) Allocator.Error![]const u8 {
    var it = js.Utf8.init(text);
    while (it.next()) |cp| switch (cp) {
        0...0x08, 0x0b...0x1f, 0x7f...0x9f, 0xd800...0xdfff => return doubleQuoted(a, text, ctx),
        else => {},
    };
    return plain(a, text, ctx);
}

/// Stringifies a string as a plain scalar when YAML allows it.
fn plain(a: Allocator, text: []const u8, ctx: Ctx) Allocator.Error![]const u8 {
    const multiline = contains(text, '\n');
    if (ctx.implicit_key and multiline) return quoted(a, text, ctx);
    if (needsQuotes(text)) return if (ctx.implicit_key or !multiline) quoted(a, text, ctx) else block(a, text, ctx);
    if (!ctx.implicit_key and multiline) return block(a, text, ctx);
    if (containsDocumentMarker(text)) {
        if (ctx.indent.len == 0) {
            var forced = ctx;
            forced.force_block_indent = true;
            return block(a, text, forced);
        } else if (ctx.implicit_key and std.mem.eql(u8, ctx.indent, "  ")) {
            return quoted(a, text, ctx);
        }
    }
    if (resolvesAsNonString(text)) return quoted(a, text, ctx);
    if (ctx.implicit_key) return text;
    return fold(a, text, ctx.indent, .flow, ctx.indent_at_start, null);
}

/// Matches the indicator characters that forbid a plain scalar.
fn needsQuotes(text: []const u8) bool {
    if (text.len == 0) return false;
    if (contains("\n\t ,[]{}#&*!|>'\"%@`", text[0])) return true;
    if ((text[0] == '?' or text[0] == '-') and (text.len == 1 or text[1] == ' ' or text[1] == '\t')) return true;
    for (text[0 .. text.len - 1], text[1..]) |x, y| {
        if (((x == '\n' or x == ':') and (y == ' ' or y == '\t')) or
            ((x == ' ' or x == '\t') and y == '\n') or
            ((x == '\n' or x == '\t' or x == ' ') and y == '#')) return true;
    }
    return contains("\n\t :", text[text.len - 1]);
}

/// Whether a string is non-empty ASCII digits.
fn digits(text: []const u8) bool {
    if (text.len == 0) return false;
    for (text) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

/// Matches `.5`, `1.`, and `1.5`.
fn isFloat(text: []const u8) bool {
    const dot = std.mem.findScalar(u8, text, '.') orelse return false;
    const int = text[0..dot];
    const frac = text[dot + 1 ..];
    return (int.len == 0 and digits(frac)) or (digits(int) and (frac.len == 0 or digits(frac)));
}

/// Strips one leading `+` or `-`.
fn unsign(text: []const u8) []const u8 {
    return if (text.len > 0 and (text[0] == '+' or text[0] == '-')) text[1..] else text;
}

/// Matches a float or integer mantissa with an exponent.
fn isExp(text: []const u8) bool {
    const index = std.mem.findAny(u8, text, "eE") orelse return false;
    const mantissa = text[0..index];
    return (digits(mantissa) or isFloat(mantissa)) and digits(unsign(text[index + 1 ..]));
}

/// Whether every byte of `text` is in `set`, and `text` is not empty.
fn allIn(text: []const u8, set: []const u8) bool {
    if (text.len == 0) return false;
    for (text) |ch| if (!contains(set, ch)) return false;
    return true;
}

/// Whether a plain scalar would resolve to a non-string under the core schema.
fn resolvesAsNonString(text: []const u8) bool {
    const words = [_][]const u8{ "", "~", "null", "Null", "NULL", "true", "True", "TRUE", "false", "False", "FALSE", ".nan", ".NaN", ".NAN" };
    for (words) |w| if (std.mem.eql(u8, text, w)) return true;
    const signed = unsign(text);
    for ([_][]const u8{ ".inf", ".Inf", ".INF" }) |w| if (std.mem.eql(u8, signed, w)) return true;
    return digits(signed) or
        (std.mem.startsWith(u8, text, "0o") and allIn(text[2..], "01234567")) or
        (std.mem.startsWith(u8, text, "0x") and allIn(text[2..], "0123456789abcdefABCDEF")) or
        isExp(signed) or isFloat(signed);
}

/// Chooses single or double quotes.
fn quoted(a: Allocator, text: []const u8, ctx: Ctx) Allocator.Error![]const u8 {
    if (contains(text, '"') and !contains(text, '\'')) return singleQuoted(a, text, ctx);
    return doubleQuoted(a, text, ctx);
}

/// Returns the indentation a quoted scalar folds with.
fn quotedIndent(text: []const u8, ctx: Ctx) []const u8 {
    return if (ctx.indent.len == 0 and containsDocumentMarker(text)) "  " else ctx.indent;
}

/// Stringifies a single-quoted scalar.
fn singleQuoted(a: Allocator, text: []const u8, ctx: Ctx) Allocator.Error![]const u8 {
    // Multiline strings reach here only as implicit keys or with whitespace around a line
    // break, and single quotes can hold neither.
    if (contains(text, '\n')) return doubleQuoted(a, text, ctx);
    const res = try std.fmt.allocPrint(a, "'{s}'", .{try std.mem.replaceOwned(u8, a, text, "'", "''")});
    if (ctx.implicit_key) return res;
    return fold(a, res, quotedIndent(text, ctx), .flow, ctx.indent_at_start, null);
}

/// Stringifies a double-quoted scalar.
fn doubleQuoted(a: Allocator, text: []const u8, ctx: Ctx) Allocator.Error![]const u8 {
    const indent = quotedIndent(text, ctx);
    const units = try js.toUtf16(a, try json.stringify(a, .{ .string = text }));
    const at = struct {
        fn at(u: []const u16, i: usize) u16 {
            return if (i < u.len) u[i] else 0;
        }
    }.at;
    var out: std.ArrayList(u8) = .empty;
    var start: usize = 0;
    var i: usize = 0;
    while (i < units.len) : (i += 1) {
        var ch = at(units, i);
        if (ch == ' ' and at(units, i + 1) == '\\' and at(units, i + 2) == 'n') {
            try out.appendSlice(a, try js.sliceUtf16(a, units, start, i));
            try out.appendSlice(a, "\\ ");
            i += 1;
            start = i;
            ch = '\\';
        }
        if (ch != '\\') continue;
        switch (at(units, i + 1)) {
            'u' => {
                try out.appendSlice(a, try js.sliceUtf16(a, units, start, i));
                const code = try js.sliceUtf16(a, units, i + 2, i + 6);
                const short = for ([_][2][]const u8{ .{ "0000", "\\0" }, .{ "0007", "\\a" }, .{ "000b", "\\v" }, .{ "001b", "\\e" } }) |entry| {
                    if (std.mem.eql(u8, code, entry[0])) break entry[1];
                } else null;
                // `JSON.stringify` escapes C0 controls as `00XX` and unpaired surrogates, which stay.
                if (short) |s|
                    try out.appendSlice(a, s)
                else if (std.mem.startsWith(u8, code, "00"))
                    try out.print(a, "\\x{s}", .{code[2..]})
                else
                    try out.print(a, "\\u{s}", .{code});
                i += 5;
                start = i + 1;
            },
            'n' => {
                if (ctx.implicit_key or at(units, i + 2) == '"' or units.len < 40) {
                    i += 1;
                } else {
                    try out.appendSlice(a, try js.sliceUtf16(a, units, start, i));
                    try out.appendSlice(a, "\n\n");
                    while (at(units, i + 2) == '\\' and at(units, i + 3) == 'n' and at(units, i + 4) != '"') {
                        try out.append(a, '\n');
                        i += 2;
                    }
                    try out.appendSlice(a, indent);
                    if (at(units, i + 2) == ' ') try out.append(a, '\\');
                    i += 1;
                    start = i + 1;
                }
            },
            else => i += 1,
        }
    }
    const result = if (start > 0)
        try std.mem.concat(a, u8, &.{ out.items, try js.sliceUtf16(a, units, start, units.len) })
    else
        try js.fromUtf16(a, units);
    if (ctx.implicit_key) return result;
    return fold(a, result, indent, .quoted, ctx.indent_at_start, null);
}

/// Stringifies a block scalar (`|` literal or `>` folded).
fn block(a: Allocator, text: []const u8, ctx: Ctx) Allocator.Error![]const u8 {
    if (std.mem.findScalarLast(u8, text, '\n')) |index| {
        const tail = text[index + 1 ..];
        if (tail.len > 0 and allIn(tail, " \t")) return quoted(a, text, ctx);
    }
    const indent = if (ctx.indent.len > 0)
        ctx.indent
    else if (ctx.force_block_indent or containsDocumentMarker(text)) "  " else "";
    const literal = !lineOverLimit(text, indent.len);

    // Chomping from trailing whitespace (ASCII, so byte offsets match code units).
    var end_start = text.len;
    while (end_start > 0 and contains("\n\t ", text[end_start - 1])) end_start -= 1;
    var end = text[end_start..];
    var body = text[0..end_start];
    const chomp = if (std.mem.findScalar(u8, end, '\n')) |pos|
        (if (body.len == 0 or pos != end.len - 1) "+" else "")
    else
        "-";
    if (end.len > 0) {
        if (end[end.len - 1] == '\n') end = end[0 .. end.len - 1];
        end = try indentNewlineRuns(a, end, indent, true);
    }

    // Indentation indicator from leading whitespace.
    var start_with_space = false;
    var start_len: usize = 0;
    for (body, 0..) |ch, index| switch (ch) {
        ' ' => start_with_space = true,
        // Leading spaces after the last leading newline stay in the body.
        '\n' => start_len = index + 1,
        else => break,
    };
    var start = body[0..start_len];
    if (start.len > 0) {
        body = body[start_len..];
        start = try indentNewlineRuns(a, start, indent, false);
    }
    const header = try std.mem.concat(a, u8, &.{ if (start_with_space) (if (indent.len == 0) "1" else "2") else "", chomp });

    if (!literal) {
        const folded_body = try foldBlockBody(a, body, indent);
        var overflow = false;
        const folded = try fold(a, try std.mem.concat(a, u8, &.{ start, folded_body, end }), indent, .block, indent.len, &overflow);
        if (!overflow) return std.fmt.allocPrint(a, ">{s}\n{s}{s}", .{ header, indent, folded });
    }
    return std.fmt.allocPrint(a, "|{s}\n{s}{s}{s}{s}", .{ header, indent, start, try indentNewlineRuns(a, body, indent, false), end });
}

/// Replaces each run of newlines with itself followed by `indent`. With `inner`, only runs that
/// are not at the end (`(^|(?<!\n))\n+(?!\n|$)`).
fn indentNewlineRuns(a: Allocator, text: []const u8, indent: []const u8, inner: bool) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var run: usize = 0;
    for (text) |ch| {
        if (ch == '\n') {
            run += 1;
            continue;
        }
        if (run > 0) {
            try out.appendNTimes(a, '\n', run);
            try out.appendSlice(a, indent);
            run = 0;
        }
        try out.append(a, ch);
    }
    if (run > 0) {
        try out.appendNTimes(a, '\n', run);
        if (!inner) try out.appendSlice(a, indent);
    }
    return out.items;
}

/// Prepares a folded block body: doubles line breaks and keeps more-indented lines literal.
fn foldBlockBody(a: Allocator, text: []const u8, indent: []const u8) Allocator.Error![]const u8 {
    // `.replace(/\n+/g, '\n$&')`; the body never ends with a newline.
    var doubled: std.ArrayList(u8) = .empty;
    var run: usize = 0;
    for (text) |ch| {
        if (ch == '\n') {
            run += 1;
            continue;
        }
        if (run > 0) {
            try doubled.appendNTimes(a, '\n', run + 1);
            run = 0;
        }
        try doubled.append(a, ch);
    }
    return indentNewlineRuns(a, try keepMoreIndented(a, doubled.items), indent, false);
}

/// `.replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, '$1$2')`: undoes the doubled
/// line breaks around more-indented lines.
fn keepMoreIndented(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        const start = if (i == 0 and (text[0] == '\t' or text[0] == ' '))
            0
        else if (text[i] == '\n' and i + 1 < text.len and (text[i + 1] == '\t' or text[i + 1] == ' '))
            i + 1
        else {
            try out.append(a, text[i]);
            i += 1;
            continue;
        };
        // `.` stops at JavaScript line terminators: `\n`, `\r`, U+2028, and U+2029.
        var end = start;
        while (end < text.len and text[end] != '\n' and text[end] != '\r' and
            !(std.mem.startsWith(u8, text[end..], "\u{2028}") or std.mem.startsWith(u8, text[end..], "\u{2029}"))) end += 1;
        try out.appendSlice(a, text[start..end]);
        var run = end;
        while (run < text.len and contains("\n\t ", text[run])) run += 1;
        // The optional group matches only when the blank run ends with a line break.
        if (run > end and text[run - 1] == '\n') {
            try out.appendSlice(a, text[end .. run - 1]);
            i = run;
        } else {
            i = end;
        }
    }
    return out.items;
}

/// Whether any line exceeds the width limit, in UTF-16 code units.
fn lineOverLimit(text: []const u8, indent: usize) bool {
    const limit = line_width - indent;
    const total = js.utf16Len(text);
    if (total <= limit) return false;
    var start: usize = 0;
    var i: usize = 0;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |l| {
        const len = js.utf16Len(l);
        i = start + len;
        if (i == total) break;
        if (i - start > limit) return true;
        start = i + 1;
        if (total - start <= limit) return false;
    }
    return true;
}

/// The folding mode.
const Mode = enum {
    /// Block scalar content.
    block,
    /// Plain or single-quoted flow scalar.
    flow,
    /// Double-quoted scalar, which may fold inside escapes.
    quoted,
};

/// Folds long lines at spaces, as `foldFlowLines` does.
fn fold(a: Allocator, text: []const u8, indent: []const u8, mode: Mode, indent_at_start: ?usize, on_overflow: ?*bool) Allocator.Error![]const u8 {
    const units = try js.toUtf16(a, text);
    const at = struct {
        fn at(u: []const u16, i: usize) ?u16 {
            return if (i < u.len) u[i] else null;
        }
    }.at;
    const end_step = @max(1 + min_content_width, 1 + line_width - indent.len);
    if (units.len <= end_step) return text;
    var folds: std.ArrayList(usize) = .empty;
    var escaped: std.ArrayList(usize) = .empty;
    var end = line_width - indent.len;
    if (indent_at_start) |start| {
        if (start > line_width - min_content_width) try folds.append(a, 0) else end = line_width - start;
    }
    var split: ?usize = null;
    var prev: ?u16 = null;
    var overflow = false;
    var i: isize = -1;
    var esc_start: isize = -1;
    var esc_end: isize = -1;
    if (mode == .block) {
        i = consumeMoreIndented(units, i, indent.len);
        if (i != -1) end = @as(usize, @intCast(i)) + end_step;
    }
    while (true) {
        i += 1;
        var ch = at(units, @intCast(i)) orelse break;
        if (mode == .quoted and ch == '\\') {
            esc_start = i;
            // `doubleQuoted` writes `\xXX` and `\uXXXX` escapes; the others are two units long.
            i += switch (at(units, @intCast(i + 1)) orelse 0) {
                'x' => 3,
                'u' => 5,
                else => 1,
            };
            esc_end = i;
        }
        const index: usize = @intCast(i);
        if (ch == '\n') {
            if (mode == .block) i = consumeMoreIndented(units, i, indent.len);
            end = @as(usize, @intCast(i)) + indent.len + end_step;
            split = null;
        } else {
            if (ch == ' ' and prev != null and prev != ' ' and prev != '\n' and prev != '\t') {
                const next = at(units, index + 1);
                if (next != null and next != ' ' and next != '\n' and next != '\t') split = index;
            }
            if (index >= end) {
                if (split) |at_split| {
                    try folds.append(a, at_split);
                    end = at_split + end_step;
                    split = null;
                } else if (mode == .quoted) {
                    var cur = index;
                    while (prev == ' ' or prev == '\t') {
                        prev = ch;
                        cur += 1;
                        ch = at(units, cur) orelse 0;
                        overflow = true;
                    }
                    i = @intCast(cur);
                    const j: usize = @intCast(if (i > esc_end + 1) i - 2 else esc_start - 1);
                    try folds.append(a, j);
                    try escaped.append(a, j);
                    end = j + end_step;
                    split = null;
                } else {
                    overflow = true;
                }
            }
        }
        prev = ch;
    }
    if (overflow) if (on_overflow) |flag| {
        flag.* = true;
    };
    if (folds.items.len == 0) return text;
    var res: std.ArrayList(u8) = .empty;
    try res.appendSlice(a, try js.sliceUtf16(a, units, 0, folds.items[0]));
    for (folds.items, 0..) |fold_at, k| {
        const next = if (k + 1 < folds.items.len and folds.items[k + 1] != 0) folds.items[k + 1] else units.len;
        if (fold_at == 0) {
            res.clearRetainingCapacity();
            try res.print(a, "\n{s}{s}", .{ indent, try js.sliceUtf16(a, units, 0, next) });
        } else {
            if (mode == .quoted and std.mem.findScalar(usize, escaped.items, fold_at) != null) {
                try res.appendSlice(a, try js.sliceUtf16(a, units, fold_at, fold_at + 1));
                try res.append(a, '\\');
            }
            try res.print(a, "\n{s}{s}", .{ indent, try js.sliceUtf16(a, units, fold_at + 1, next) });
        }
    }
    return res.items;
}

/// Skips more-indented lines of a block scalar. Returns the index of the last newline consumed.
fn consumeMoreIndented(units: []const u16, start_index: isize, indent: usize) isize {
    const at = struct {
        fn at(u: []const u16, i: isize) ?u16 {
            return if (i >= 0 and i < u.len) u[@intCast(i)] else null;
        }
    }.at;
    var i = start_index;
    var end = i;
    var start = i + 1;
    var ch = at(units, start);
    const width: isize = @intCast(indent);
    while (ch == ' ' or ch == '\t') {
        if (i < start + width) {
            i += 1;
            ch = at(units, i);
        } else {
            while (true) {
                i += 1;
                ch = at(units, i);
                if (ch == null or ch == '\n') break;
            }
            end = i;
            start = i + 1;
            ch = at(units, start);
        }
    }
    return end;
}
