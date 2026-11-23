//! Markdown command manifests for `--llms` and `--llms-full`.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");
const help = @import("help.zig");

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
