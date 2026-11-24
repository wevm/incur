//! Markdown command manifests for `--llms` and `--llms-full`.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");
const help = @import("help.zig");
const yaml = @import("yaml.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;

/// A command described in a manifest.
pub const CommandInfo = struct {
    /// Positional arguments schema.
    args: ?*const Type = null,
    /// What the command does.
    description: ?[]const u8 = null,
    /// Environment variables schema.
    env: ?*const Type = null,
    /// Examples with full command lines after the CLI name.
    examples: []const help.Example = &.{},
    /// Extra guidance.
    hint: ?[]const u8 = null,
    /// The subcommand path. Null for the root command.
    name: ?[]const u8 = null,
    /// Options schema.
    options: ?*const Type = null,
    /// Output schema.
    output: ?*const Type = null,
};

/// A command group's description, keyed by its path.
pub const Group = struct {
    /// The group path.
    name: []const u8,
    /// The description.
    description: []const u8,
};

/// Returns the JSON Schema type name, mapping `integer` to `number`.
fn typeName(prop: ?Value) []const u8 {
    const name = (prop orelse return "unknown").get("type") orelse return "unknown";
    return if (std.mem.eql(u8, name.string, "integer")) "number" else name.string;
}

/// Whether a JSON Schema lists `name` as required.
fn isRequired(json_schema: Value, name: []const u8) bool {
    const required = json_schema.get("required") orelse return false;
    for (required.array) |item| if (std.mem.eql(u8, item.string, name)) return true;
    return false;
}

/// Returns a property of a JSON Schema.
fn property(json_schema: Value, name: []const u8) ?Value {
    return json_schema.get("properties").?.get(name);
}

/// Returns the command line after the CLI name.
fn fullName(a: Allocator, cli: []const u8, cmd: CommandInfo) Allocator.Error![]const u8 {
    return if (cmd.name) |name| std.fmt.allocPrint(a, "{s} {s}", .{ cli, name }) else cli;
}

/// Builds a command signature with argument placeholders.
fn signature(a: Allocator, cli: []const u8, cmd: CommandInfo) Allocator.Error![]const u8 {
    const base = try fullName(a, cli, cmd);
    const args = cmd.args orelse return base;
    const js_schema = try schema.jsonSchema(a, args);
    var names: std.ArrayList([]const u8) = .empty;
    for (args.fields()) |f| {
        const array = std.mem.eql(u8, typeName(property(js_schema, f.name)), "array");
        const label = if (array) try std.mem.concat(a, u8, &.{ f.name, "..." }) else f.name;
        const required = isRequired(js_schema, f.name);
        try names.append(a, try std.mem.concat(a, u8, &.{ if (required) "<" else "[", label, if (required) ">" else "]" }));
    }
    return std.fmt.allocPrint(a, "{s} {s}", .{ base, try std.mem.join(a, " ", names.items) });
}

/// Generates the compact command index `--llms` prints.
pub fn index(a: Allocator, name: []const u8, commands: []const CommandInfo, description: ?[]const u8) Allocator.Error![]const u8 {
    var lines: std.ArrayList([]const u8) = .empty;
    try lines.append(a, try std.fmt.allocPrint(a, "# {s}", .{name}));
    if (description) |d| if (d.len > 0) try lines.appendSlice(a, &.{ "", d });
    try lines.appendSlice(a, &.{ "", "| Command | Description |", "|---------|-------------|" });
    for (commands) |cmd| try lines.append(a, try std.fmt.allocPrint(a, "| `{s}` | {s} |", .{ try signature(a, name, cmd), cmd.description orelse "" }));
    try lines.append(a, "");
    try lines.append(a, try std.fmt.allocPrint(a, "Run `{s} --llms-full` for full manifest. Run `{s} <command> --schema` for argument details.", .{ name, name }));
    return std.mem.join(a, "\n", lines.items);
}

/// Generates the full Markdown manifest `--llms-full` prints.
pub fn generate(a: Allocator, name: []const u8, commands: []const CommandInfo, groups: []const Group) Allocator.Error![]const u8 {
    var sections: std.ArrayList([]const u8) = .empty;
    if (groups.len == 0) {
        for (commands) |cmd| try sections.append(a, try body(a, name, cmd, 1));
        return std.mem.join(a, "\n\n", sections.items);
    }
    try sections.append(a, try std.fmt.allocPrint(a, "# {s}", .{name}));
    var last: ?[]const u8 = null;
    for (commands) |cmd| {
        const n = cmd.name orelse "";
        const segment = n[0 .. std.mem.findScalar(u8, n, ' ') orelse n.len];
        if (last == null or !std.mem.eql(u8, last.?, segment)) {
            last = segment;
            if (segment.len > 0) {
                const group = for (groups) |g| {
                    if (std.mem.eql(u8, g.name, segment) and g.description.len > 0) break g.description;
                } else null;
                try sections.append(a, if (group) |d|
                    try std.fmt.allocPrint(a, "## {s} {s}\n\n{s}", .{ name, segment, d })
                else
                    try std.fmt.allocPrint(a, "## {s} {s}", .{ name, segment }));
            }
        }
        try sections.append(a, try body(a, name, cmd, if (segment.len == 0) 2 else 3));
    }
    return std.mem.join(a, "\n\n", sections.items);
}

/// Renders one command's heading and sections.
fn body(a: Allocator, cli: []const u8, cmd: CommandInfo, level: usize) Allocator.Error![]const u8 {
    var sections: std.ArrayList([]const u8) = .empty;
    var heading = try std.fmt.allocPrint(a, "{s} {s}", .{ try js.repeat(a, "#", level), try fullName(a, cli, cmd) });
    if (cmd.description) |d| if (d.len > 0) {
        heading = try std.fmt.allocPrint(a, "{s}\n\n{s}", .{ heading, d });
    };
    try sections.append(a, heading);
    const sub = try js.repeat(a, "#", level + 1);

    if (cmd.args) |args| {
        const js_schema = try schema.jsonSchema(a, args);
        var rows: std.ArrayList([]const u8) = .empty;
        for (args.fields()) |f| try rows.append(a, try std.fmt.allocPrint(a, "| `{s}` | `{s}` | {s} | {s} |", .{
            f.name,
            typeName(property(js_schema, f.name)),
            if (isRequired(js_schema, f.name)) "yes" else "no",
            f.ty.description orelse "",
        }));
        try sections.append(a, try std.fmt.allocPrint(a, "{s} Arguments\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n{s}", .{ sub, try std.mem.join(a, "\n", rows.items) }));
    }

    if (cmd.env) |env| {
        const js_schema = try schema.jsonSchema(a, env);
        var rows: std.ArrayList([]const u8) = .empty;
        for (env.fields()) |f| {
            const prop = property(js_schema, f.name);
            try rows.append(a, try std.fmt.allocPrint(a, "| `{s}` | `{s}` | {s} | {s} | {s} |", .{
                f.name,
                typeName(prop),
                if (isRequired(js_schema, f.name)) "yes" else "no",
                try defaultCell(a, prop),
                f.ty.description orelse "",
            }));
        }
        try sections.append(a, try std.fmt.allocPrint(a, "{s} Environment Variables\n\n| Name | Type | Required | Default | Description |\n|------|------|----------|---------|-------------|\n{s}", .{ sub, try std.mem.join(a, "\n", rows.items) }));
    }

    if (cmd.options) |options| {
        const js_schema = try schema.jsonSchema(a, options);
        var rows: std.ArrayList([]const u8) = .empty;
        for (options.fields()) |f| {
            const prop = property(js_schema, f.name);
            const raw = f.ty.description orelse "";
            const description = if (f.ty.deprecated) try std.fmt.allocPrint(a, "**Deprecated.** {s}", .{raw}) else raw;
            try rows.append(a, try std.fmt.allocPrint(a, "| `--{s}` | `{s}` | {s} | {s} |", .{ f.name, typeName(prop), try defaultCell(a, prop), description }));
        }
        try sections.append(a, try std.fmt.allocPrint(a, "{s} Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n{s}", .{ sub, try std.mem.join(a, "\n", rows.items) }));
    }

    if (cmd.output) |output| {
        const js_schema = try schema.jsonSchema(a, output);
        try sections.append(a, if (try schemaTable(a, js_schema, "")) |table|
            try std.fmt.allocPrint(a, "{s} Output\n\n{s}", .{ sub, table })
        else
            try std.fmt.allocPrint(a, "{s} Output\n\nType: `{s}`", .{ sub, typeName(js_schema) }));
    }

    if (cmd.examples.len > 0) {
        var lines: std.ArrayList([]const u8) = .empty;
        for (cmd.examples) |example| {
            const comment = if (example.description) |d| (if (d.len > 0) try std.fmt.allocPrint(a, "# {s}\n", .{d}) else "") else "";
            try lines.append(a, try std.fmt.allocPrint(a, "{s}{s} {s}", .{ comment, cli, example.command }));
        }
        try sections.append(a, try std.fmt.allocPrint(a, "{s} Examples\n\n```sh\n{s}\n```", .{ sub, try std.mem.join(a, "\n\n", lines.items) }));
    }

    if (cmd.hint) |hint| if (hint.len > 0) try sections.append(a, try std.fmt.allocPrint(a, "> {s}", .{hint}));
    return std.mem.join(a, "\n\n", sections.items);
}

/// Formats a default value cell.
fn defaultCell(a: Allocator, prop: ?Value) Allocator.Error![]const u8 {
    const d = prop.?.get("default") orelse return "";
    const text = try json.toString(a, d);
    return if (text.len == 0) "" else std.fmt.allocPrint(a, "`{s}`", .{text});
}

/// Renders an object JSON Schema as a Markdown table, expanding nested objects.
fn schemaTable(a: Allocator, js_schema: Value, prefix: []const u8) Allocator.Error!?[]const u8 {
    const t = js_schema.get("type") orelse return null;
    if (!std.mem.eql(u8, t.string, "object")) return null;
    const properties = js_schema.get("properties").?.object;
    if (properties.len == 0) return null;
    var rows: std.ArrayList([]const u8) = .empty;
    for (properties) |entry| {
        const name = if (prefix.len == 0) entry.key else try std.fmt.allocPrint(a, "{s}.{s}", .{ prefix, entry.key });
        const prop = entry.value;
        try rows.append(a, try std.fmt.allocPrint(a, "| `{s}` | `{s}` | {s} | {s} |", .{
            name,
            typeName(prop),
            if (isRequired(js_schema, entry.key)) "yes" else "no",
            if (prop.get("description")) |d| d.string else "",
        }));
        const kind = typeName(prop);
        const nested = if (std.mem.eql(u8, kind, "object"))
            try schemaTable(a, prop, name)
        else if (std.mem.eql(u8, kind, "array"))
            try schemaTable(a, prop.get("items").?, try std.fmt.allocPrint(a, "{s}[]", .{name}))
        else
            null;
        if (nested) |table| {
            var lines = std.mem.splitScalar(u8, table, '\n');
            _ = lines.next();
            _ = lines.next();
            while (lines.next()) |l| try rows.append(a, l);
        }
    }
    return try std.fmt.allocPrint(a, "| Field | Type | Required | Description |\n|-------|------|----------|-------------|\n{s}", .{try std.mem.join(a, "\n", rows.items)});
}

/// A skill file: its directory, description, and Markdown content.
pub const File = struct {
    /// The skill name in the frontmatter.
    name: []const u8,
    /// The directory relative to the output root, empty for depth 0.
    dir: []const u8,
    /// The description in the frontmatter.
    description: []const u8,
    /// The `SKILL.md` content.
    content: []const u8,
};

/// Splits commands into skill files grouped by their first `depth` path segments, sorted by
/// directory.
/// `depth` is a JavaScript number, applied as `slice(0, depth)`.
pub fn split(a: Allocator, name: []const u8, commands: []const CommandInfo, groups: []const Group, depth: f64) Allocator.Error![]const File {
    return splitAs(a, name, name, commands, groups, depth);
}

/// Splits commands into skill files as `split` does, with the commands the files show starting
/// with `command` instead of the CLI name. Skill names still derive from `name`.
pub fn splitAs(a: Allocator, name: []const u8, command: []const u8, commands: []const CommandInfo, groups: []const Group, depth: f64) Allocator.Error![]const File {
    if (depth == 0) return a.dupe(File, &.{try renderFile(a, "", name, command, name, commands, groups, name)});
    const Bucket = struct { key: []const u8, commands: std.ArrayList(CommandInfo) = .empty };
    var buckets: std.ArrayList(Bucket) = .empty;
    for (commands) |cmd| {
        const key = if (cmd.name) |n| key: {
            const parts = try leading(a, n, depth);
            break :key try std.mem.join(a, "-", parts);
        } else try slugify(a, name);
        const bucket = for (buckets.items) |*b| {
            if (std.mem.eql(u8, b.key, key)) break b;
        } else bucket: {
            try buckets.append(a, .{ .key = key });
            break :bucket &buckets.items[buckets.items.len - 1];
        };
        try bucket.commands.append(a, cmd);
    }
    std.mem.sort(Bucket, buckets.items, {}, struct {
        fn lessThan(_: void, x: Bucket, y: Bucket) bool {
            return js.localeCompare(x.key, y.key) == .lt;
        }
    }.lessThan);
    const files = try a.alloc(File, buckets.items.len);
    for (buckets.items, files) |b, *slot| {
        const first = b.commands.items[0];
        const prefix = if (first.name) |n| prefix: {
            const parts = try leading(a, n, depth);
            break :prefix try std.mem.join(a, " ", parts);
        } else "";
        const title = if (prefix.len > 0) try std.fmt.allocPrint(a, "{s} {s}", .{ name, prefix }) else name;
        slot.* = try renderFile(a, b.key, name, command, title, b.commands.items, groups, if (prefix.len > 0) prefix else null);
    }
    return files;
}

/// Returns the first `depth` space-separated segments of a command path.
fn leading(a: Allocator, path: []const u8, depth: f64) Allocator.Error![]const []const u8 {
    var segments: std.ArrayList([]const u8) = .empty;
    var it = std.mem.splitScalar(u8, path, ' ');
    while (it.next()) |segment| try segments.append(a, segment);
    return segments.items[0..js.relativeIndex(depth, segments.items.len)];
}

/// Renders a skill file: frontmatter and command bodies. `title` names the skill; the commands
/// shown start with `command` instead of `cli`.
fn renderFile(a: Allocator, dir: []const u8, cli: []const u8, command: []const u8, title: []const u8, commands: []const CommandInfo, groups: []const Group, prefix: ?[]const u8) Allocator.Error!File {
    const group: ?[]const u8 = if (prefix) |p| for (groups) |g| {
        if (std.mem.eql(u8, g.name, p)) break g.description;
    } else null else null;
    const fallback = if (commands.len == 1) errorsNonEmpty(commands[0].description) else null;
    const shown = try std.fmt.allocPrint(a, "{s}{s}", .{ command, title[cli.len..] });
    const description = if (errorsNonEmpty(group orelse fallback)) |d|
        try std.fmt.allocPrint(a, "{s}. Run `{s} --help` for usage details.", .{ if (std.mem.endsWith(u8, d, ".")) d[0 .. d.len - 1] else d, shown })
    else
        try std.fmt.allocPrint(a, "Run `{s} --help` for usage details.", .{shown});
    // The binary the commands run, such as `bunx` for `bunx @scope/cli`.
    const bin = if (std.mem.eql(u8, command, cli)) cli else command[0 .. std.mem.indexOfScalar(u8, command, ' ') orelse command.len];
    const slug = try slugify(a, title);
    var fm: json.ObjectBuilder = .{};
    try fm.put(a, "name", .{ .string = slug });
    try fm.put(a, "description", .{ .string = description });
    try fm.put(a, "requires_bin", .{ .string = bin });
    try fm.put(a, "command", .{ .string = shown });
    const frontmatter = std.mem.trimEnd(u8, try yaml.stringifyUnfolded(a, fm.finish()), " \t\r\n");
    var bodies: std.ArrayList([]const u8) = .empty;
    for (commands) |cmd| try bodies.append(a, try body(a, command, cmd, 1));
    return .{
        .name = slug,
        .dir = dir,
        .description = description,
        .content = try std.fmt.allocPrint(a, "---\n{s}\n---\n\n{s}", .{ frontmatter, try std.mem.join(a, "\n\n---\n\n", bodies.items) }),
    };
}

/// Returns the text unless it is null or empty.
fn errorsNonEmpty(text: ?[]const u8) ?[]const u8 {
    const t = text orelse return null;
    return if (t.len == 0) null else t;
}

/// Converts text to a lowercase slug: runs of characters other than `a-z`, `0-9`, and `-` become
/// one hyphen, and leading and trailing hyphens are dropped.
pub fn slugify(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    const lower = try js.lowerString(a, text);
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < lower.len) {
        const ch = lower[i];
        if ((ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9') or ch == '-') {
            try out.append(a, ch);
            i += 1;
            continue;
        }
        while (i < lower.len and !((lower[i] >= 'a' and lower[i] <= 'z') or (lower[i] >= '0' and lower[i] <= '9') or lower[i] == '-')) i += 1;
        try out.append(a, '-');
    }
    var collapsed: std.ArrayList(u8) = .empty;
    for (out.items) |ch| {
        if (ch == '-' and collapsed.items.len > 0 and collapsed.items[collapsed.items.len - 1] == '-') continue;
        try collapsed.append(a, ch);
    }
    var result = collapsed.items;
    if (std.mem.startsWith(u8, result, "-")) result = result[1..];
    if (std.mem.endsWith(u8, result, "-")) result = result[0 .. result.len - 1];
    return result;
}

/// Computes the hash of the command structure that detects stale installed skills: the first
/// 16 hex digits of the SHA-256 of the commands as JSON.
pub fn hash(a: Allocator, commands: []const CommandInfo) Allocator.Error![]const u8 {
    const items = try a.alloc(Value, commands.len);
    for (commands, items) |cmd, *slot| {
        var entry: json.ObjectBuilder = .{};
        if (cmd.name) |n| try entry.put(a, "name", .{ .string = n });
        if (cmd.description) |d| try entry.put(a, "description", .{ .string = d });
        if (cmd.hint) |h| try entry.put(a, "hint", .{ .string = h });
        inline for (.{ .{ "args", cmd.args }, .{ "env", cmd.env }, .{ "options", cmd.options }, .{ "output", cmd.output } }) |field| {
            if (field[1]) |ty| try entry.put(a, field[0], try schema.jsonSchema(a, ty));
        }
        slot.* = entry.finish();
    }
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(try json.stringify(a, .{ .array = items }), &digest, .{});
    const hex = std.fmt.bytesToHex(digest, .lower);
    return a.dupe(u8, hex[0..16]);
}

/// A skill listed in a discovery index.
pub const Discovered = struct {
    /// The skill name.
    name: []const u8,
    /// What the skill does.
    description: []const u8,
    /// The served `SKILL.md`.
    content: []const u8,
};

/// Returns the Agent Skills discovery index (v0.2.0) with each `SKILL.md` URL and digest.
pub fn discovery(a: Allocator, origin: []const u8, skills: []const Discovered) Allocator.Error!Value {
    const items = try a.alloc(Value, skills.len);
    for (skills, items) |s, *slot| {
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(s.content, &digest, .{});
        var entry: json.ObjectBuilder = .{};
        try entry.put(a, "name", .{ .string = s.name });
        try entry.put(a, "type", .{ .string = "skill-md" });
        try entry.put(a, "description", .{ .string = s.description });
        try entry.put(a, "url", .{ .string = try std.fmt.allocPrint(a, "{s}/.well-known/agent-skills/{s}/SKILL.md", .{ origin, s.name }) });
        try entry.put(a, "digest", .{ .string = try std.fmt.allocPrint(a, "sha256:{s}", .{&std.fmt.bytesToHex(digest, .lower)}) });
        slot.* = entry.finish();
    }
    var out: json.ObjectBuilder = .{};
    try out.put(a, "$schema", .{ .string = "https://schemas.agentskills.io/discovery/0.2.0/schema.json" });
    try out.put(a, "skills", .{ .array = items });
    return out.finish();
}
