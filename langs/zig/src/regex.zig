//! A backtracking matcher for the JavaScript regular expressions JSON Schema `pattern` keywords
//! and Zod's string formats use: alternation, groups, character classes, `\d \w \s \b` and their
//! negations, anchors, `.`, and greedy or lazy quantifiers. Matching runs on code points and
//! finds a match anywhere in the text, as `RegExp.prototype.test` does without flags.

const std = @import("std");
const js = @import("js.zig");

const Allocator = std.mem.Allocator;

/// A compiled pattern.
pub const Regex = struct {
    /// The alternatives of the whole pattern.
    root: []const []const Node,

    /// Compiles a pattern, or returns null for syntax this matcher does not support, such as
    /// lookarounds and backreferences.
    pub fn compile(a: Allocator, pattern: []const u8) Allocator.Error!?Regex {
        var p: Parser = .{ .a = a, .text = pattern };
        const root = try p.alternatives() orelse return null;
        if (p.index != pattern.len) return null;
        return .{ .root = root };
    }

    /// Whether the pattern matches anywhere in `text`.
    pub fn matches(r: Regex, a: Allocator, text: []const u8) Allocator.Error!bool {
        var points: std.ArrayList(u21) = .empty;
        var it: js.Utf8 = .init(text);
        while (it.next()) |cp| try points.append(a, cp);
        const m: Matcher = .{ .text = points.items };
        for (0..points.items.len + 1) |start| {
            if (m.alternatives(r.root, start, null)) return true;
        }
        return false;
    }
};

/// A pattern element.
const Node = union(enum) {
    /// A literal code point.
    char: u21,
    /// `.`: any code point except line terminators.
    any,
    /// A character class.
    class: Class,
    /// `^`.
    start,
    /// `$`.
    end,
    /// `\b`, or `\B` when true.
    boundary: bool,
    /// A group's alternatives.
    group: []const []const Node,
    /// A quantified element.
    repeat: Repeat,
};

/// A quantified element.
const Repeat = struct {
    node: *const Node,
    min: usize,
    max: ?usize,
    greedy: bool,
};

/// A set of code point ranges.
const Class = struct {
    ranges: []const [2]u21,
    negated: bool,

    fn has(c: Class, cp: u21) bool {
        for (c.ranges) |r| if (cp >= r[0] and cp <= r[1]) return !c.negated;
        return c.negated;
    }
};

const digit_ranges = [_][2]u21{.{ '0', '9' }};
const word_ranges = [_][2]u21{ .{ '0', '9' }, .{ 'A', 'Z' }, .{ '_', '_' }, .{ 'a', 'z' } };
const space_ranges = [_][2]u21{ .{ '\t', '\r' }, .{ ' ', ' ' }, .{ 0xa0, 0xa0 }, .{ 0x1680, 0x1680 }, .{ 0x2000, 0x200a }, .{ 0x2028, 0x2029 }, .{ 0x202f, 0x202f }, .{ 0x205f, 0x205f }, .{ 0x3000, 0x3000 }, .{ 0xfeff, 0xfeff } };

/// Parses a pattern.
const Parser = struct {
    a: Allocator,
    text: []const u8,
    index: usize = 0,

    fn peek(p: *Parser) ?u8 {
        return if (p.index < p.text.len) p.text[p.index] else null;
    }

    /// Returns the next code point.
    fn next(p: *Parser) ?u21 {
        if (p.index == p.text.len) return null;
        var it: js.Utf8 = .init(p.text[p.index..]);
        const cp = it.next().?;
        p.index += std.unicode.utf8CodepointSequenceLength(cp) catch 1;
        return cp;
    }

    fn alternatives(p: *Parser) Allocator.Error!?[]const []const Node {
        var list: std.ArrayList([]const Node) = .empty;
        while (true) {
            try list.append(p.a, try p.sequence() orelse return null);
            if (p.peek() != '|') return list.items;
            p.index += 1;
        }
    }

    fn sequence(p: *Parser) Allocator.Error!?[]const Node {
        var nodes: std.ArrayList(Node) = .empty;
        while (p.peek()) |ch| {
            if (ch == '|' or ch == ')') break;
            const element = try p.atom() orelse return null;
            try nodes.append(p.a, try p.quantified(element) orelse return null);
        }
        return nodes.items;
    }

    /// Applies a quantifier that follows an element.
    fn quantified(p: *Parser, element: Node) Allocator.Error!?Node {
        const bounds: [2]?usize = switch (p.peek() orelse return element) {
            '*' => .{ 0, null },
            '+' => .{ 1, null },
            '?' => .{ 0, 1 },
            '{' => braces: {
                const save = p.index;
                p.index += 1;
                const min = p.number() orelse {
                    p.index = save;
                    return element;
                };
                var max: ?usize = min;
                if (p.peek() == ',') {
                    p.index += 1;
                    max = p.number();
                }
                if (p.peek() != '}') {
                    p.index = save;
                    return element;
                }
                break :braces .{ min, max };
            },
            else => return element,
        };
        p.index += 1;
        // A quantifier cannot follow an anchor or another quantifier.
        if (element == .start or element == .end or element == .boundary) return null;
        const greedy = p.peek() != '?';
        if (!greedy) p.index += 1;
        const node = try p.a.create(Node);
        node.* = element;
        return .{ .repeat = .{ .node = node, .min = bounds[0].?, .max = bounds[1], .greedy = greedy } };
    }

    fn number(p: *Parser) ?usize {
        const start = p.index;
        while (p.peek()) |ch| {
            if (!std.ascii.isDigit(ch)) break;
            p.index += 1;
        }
        return std.fmt.parseInt(usize, p.text[start..p.index], 10) catch null;
    }

    fn atom(p: *Parser) Allocator.Error!?Node {
        const cp = p.next().?;
        return switch (cp) {
            '^' => .start,
            '$' => .end,
            '.' => .any,
            '(' => group: {
                if (p.peek() == '?') {
                    if (!std.mem.startsWith(u8, p.text[p.index..], "?:")) return null;
                    p.index += 2;
                }
                const alts = try p.alternatives() orelse return null;
                if (p.peek() != ')') return null;
                p.index += 1;
                break :group .{ .group = alts };
            },
            '[' => p.class(),
            '\\' => p.escape(false),
            '*', '+', '?', ')' => null,
            else => .{ .char = cp },
        };
    }

    /// Parses an escape after `\`. Inside a class, `\b` is a backspace.
    fn escape(p: *Parser, in_class: bool) Allocator.Error!?Node {
        const cp = p.next() orelse return null;
        return switch (cp) {
            'd' => .{ .class = .{ .ranges = &digit_ranges, .negated = false } },
            'D' => .{ .class = .{ .ranges = &digit_ranges, .negated = true } },
            'w' => .{ .class = .{ .ranges = &word_ranges, .negated = false } },
            'W' => .{ .class = .{ .ranges = &word_ranges, .negated = true } },
            's' => .{ .class = .{ .ranges = &space_ranges, .negated = false } },
            'S' => .{ .class = .{ .ranges = &space_ranges, .negated = true } },
            'b' => if (in_class) .{ .char = 8 } else .{ .boundary = false },
            'B' => if (in_class) null else .{ .boundary = true },
            'n' => .{ .char = '\n' },
            'r' => .{ .char = '\r' },
            't' => .{ .char = '\t' },
            'f' => .{ .char = 0x0c },
            'v' => .{ .char = 0x0b },
            '0' => .{ .char = 0 },
            'u', 'x' => hex: {
                const len: usize = if (cp == 'u') 4 else 2;
                if (p.index + len > p.text.len) return null;
                const value = std.fmt.parseInt(u21, p.text[p.index..][0..len], 16) catch return null;
                p.index += len;
                break :hex .{ .char = value };
            },
            // Backreferences and named escapes are not supported.
            '1'...'9', 'k', 'p', 'P', 'c' => null,
            else => .{ .char = cp },
        };
    }

    fn class(p: *Parser) Allocator.Error!?Node {
        const negated = p.peek() == '^';
        if (negated) p.index += 1;
        var ranges: std.ArrayList([2]u21) = .empty;
        while (true) {
            const cp = p.next() orelse return null;
            if (cp == ']') break;
            var low = cp;
            if (cp == '\\') switch (try p.escape(true) orelse return null) {
                .char => |c| low = c,
                .class => |c| {
                    // A negated shorthand inside a class adds the complement of its ranges.
                    if (c.negated) try complement(p.a, &ranges, c.ranges) else try ranges.appendSlice(p.a, c.ranges);
                    continue;
                },
                else => unreachable,
            };
            if (p.peek() == '-' and p.index + 1 < p.text.len and p.text[p.index + 1] != ']') {
                p.index += 1;
                var high = p.next().?;
                if (high == '\\') high = switch (try p.escape(true) orelse return null) {
                    .char => |c| c,
                    else => return null,
                };
                if (high < low) return null;
                try ranges.append(p.a, .{ low, high });
            } else try ranges.append(p.a, .{ low, low });
        }
        return .{ .class = .{ .ranges = ranges.items, .negated = negated } };
    }
};

/// Appends the code points outside sorted ranges.
fn complement(a: Allocator, out: *std.ArrayList([2]u21), ranges: []const [2]u21) Allocator.Error!void {
    var low: u21 = 0;
    for (ranges) |r| {
        if (r[0] > low) try out.append(a, .{ low, r[0] - 1 });
        low = r[1] + 1;
    }
    try out.append(a, .{ low, 0x10ffff });
}

/// What remains to match after an element: the rest of a sequence, or more repetitions.
const Cont = struct {
    step: union(enum) {
        seq: []const Node,
        repeat: struct { r: *const Repeat, count: usize, start: usize },
    },
    next: ?*const Cont,
};

/// Matches compiled nodes against code points.
const Matcher = struct {
    text: []const u21,

    fn alternatives(m: Matcher, alts: []const []const Node, pos: usize, cont: ?*const Cont) bool {
        for (alts) |seq| if (m.sequence(seq, pos, cont)) return true;
        return false;
    }

    fn proceed(m: Matcher, pos: usize, cont: ?*const Cont) bool {
        const c = cont orelse return true;
        return switch (c.step) {
            .seq => |seq| m.sequence(seq, pos, c.next),
            .repeat => |r| {
                // An empty optional iteration ends the loop, as JavaScript does.
                if (pos == r.start and r.count > r.r.min) return false;
                return m.repeat(r.r, r.count, pos, c.next);
            },
        };
    }

    fn sequence(m: Matcher, seq: []const Node, pos: usize, cont: ?*const Cont) bool {
        if (seq.len == 0) return m.proceed(pos, cont);
        const rest: Cont = .{ .step = .{ .seq = seq[1..] }, .next = cont };
        return m.node(&seq[0], pos, if (seq.len == 1) cont else &rest);
    }

    fn repeat(m: Matcher, r: *const Repeat, count: usize, pos: usize, cont: ?*const Cont) bool {
        const more = r.max == null or count < r.max.?;
        const again: Cont = .{ .step = .{ .repeat = .{ .r = r, .count = count + 1, .start = pos } }, .next = cont };
        if (count < r.min) return m.node(r.node, pos, &again);
        if (r.greedy) return (more and m.node(r.node, pos, &again)) or m.proceed(pos, cont);
        return m.proceed(pos, cont) or (more and m.node(r.node, pos, &again));
    }

    fn isWord(m: Matcher, pos: usize) bool {
        return pos < m.text.len and (Class{ .ranges = &word_ranges, .negated = false }).has(m.text[pos]);
    }

    fn node(m: Matcher, n: *const Node, pos: usize, cont: ?*const Cont) bool {
        switch (n.*) {
            .char => |c| return pos < m.text.len and m.text[pos] == c and m.proceed(pos + 1, cont),
            .any => {
                if (pos == m.text.len) return false;
                const cp = m.text[pos];
                return cp != '\n' and cp != '\r' and cp != 0x2028 and cp != 0x2029 and m.proceed(pos + 1, cont);
            },
            .class => |c| return pos < m.text.len and c.has(m.text[pos]) and m.proceed(pos + 1, cont),
            .start => return pos == 0 and m.proceed(pos, cont),
            .end => return pos == m.text.len and m.proceed(pos, cont),
            .boundary => |negated| {
                const at = (pos > 0 and m.isWord(pos - 1)) != m.isWord(pos);
                return at != negated and m.proceed(pos, cont);
            },
            .group => |alts| return m.alternatives(alts, pos, cont),
            .repeat => |*r| return m.repeat(r, 0, pos, cont),
        }
    }
};
