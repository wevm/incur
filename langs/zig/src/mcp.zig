//! The MCP server: commands become tools, served over stdio (`--mcp`) and streamable HTTP
//! (`/mcp` through `Cli.fetch`).
//!
//! Tools are listed directly, or behind four discovery tools (`search_tools`,
//! `get_tool_details`, `call_read_tool`, `call_write_tool`) that let clients find a tool before
//! loading its schema.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");
const errors = @import("errors.zig");
const command = @import("command.zig");
const http = @import("http.zig");
const parser = @import("parser.zig");
const cli_ = @import("cli.zig");
const modern = @import("modern.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;
const Error = errors.Error;
const Command = command.Command;
const Middleware = command.Middleware;
const ServeError = command.ServeError;
const Cli = cli_.Cli;
const Process = cli_.Process;

/// How clients discover tools.
pub const Discovery = enum {
    /// Four discovery tools let clients search, inspect, and call tools without loading every
    /// schema up front.
    progressive,
    /// Every tool is listed with its schema.
    direct,
};

/// Which commands become tools, and how clients discover them.
pub const Filter = struct {
    /// How clients discover tools.
    discovery: Discovery = .progressive,
    /// Tool name patterns to expose, where `*` matches any characters. Empty exposes every tool.
    include: []const []const u8 = &.{},
    /// Tool name patterns to hide. Excludes win over includes.
    exclude: []const []const u8 = &.{},
};

/// Protocol versions the server accepts, newest first.
const supported_versions = [_][]const u8{ "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07" };

/// The discovery tools as `tools/list` returns them.
const discovery_tools =
    \\[{"name":"search_tools","description":"Search or page through available tools by capability. Returns names and descriptions without loading their schemas. Inspect a result before calling it.","inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"limit":{"default":5,"description":"Maximum matches.","type":"integer","minimum":1,"maximum":20},"offset":{"default":0,"description":"Matches to skip.","type":"integer","minimum":0,"maximum":9007199254740991},"query":{"default":"","description":"Capability to find. Empty lists all tools.","type":"string"}}},"annotations":{"destructiveHint":false,"idempotentHint":true,"openWorldHint":false,"readOnlyHint":true}},{"name":"get_tool_details","description":"Inspect one tool returned by search_tools. Returns its complete input schema and metadata.","inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"name":{"type":"string","minLength":1,"description":"Exact tool name."}},"required":["name"]},"annotations":{"destructiveHint":false,"idempotentHint":true,"openWorldHint":false,"readOnlyHint":true}},{"name":"call_read_tool","description":"Execute a tool marked read-only after inspecting its schema with get_tool_details.","inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"name":{"type":"string","minLength":1,"description":"Exact tool name."},"arguments":{"default":{},"description":"Arguments from its schema.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["name"]},"annotations":{"destructiveHint":false,"idempotentHint":true,"openWorldHint":true,"readOnlyHint":true}},{"name":"call_write_tool","description":"Execute a writable or unclassified tool after inspecting its schema with get_tool_details.","inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"name":{"type":"string","minLength":1,"description":"Exact tool name."},"arguments":{"default":{},"description":"Arguments from its schema.","type":"object","propertyNames":{"type":"string"},"additionalProperties":{}}},"required":["name"]},"annotations":{"destructiveHint":true,"idempotentHint":false,"openWorldHint":true,"readOnlyHint":false}}]
;

/// The input schema of `search_tools`.
const search_input: Type = .{ .kind = .{ .object = &.{
    .{ .name = "limit", .ty = .{ .kind = .{ .integer = .{ .min = 1, .max = 20 } }, .default = .{ .integer = 5 } } },
    .{ .name = "offset", .ty = .{ .kind = .{ .integer = .{ .min = 0 } }, .default = .{ .integer = 0 } } },
    .{ .name = "query", .ty = .{ .kind = .{ .string = .{} }, .default = .{ .string = "" } } },
} } };

/// The input schema of `get_tool_details`, and the `name` of the call tools.
const name_input: Type = .{ .kind = .{ .object = &.{
    .{ .name = "name", .ty = .{ .kind = .{ .string = .{ .min = 1 } } } },
} } };

/// A command exposed as a tool.
pub const Tool = struct {
    /// The tool name.
    name: []const u8,
    /// The description.
    description: ?[]const u8,
    /// The command.
    command: *const Command,
    /// Group middleware around the command.
    middleware: []const Middleware,
    /// Behavior annotations as JSON.
    annotations: ?Value,
    /// Usage guidance.
    instructions: ?[]const u8,
    /// The output schema, when the command's output is an object.
    output: ?Value,
};

/// The tools of a CLI, or why they cannot be served.
pub const Tools = union(enum) {
    ok: []const Tool,
    err: Error,
};

/// Values for tool calls that do not pass their own: the globals and config file of `--mcp`.
/// They become the defaults of the tool input schemas.
pub const Defaults = struct {
    /// Parsed global option values.
    globals: []const Value.Entry = &.{},
    /// The config tree, whose command sections are validated when the tools are collected.
    config: ?Value = null,
};

/// Returns an object schema with parsed values as the defaults of their fields.
fn withDefaults(a: Allocator, ty: *const Type, values: []const Value.Entry) Allocator.Error!*const Type {
    const fields = try a.dupe(schema.Field, ty.fields());
    for (fields) |*f| for (values) |entry| if (std.mem.eql(u8, entry.key, f.name)) {
        f.ty.default = entry.value;
        // `.default()` wraps a converted schema: its JSON leads with the new default, and the
        // field is no longer optional.
        const emitted = f.ty.json orelse continue;
        f.ty.optional = false;
        f.ty.optional_outer = false;
        const json_ = try a.create(schema.Emitted);
        json_.* = .{ .output = try withDefault(a, emitted.output, entry.value), .input = try withDefault(a, emitted.input, entry.value) };
        f.ty.json = json_;
    };
    const out = try a.create(Type);
    out.* = ty.*;
    out.kind = .{ .object = fields };
    return out;
}

/// Returns a JSON Schema node led by `default`, replacing any default it has.
fn withDefault(a: Allocator, node: Value, value: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "default", value);
    for (node.object) |entry| if (!std.mem.eql(u8, entry.key, "default")) try out.put(a, entry.key, entry.value);
    return out.finish();
}

/// Collects the CLI's commands as tools, filtered and sorted by name. Each command's section of
/// the config tree becomes its option defaults.
pub fn collect(a: Allocator, cli: *const Cli, filter: Filter, config: ?Value) Allocator.Error!Tools {
    var all: std.ArrayList(Tool) = .empty;
    if (try collectEntries(a, &all, cli, config, cli.commands.items, &.{}, &.{})) |e| return .{ .err = e };
    var tools: std.ArrayList(Tool) = .empty;
    for (all.items) |tool| {
        const excluded = for (filter.exclude) |pattern| {
            if (glob(pattern, tool.name)) break true;
        } else false;
        if (excluded) continue;
        const included = filter.include.len == 0 or for (filter.include) |pattern| {
            if (glob(pattern, tool.name)) break true;
        } else false;
        if (included) try tools.append(a, tool);
    }
    for (tools.items, 0..) |tool, i| for (tools.items[0..i]) |seen| {
        if (std.mem.eql(u8, seen.name, tool.name))
            return .{ .err = .{ .message = try std.fmt.allocPrint(a, "Duplicate MCP tool name: {s}", .{tool.name}) } };
    };
    std.mem.sort(Tool, tools.items, {}, struct {
        fn lessThan(_: void, x: Tool, y: Tool) bool {
            return js.localeCompare(x.name, y.name) == .lt;
        }
    }.lessThan);
    return .{ .ok = tools.items };
}

/// Adds the tools of a command list. Returns the first invalid config section.
fn collectEntries(a: Allocator, out: *std.ArrayList(Tool), cli: *const Cli, config: ?Value, commands: cli_.Commands, prefix: []const []const u8, middleware: []const Middleware) Allocator.Error!?Error {
    for (commands) |n| {
        const path = try std.mem.concat(a, []const u8, &.{ prefix, &.{n.name} });
        switch (n.entry) {
            // Fetch-backed commands take raw requests, not tool arguments.
            .alias, .gateway => {},
            .command => |c| if (c.mcp) |settings| switch (try toTool(a, cli, config, c, settings, path, middleware)) {
                .ok => |tool| try out.append(a, tool),
                .err => |e| return e,
            },
            .group => |g| if (g.options.mcp != null) {
                const group_middleware = try std.mem.concat(a, Middleware, &.{ middleware, g.middleware.items });
                if (g.options.root) |*root| if (root.mcp) |settings| switch (try toTool(a, cli, config, root, settings, path, group_middleware)) {
                    .ok => |tool| try out.append(a, tool),
                    .err => |e| return e,
                };
                if (try collectEntries(a, out, cli, config, g.commands.items, path, group_middleware)) |e| return e;
            },
        }
    }
    return null;
}

/// Builds a tool from a command, with its config section as option defaults.
fn toTool(a: Allocator, cli: *const Cli, config: ?Value, original: *const Command, settings: command.Tool, path: []const []const u8, middleware: []const Middleware) Allocator.Error!parser.Result(Tool) {
    // Config values become option defaults, so a call's own arguments still win.
    const c = if (config) |root| c: {
        const section = switch (try cli_.configSection(a, root, cli.name, try std.mem.join(a, " ", path))) {
            .ok => |section| section orelse break :c original,
            .err => |e| return .{ .err = e },
        };
        const values = switch (try parser.parseDefaults(a, section, original.options())) {
            .ok => |v| v,
            .err => |e| return .{ .err = e },
        };
        // Without options, any key fails above, so the section reaches only commands with options.
        const copy = try a.create(Command);
        copy.* = original.*;
        copy.run.?.options = try withDefaults(a, original.options().?, values.object);
        break :c copy;
    } else original;
    const output: ?Value = if (c.output) |o| output: {
        const value = try schema.jsonSchema(a, o);
        const kind = value.get("type") orelse break :output null;
        break :output if (kind == .string and std.mem.eql(u8, kind.string, "object")) value else null;
    } else null;
    return .{ .ok = .{
        .name = settings.name orelse try std.mem.join(a, "_", path),
        .description = settings.description orelse c.description,
        .command = c,
        .middleware = middleware,
        .annotations = try settings.annotationsValue(a),
        .instructions = settings.instructions,
        .output = output,
    } };
}

/// Whether a name matches a pattern where `*` matches any characters.
fn glob(pattern: []const u8, name: []const u8) bool {
    const star = std.mem.findScalar(u8, pattern, '*') orelse return std.mem.eql(u8, pattern, name);
    if (!std.mem.startsWith(u8, name, pattern[0..star])) return false;
    const rest = pattern[star + 1 ..];
    var i = star;
    while (i <= name.len) : (i += 1) if (glob(rest, name[i..])) return true;
    return false;
}

/// A JSON-RPC message's role.
const Kind = modern.Kind;

/// Classifies a message as the MCP SDK's JSON-RPC schemas do.
fn classify(message: Value) Kind {
    if (message != .object) return .invalid;
    const version = message.get("jsonrpc") orelse return .invalid;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return .invalid;
    const id = message.get("id");
    if (id) |i| if (!isId(i)) return .invalid;
    if (message.get("method")) |method| {
        if (method != .string) return .invalid;
        if (message.get("params")) |params| {
            if (params != .object) return .invalid;
            if (params.get("_meta")) |meta| {
                if (meta != .object) return .invalid;
                if (meta.get("progressToken")) |token| if (!isId(token)) return .invalid;
            }
        }
        if (!onlyKeys(message, &.{ "jsonrpc", "id", "method", "params" })) return .invalid;
        return if (id != null) .request else .notification;
    }
    if (message.get("result")) |result| {
        if (id == null or result != .object or !onlyKeys(message, &.{ "jsonrpc", "id", "result" })) return .invalid;
        return .response;
    }
    const e = message.get("error") orelse return .invalid;
    if (e != .object or !onlyKeys(message, &.{ "jsonrpc", "id", "error" })) return .invalid;
    const code = e.get("code") orelse return .invalid;
    const text = e.get("message") orelse return .invalid;
    if (code != .integer or text != .string) return .invalid;
    return .response;
}

/// Whether a value is a JSON-RPC id or progress token: a string or an integer.
fn isId(value: Value) bool {
    return value == .string or value == .integer or (value == .float and @trunc(value.float) == value.float);
}

/// Whether an object has no keys beyond `allowed`.
fn onlyKeys(object: Value, allowed: []const []const u8) bool {
    for (object.object) |entry| {
        for (allowed) |key| {
            if (std.mem.eql(u8, key, entry.key)) break;
        } else return false;
    }
    return true;
}

/// Serves tools to one client connection.
const Server = struct {
    a: Allocator,
    cli: *Cli,
    process: *const Process,
    /// The HTTP request the messages arrived in, passed to commands.
    request: ?*const http.Request = null,
    /// Where progress notifications go, or null to drop them.
    notifications: ?*std.Io.Writer = null,
    tools: []const Tool,
    direct: bool,
    name: []const u8,
    /// The global options schema, with the server's globals as defaults.
    globals: ?*const Type,

    fn init(a: Allocator, cli: *Cli, process: *const Process, direct: bool, defaults: Defaults) Allocator.Error!union(enum) { ok: Server, err: Error } {
        const settings = cli.options.mcp orelse cli_.Mcp{};
        var filter = settings.tools;
        if (direct) filter.discovery = .direct;
        // Default values become schema defaults, so a call's own arguments still win.
        const globals = if (cli.options.globals) |g| try withDefaults(a, g, defaults.globals) else null;
        return switch (try collect(a, cli, filter, defaults.config)) {
            .err => |e| .{ .err = e },
            .ok => |tools| .{ .ok = .{
                .a = a,
                .cli = cli,
                .process = process,
                .globals = globals,
                .tools = tools,
                .direct = filter.discovery == .direct,
                .name = settings.name orelse cli.name,
            } },
        };
    }

    /// Answers a request, or returns null for messages without responses.
    fn handle(s: *Server, message: Value) ServeError!?Value {
        if (classify(message) != .request) return null;
        const a = s.a;
        const id = message.get("id").?;
        const method = message.get("method").?.string;
        const params = message.get("params") orelse Value{ .object = &.{} };
        const result: Value = if (std.mem.eql(u8, method, "initialize"))
            try s.initialize(params)
        else if (std.mem.eql(u8, method, "ping"))
            .{ .object = &.{} }
        else if (std.mem.eql(u8, method, "tools/list"))
            try s.list()
        else if (std.mem.eql(u8, method, "tools/call")) result: {
            const name = if (params.get("name")) |n| (if (n == .string) n.string else "") else "";
            break :result try s.call(name, params) orelse
                return try rpcError(a, id, -32602, try std.fmt.allocPrint(a, "Tool {s} not found", .{name}));
        } else return try rpcError(a, id, -32601, "Method not found");
        var out: json.ObjectBuilder = .{};
        try out.put(a, "result", result);
        try out.put(a, "jsonrpc", .{ .string = "2.0" });
        try out.put(a, "id", id);
        return out.finish();
    }

    /// Returns the server's name, title, and version.
    fn identity(s: *Server) Allocator.Error!Value {
        const a = s.a;
        const settings = s.cli.options.mcp orelse cli_.Mcp{};
        var out: json.ObjectBuilder = .{};
        try out.put(a, "name", .{ .string = s.name });
        if (errors.nonEmpty(settings.title)) |t| try out.put(a, "title", .{ .string = t });
        try out.put(a, "version", .{ .string = s.cli.options.version orelse "0.0.0" });
        return out.finish();
    }

    /// Answers a request under protocol revision 2026-07-28, or returns null for messages
    /// without responses. Sets `unknown` for an unknown method.
    fn handleModern(s: *Server, message: Value, unknown: *bool) ServeError!?Value {
        if (classify(message) != .request) return null;
        const a = s.a;
        const id = message.get("id").?;
        const method = message.get("method").?.string;
        const params = message.get("params") orelse Value{ .object = &.{} };
        const discover = std.mem.eql(u8, method, "server/discover");
        if (!discover and !std.mem.eql(u8, method, "tools/list") and !std.mem.eql(u8, method, "tools/call")) {
            unknown.* = true;
            return try rpcError(a, id, -32601, "Method not found");
        }
        if (try modern.envelopeError(a, params)) |text| return try rpcError(a, id, -32602, text);
        const response = if (discover) response: {
            const settings = s.cli.options.mcp orelse cli_.Mcp{};
            var tools: json.ObjectBuilder = .{};
            try tools.put(a, "listChanged", .{ .bool = true });
            var capabilities: json.ObjectBuilder = .{};
            try capabilities.put(a, "tools", tools.finish());
            var result: json.ObjectBuilder = .{};
            try result.put(a, "supportedVersions", .{ .array = try a.dupe(Value, &.{.{ .string = modern.version }}) });
            try result.put(a, "capabilities", capabilities.finish());
            if (errors.nonEmpty(settings.instructions)) |i| try result.put(a, "instructions", .{ .string = i });
            var out: json.ObjectBuilder = .{};
            try out.put(a, "result", result.finish());
            try out.put(a, "jsonrpc", .{ .string = "2.0" });
            try out.put(a, "id", id);
            break :response out.finish();
        } else (try s.handle(message)).?;
        const result = response.get("result") orelse return response;
        var out: json.ObjectBuilder = .{};
        for (response.object) |entry| try out.put(a, entry.key, entry.value);
        try out.put(a, "result", try modern.encode(a, method, result, try s.identity()));
        return out.finish();
    }

    /// Answers `initialize`.
    fn initialize(s: *Server, params: Value) Allocator.Error!Value {
        const a = s.a;
        const settings = s.cli.options.mcp orelse cli_.Mcp{};
        const requested = if (params.get("protocolVersion")) |v| (if (v == .string) v.string else "") else "";
        const version = for (supported_versions) |v| {
            if (std.mem.eql(u8, v, requested)) break v;
        } else supported_versions[0];
        var tools: json.ObjectBuilder = .{};
        try tools.put(a, "listChanged", .{ .bool = true });
        var capabilities: json.ObjectBuilder = .{};
        try capabilities.put(a, "tools", tools.finish());
        var out: json.ObjectBuilder = .{};
        try out.put(a, "protocolVersion", .{ .string = version });
        try out.put(a, "capabilities", capabilities.finish());
        try out.put(a, "serverInfo", try s.identity());
        if (errors.nonEmpty(settings.instructions)) |i| try out.put(a, "instructions", .{ .string = i });
        return out.finish();
    }

    /// Answers `tools/list`.
    fn list(s: *Server) ServeError!Value {
        const a = s.a;
        const items: []const Value = if (s.tools.len == 0)
            &.{}
        else if (!s.direct) items: {
            var message: []const u8 = undefined;
            break :items (try command.optional(json.parse(a, discovery_tools, &message))).?.array;
        } else items: {
            const items = try a.alloc(Value, s.tools.len);
            for (s.tools, items) |tool, *slot| {
                var entry: json.ObjectBuilder = .{};
                try entry.put(a, "name", .{ .string = tool.name });
                if (tool.description) |d| try entry.put(a, "description", .{ .string = d });
                try entry.put(a, "inputSchema", try s.directSchema(&tool));
                if (tool.annotations) |an| try entry.put(a, "annotations", an);
                if (errors.nonEmpty(tool.instructions)) |i| {
                    var meta: json.ObjectBuilder = .{};
                    try meta.put(a, "instructions", .{ .string = i });
                    try entry.put(a, "_meta", meta.finish());
                }
                if (tool.output) |o| try entry.put(a, "outputSchema", o);
                slot.* = entry.finish();
            }
            break :items items;
        };
        var out: json.ObjectBuilder = .{};
        try out.put(a, "tools", .{ .array = items });
        return out.finish();
    }

    /// Returns the merged arguments, options, and globals of a directly listed tool. A later
    /// field replaces an earlier one with the same name in place.
    fn mergedType(s: *Server, tool: *const Tool) Allocator.Error!Type {
        var fields: std.ArrayList(schema.Field) = .empty;
        for ([_]?*const Type{ tool.command.args(), tool.command.options(), s.globals }) |ty| {
            const t = ty orelse continue;
            for (t.fields()) |f| {
                for (fields.items) |*existing| {
                    if (std.mem.eql(u8, existing.name, f.name)) {
                        existing.* = f;
                        break;
                    }
                } else try fields.append(s.a, f);
            }
        }
        return .{ .kind = .{ .object = fields.items } };
    }

    /// Returns the input schema `tools/list` shows for a directly listed tool.
    fn directSchema(s: *Server, tool: *const Tool) Allocator.Error!Value {
        const a = s.a;
        const merged = try s.mergedType(tool);
        var out: json.ObjectBuilder = .{};
        try out.put(a, "type", .{ .string = "object" });
        if (merged.fields().len == 0) {
            try out.put(a, "properties", .{ .object = &.{} });
            return out.finish();
        }
        try out.put(a, "$schema", .{ .string = "https://json-schema.org/draft/2020-12/schema" });
        const generated = try schema.jsonSchemaIo(a, &merged, .input);
        for (generated.object) |entry| if (!std.mem.eql(u8, entry.key, "type")) try out.put(a, entry.key, entry.value);
        return out.finish();
    }

    /// Returns the input schema `get_tool_details` shows: the output-mode schemas of the
    /// arguments, options, and globals, merged.
    fn detailSchema(s: *Server, tool: *const Tool) Allocator.Error!Value {
        const a = s.a;
        var properties: json.ObjectBuilder = .{};
        var required: std.ArrayList(Value) = .empty;
        for ([_]?*const Type{ tool.command.args(), tool.command.options(), s.globals }) |ty| {
            const t = ty orelse continue;
            const generated = try schema.jsonSchema(a, t);
            if (generated.get("properties")) |p| for (p.object) |entry| try properties.put(a, entry.key, entry.value);
            if (generated.get("required")) |r| try required.appendSlice(a, r.array);
        }
        var out: json.ObjectBuilder = .{};
        try out.put(a, "type", .{ .string = "object" });
        try out.put(a, "properties", properties.finish());
        if (required.items.len > 0) try out.put(a, "required", .{ .array = required.items });
        return out.finish();
    }

    /// Calls a listed tool. Returns null for unknown tools.
    fn call(s: *Server, name: []const u8, params: Value) ServeError!?Value {
        const a = s.a;
        if (s.tools.len == 0) return null;
        const arguments = params.get("arguments") orelse Value{ .object = &.{} };
        const token = if (params.get("_meta")) |meta| meta.get("progressToken") else null;
        if (s.direct) {
            const tool = s.find(name) orelse return null;
            const merged = try s.mergedType(tool);
            const parsed = switch (try validateInput(a, &merged, arguments, name)) {
                .ok => |v| v,
                .err => |text| return try toolText(a, text, true),
            };
            return try s.callTool(tool, parsed, true, token);
        }
        const discovery = [_][]const u8{ "search_tools", "get_tool_details", "call_read_tool", "call_write_tool" };
        const index = for (discovery, 0..) |d, i| {
            if (std.mem.eql(u8, d, name)) break i;
        } else return null;
        if (index == 0) {
            const input = switch (try validateInput(a, &search_input, arguments, name)) {
                .ok => |v| v,
                .err => |text| return try toolText(a, text, true),
            };
            return try toolResult(a, try s.search(input.get("query").?.string, input.get("limit").?, input.get("offset").?));
        }
        var input = switch (try validateInput(a, &name_input, arguments, name)) {
            .ok => |v| v,
            .err => |text| return try toolText(a, text, true),
        };
        const tool_name = input.get("name").?.string;
        var call_arguments: Value = .{ .object = &.{} };
        if (index > 1) {
            // The call tools also take `arguments`, a record that defaults to `{}`.
            if (arguments == .object) if (arguments.get("arguments")) |value| {
                if (value != .object) {
                    const message = try std.fmt.allocPrint(a, "Input validation error: Invalid arguments for tool {s}: arguments: Invalid input: expected record, received {s}", .{ name, typeName(value) });
                    return try toolText(a, message, true);
                }
                call_arguments = value;
            };
            input = .null;
        }
        const tool = s.find(tool_name) orelse return try toolError(a, try std.fmt.allocPrint(a, "Unknown tool: {s}", .{tool_name}));
        if (index == 1) return try toolResult(a, try s.details(tool));
        const read_only = if (tool.annotations) |an| if (an.get("readOnlyHint")) |r| r == .bool and r.bool else false else false;
        if (index == 2 and !read_only) return try toolError(a, try std.fmt.allocPrint(a, "Tool is not read-only: {s}", .{tool_name}));
        if (index == 3 and read_only) return try toolError(a, try std.fmt.allocPrint(a, "Tool is read-only: {s}", .{tool_name}));
        return try s.callTool(tool, call_arguments, false, token);
    }

    /// Returns the tool with a name.
    fn find(s: *Server, name: []const u8) ?*const Tool {
        for (s.tools) |*tool| if (std.mem.eql(u8, tool.name, name)) return tool;
        return null;
    }

    /// Answers `search_tools`.
    fn search(s: *Server, query: []const u8, limit: Value, offset: Value) Allocator.Error!Value {
        const a = s.a;
        const normalized = try normalizeSearch(a, query);
        var terms: std.ArrayList([]const u8) = .empty;
        var it = std.mem.tokenizeScalar(u8, normalized, ' ');
        while (it.next()) |term| try terms.append(a, term);
        const Scored = struct { tool: *const Tool, score: u32 };
        var matches: std.ArrayList(Scored) = .empty;
        for (s.tools) |*tool| {
            const score = try toolScore(a, tool, normalized, terms.items);
            if (score > 0) try matches.append(a, .{ .tool = tool, .score = score });
        }
        std.mem.sort(Scored, matches.items, {}, struct {
            fn lessThan(_: void, x: Scored, y: Scored) bool {
                if (x.score != y.score) return x.score > y.score;
                return js.localeCompare(x.tool.name, y.tool.name) == .lt;
            }
        }.lessThan);
        const start: usize = @intCast(@min(offset.integer, matches.items.len));
        const end: usize = @intCast(@min(@as(i128, start) + limit.integer, matches.items.len));
        const page = try a.alloc(Value, end - start);
        for (matches.items[start..end], page) |m, *slot| {
            var entry: json.ObjectBuilder = .{};
            try entry.put(a, "name", .{ .string = m.tool.name });
            if (errors.nonEmpty(m.tool.description)) |d| try entry.put(a, "description", .{ .string = d });
            if (m.tool.annotations) |an| try entry.put(a, "annotations", an);
            slot.* = entry.finish();
        }
        var out: json.ObjectBuilder = .{};
        try out.put(a, "tools", .{ .array = page });
        if (end < matches.items.len) try out.put(a, "nextOffset", .{ .integer = end });
        return out.finish();
    }

    /// Answers `get_tool_details`.
    fn details(s: *Server, tool: *const Tool) Allocator.Error!Value {
        const a = s.a;
        var out: json.ObjectBuilder = .{};
        try out.put(a, "name", .{ .string = tool.name });
        if (errors.nonEmpty(tool.description)) |d| try out.put(a, "description", .{ .string = d });
        try out.put(a, "inputSchema", try s.detailSchema(tool));
        if (tool.output) |o| try out.put(a, "outputSchema", o);
        if (tool.annotations) |an| try out.put(a, "annotations", an);
        if (errors.nonEmpty(tool.instructions)) |i| try out.put(a, "instructions", .{ .string = i });
        return out.finish();
    }

    /// Runs a tool's command and returns its call result.
    fn callTool(s: *Server, tool: *const Tool, params: Value, parsed: bool, token: ?Value) ServeError!Value {
        const a = s.a;
        const cli = s.cli;
        var globals: Value = .{ .object = &.{} };
        var input = params;
        if (s.globals) |globals_schema| {
            var raw: json.ObjectBuilder = .{};
            var rest: json.ObjectBuilder = .{};
            if (params == .object) for (params.object) |entry| {
                const is_global = globals_schema.field(entry.key) != null;
                const is_arg = if (tool.command.args()) |args| args.field(entry.key) != null else false;
                if (is_global) try raw.put(a, entry.key, entry.value);
                if (!is_global or is_arg) try rest.put(a, entry.key, entry.value);
            };
            input = rest.finish();
            globals = if (parsed) raw.finish() else switch (try parser.validate(a, globals_schema, raw.finish())) {
                .ok => |v| v,
                .err => |e| return toolText(a, try json.stringify(a, try e.toValue(a)), true),
            };
        }
        var collector: Collector = .{ .server = s, .token = token };
        const exec: cli_.Exec = .{
            .a = a,
            .process = s.process,
            .cli = cli,
            .display_name = s.name,
            .agent = true,
            .format = .json,
            .format_explicit = true,
            .globals = globals,
            .request = s.request,
            .sink = .{ .context = &collector, .consume = Collector.consume },
        };
        const result = try exec.run(tool.command, tool.middleware, tool.name, .{ .flat = input });
        return switch (result) {
            .err => |e| s.failure(e),
            .streamed => streamed: {
                const cta = try errors.FormattedCtaBlock.init(a, s.name, collector.cta);
                break :streamed s.success(try json.stringify(a, .{ .array = collector.chunks.items }), cta, null);
            },
            .ok => |r| ok: {
                const data = r.data orelse Value.null;
                const cta = try errors.FormattedCtaBlock.init(a, s.name, r.cta);
                const structured = if (data != .null and tool.output != null) data else null;
                break :ok s.success(try json.stringify(a, data), cta, structured);
            },
        };
    }

    /// Returns a successful call result.
    fn success(s: *Server, text: []const u8, cta: ?errors.FormattedCtaBlock, structured: ?Value) Allocator.Error!Value {
        const a = s.a;
        var out: json.ObjectBuilder = .{};
        if (cta) |c| {
            var meta: json.ObjectBuilder = .{};
            try meta.put(a, "cta", try c.toValue(a));
            try out.put(a, "_meta", meta.finish());
        }
        const full = if (cta) |c| try std.fmt.allocPrint(a, "{s}\n\n{s}", .{ text, try renderCta(a, c) }) else text;
        try out.put(a, "content", try textContent(a, full));
        if (structured) |v| try out.put(a, "structuredContent", v);
        return out.finish();
    }

    /// Returns a failed command as a tool error.
    fn failure(s: *Server, e: Error) Allocator.Error!Value {
        const a = s.a;
        const cta = try errors.FormattedCtaBlock.init(a, s.name, e.cta);
        var text: std.ArrayList(u8) = .empty;
        try text.appendSlice(a, if (e.field_errors != null) try json.stringify(a, try e.toValue(a)) else e.message);
        if (e.hint) |hint| try text.print(a, "\nHint: {s}", .{hint});
        if (cta) |c| try text.print(a, "\n\n{s}", .{try renderCta(a, c)});
        var info: json.ObjectBuilder = .{};
        try info.put(a, "code", .{ .string = e.code });
        if (e.exit_code) |code| try info.put(a, "exitCode", .{ .integer = code });
        if (e.retryable) |r| try info.put(a, "retryable", .{ .bool = r });
        var meta: json.ObjectBuilder = .{};
        if (cta) |c| try meta.put(a, "cta", try c.toValue(a));
        try meta.put(a, "error", info.finish());
        var out: json.ObjectBuilder = .{};
        try out.put(a, "_meta", meta.finish());
        try out.put(a, "content", try textContent(a, text.items));
        try out.put(a, "isError", .{ .bool = true });
        return out.finish();
    }

    /// Sends a progress notification.
    fn progress(s: *Server, token: Value, index: usize, chunk: Value) Allocator.Error!void {
        const writer = s.notifications orelse return;
        const a = s.a;
        var params: json.ObjectBuilder = .{};
        try params.put(a, "progressToken", token);
        try params.put(a, "progress", .{ .integer = index });
        try params.put(a, "message", .{ .string = try json.stringify(a, chunk) });
        var out: json.ObjectBuilder = .{};
        try out.put(a, "jsonrpc", .{ .string = "2.0" });
        try out.put(a, "method", .{ .string = "notifications/progress" });
        try out.put(a, "params", params.finish());
        writeLine(writer, try json.stringify(a, out.finish()));
    }
};

/// Buffers a tool's stream and reports each chunk as progress.
const Collector = struct {
    server: *Server,
    token: ?Value,
    chunks: std.ArrayList(Value) = .empty,
    cta: ?errors.CtaBlock = null,

    fn consume(context: *anyopaque, stream: command.Stream, cta: ?errors.CtaBlock) ServeError!cli_.ExecResult {
        const c: *Collector = @ptrCast(@alignCast(context));
        const s = c.server;
        var failure: command.Failure = .{};
        while (true) {
            const next = stream.next(stream.context, s.process.io, s.a) catch |err| return .{ .err = try failure.take(err) };
            switch (next orelse break) {
                .failure => |e| return .{ .err = e },
                .data => |raw| {
                    const value = try json.normalize(s.a, raw);
                    try c.chunks.append(s.a, value);
                    if (c.token) |token| try s.progress(token, c.chunks.items.len, value);
                },
            }
        }
        c.cta = cta;
        return .streamed;
    }
};

/// Validates tool input as the MCP SDK does, applying defaults and stripping unknown keys.
/// Returns the parsed input or the error text.
fn validateInput(a: Allocator, ty: *const Type, arguments: Value, name: []const u8) Allocator.Error!union(enum) { ok: Value, err: []const u8 } {
    var v: schema.Validator = .{ .a = a };
    const parsed = try v.parse(ty, arguments);
    if (v.issues.items.len == 0) return .{ .ok = parsed orelse .{ .object = &.{} } };
    var issues: std.ArrayList([]const u8) = .empty;
    for (v.issues.items) |issue| {
        var parts: std.ArrayList([]const u8) = .empty;
        for (issue.path) |part| try parts.append(a, try json.toString(a, part));
        try issues.append(a, if (parts.items.len == 0) issue.message else try std.fmt.allocPrint(a, "{s}: {s}", .{ try std.mem.join(a, ".", parts.items), issue.message }));
    }
    return .{ .err = try std.fmt.allocPrint(a, "Input validation error: Invalid arguments for tool {s}: {s}", .{ name, try std.mem.join(a, ", ", issues.items) }) };
}

/// Returns Zod's name for a value's type.
fn typeName(value: Value) []const u8 {
    return switch (value) {
        .array => "array",
        .bool => "boolean",
        .null => "null",
        .integer, .big_integer, .float => "number",
        .object => "object",
        .string => "string",
    };
}

/// Normalizes text for search: lowercase, with runs of other characters as single spaces.
fn normalizeSearch(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    const lower = try js.lowerString(a, text);
    var out: std.ArrayList(u8) = .empty;
    var gap = false;
    for (lower) |ch| {
        if ((ch >= 'a' and ch <= 'z') or (ch >= '0' and ch <= '9')) {
            if (gap and out.items.len > 0) try out.append(a, ' ');
            gap = false;
            try out.append(a, ch);
        } else gap = true;
    }
    return out.items;
}

/// Scores a tool against a search query.
fn toolScore(a: Allocator, tool: *const Tool, query: []const u8, terms: []const []const u8) Allocator.Error!u32 {
    const name = try normalizeSearch(a, tool.name);
    const description = try normalizeSearch(a, tool.description orelse "");
    if (std.mem.eql(u8, name, query)) return 1000;
    var score: u32 = if (std.mem.startsWith(u8, name, query)) 100 else if (std.mem.find(u8, name, query) != null) 50 else 0;
    for (terms) |term| {
        var words = std.mem.splitScalar(u8, name, ' ');
        const word = while (words.next()) |w| {
            if (std.mem.eql(u8, w, term)) break true;
        } else false;
        if (word) score += 20 else if (std.mem.find(u8, name, term) != null) score += 10;
        if (std.mem.find(u8, description, term) != null) score += 2;
    }
    return score;
}

/// Renders suggestions as plain text for tool output.
fn renderCta(a: Allocator, block: errors.FormattedCtaBlock) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, block.description);
    for (block.commands) |c| {
        try out.print(a, "\n  {s}", .{c.command});
        if (c.description) |d| try out.print(a, " - {s}", .{d});
    }
    return out.items;
}

/// Returns a one-item text content array.
fn textContent(a: Allocator, text: []const u8) Allocator.Error!Value {
    var item: json.ObjectBuilder = .{};
    try item.put(a, "type", .{ .string = "text" });
    try item.put(a, "text", .{ .string = text });
    return .{ .array = try a.dupe(Value, &.{item.finish()}) };
}

/// Returns a call result with text content.
fn toolText(a: Allocator, text: []const u8, is_error: bool) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "content", try textContent(a, text));
    if (is_error) try out.put(a, "isError", .{ .bool = true });
    return out.finish();
}

/// Returns a call result with a JSON value as text.
fn toolResult(a: Allocator, value: Value) Allocator.Error!Value {
    return toolText(a, try json.stringify(a, value), false);
}

/// Returns a call result reporting an error message.
fn toolError(a: Allocator, message: []const u8) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "error", .{ .string = message });
    return toolText(a, try json.stringify(a, out.finish()), true);
}

/// Returns a JSON-RPC error response.
fn rpcError(a: Allocator, id: ?Value, code: i64, message: []const u8) Allocator.Error!Value {
    var e: json.ObjectBuilder = .{};
    try e.put(a, "code", .{ .integer = code });
    try e.put(a, "message", .{ .string = message });
    var out: json.ObjectBuilder = .{};
    try out.put(a, "jsonrpc", .{ .string = "2.0" });
    try out.put(a, "id", id orelse .null);
    try out.put(a, "error", e.finish());
    return out.finish();
}

/// Writes a line and flushes it to the client.
fn writeLine(writer: *std.Io.Writer, text: []const u8) void {
    writer.writeAll(text) catch {};
    writer.writeByte('\n') catch {};
    writer.flush() catch {};
}

/// Serves MCP over the process's stdin and stdout, one JSON-RPC message per line, until the
/// input ends. Returns the error when the tools cannot be served.
pub fn serveStdio(a: Allocator, cli: *Cli, process: *const Process, defaults: Defaults) ServeError!?Error {
    var server = switch (try Server.init(a, cli, process, false, defaults)) {
        .ok => |s| s,
        .err => |e| return e,
    };
    server.notifications = process.stdout;
    const reader = process.stdin orelse return null;
    var era: Era = .opening;
    var line: std.Io.Writer.Allocating = .init(a);
    while (true) {
        line.clearRetainingCapacity();
        // An unreadable input ends the session like a closed one.
        _ = reader.streamDelimiterEnding(&line.writer, '\n') catch |err| return if (err == error.WriteFailed) error.OutOfMemory else null;
        // Only complete lines are messages.
        if (reader.bufferedLen() == 0) return null;
        reader.toss(1);
        var message: []const u8 = undefined;
        const value = try command.optional(json.parse(a, line.written(), &message)) orelse continue;
        const kind = classify(value);
        if (kind == .invalid) continue;
        // The opening message picks the era: a 2026-07-28 envelope pins the connection to
        // per-request `_meta` serving (after any `server/discover` probes), anything else to
        // the 2025 handshake.
        if (era == .opening or era == .probe) {
            const opened = try openStdio(a, value, kind, process.stdout) orelse continue;
            const discover = kind == .request and std.mem.eql(u8, value.get("method").?.string, "server/discover");
            era = if (opened == .legacy) .legacy else if (discover) .probe else if (era == .opening or kind == .request) .modern else era;
        }
        const params = value.get("params") orelse Value{ .object = &.{} };
        var unknown = false;
        const response = if (era == .legacy)
            try server.handle(value)
        else if (kind == .request and std.mem.eql(u8, value.get("method").?.string, "initialize") and !try modern.validClaim(a, params))
            try (try modern.initializeReject(a, params)).response(a, value.get("id").?)
        else
            try server.handleModern(value, &unknown);
        if (response) |r| writeLine(process.stdout, try json.stringify(a, r));
    }
}

/// The protocol era of an MCP stdio connection.
const Era = enum { opening, probe, modern, legacy };

/// Classifies a message on a stdio connection without an era. Returns null after answering or
/// dropping it.
fn openStdio(a: Allocator, value: Value, kind: Kind, stdout: *std.Io.Writer) Allocator.Error!?Era {
    if (kind == .response) return null;
    const method = value.get("method").?.string;
    const params = value.get("params") orelse Value{ .object = &.{} };
    if (std.mem.eql(u8, method, "initialize") and !try modern.validClaim(a, params) or !modern.hasClaim(params)) return .legacy;
    const issues = try modern.paramsIssues(a, params);
    const claim = modern.claimed(params) orelse "";
    const reject = if (issues.len > 0)
        try modern.envelopeReject(a, issues[0])
    else if (std.mem.eql(u8, claim, modern.version))
        return .modern
    else
        try modern.unsupported(a, claim);
    if (kind == .request) writeLine(stdout, try json.stringify(a, try reject.response(a, value.get("id").?)));
    return null;
}

/// The result of `doctor`: whether the server starts and lists tools, and the report.
pub const Doctor = struct { ok: bool, value: Value };

/// Validates that the MCP server starts and lists tools, as `mcp doctor` reports.
pub fn doctor(a: Allocator, cli: *Cli, process: *const Process) Allocator.Error!Doctor {
    var tools: std.ArrayList(Value) = .empty;
    var warnings: std.ArrayList(Value) = .empty;
    var failures: std.ArrayList(Value) = .empty;
    switch (try Server.init(a, cli, process, true, .{})) {
        .err => |failure| {
            var e: json.ObjectBuilder = .{};
            try e.put(a, "code", .{ .string = "MCP_SERVER_FAILED" });
            try e.put(a, "message", .{ .string = failure.message });
            try failures.append(a, e.finish());
        },
        .ok => |server| for (server.tools) |tool| {
            var entry: json.ObjectBuilder = .{};
            try entry.put(a, "name", .{ .string = tool.name });
            if (tool.description) |d| try entry.put(a, "description", .{ .string = d });
            try tools.append(a, entry.finish());
        },
    }
    if (failures.items.len == 0 and tools.items.len == 0) try warnings.append(a, .{ .string = "No MCP tools exposed." });
    var out: json.ObjectBuilder = .{};
    try out.put(a, "ok", .{ .bool = failures.items.len == 0 });
    try out.put(a, "toolCount", .{ .integer = tools.items.len });
    try out.put(a, "tools", .{ .array = tools.items });
    try out.put(a, "warnings", .{ .array = warnings.items });
    try out.put(a, "errors", .{ .array = failures.items });
    return .{ .ok = failures.items.len == 0, .value = out.finish() };
}

/// Writes a random version 4 UUID, as `crypto.randomUUID()` returns.
pub fn uuid(io: std.Io, out: *[36]u8) void {
    var bytes: [16]u8 = undefined;
    io.random(&bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = std.fmt.bytesToHex(bytes, .lower);
    _ = std.fmt.bufPrint(out, "{s}-{s}-{s}-{s}-{s}", .{ hex[0..8], hex[8..12], hex[12..16], hex[16..20], hex[20..32] }) catch unreachable;
}

/// The state of a stateful `/mcp` session: whether a client initialized it, and its id.
pub const Session = struct {
    /// Whether a client has initialized the session.
    initialized: bool = false,
    /// The session id, a random UUID.
    id: [36]u8 = undefined,
};

/// Answers a streamable-HTTP MCP request at `/mcp`, with JSON responses. Stateless servers
/// accept only `POST`; stateful servers keep one session in `cli.session`.
pub fn handleHttp(a: Allocator, cli: *Cli, process: *const Process, request: *const http.Request) ServeError!http.Response {
    const settings = cli.options.mcp orelse cli_.Mcp{};
    var stateless_session: Session = .{};
    const session: ?*Session = if (settings.stateless) null else session: {
        if (cli.session == null) {
            const created = try cli.arena.allocator().create(Session);
            created.* = .{};
            cli.session = created;
        }
        break :session cli.session.?;
    };
    if (session == null and !std.mem.eql(u8, request.method, "POST")) {
        var response = try http.Response.text(a, "", 405, null);
        try response.headers.set(a, "allow", "POST");
        return response;
    }
    if (std.mem.eql(u8, request.method, "POST")) {
        const headers = modern.Headers.of(request);
        var message: []const u8 = undefined;
        const body = try command.optional(json.parse(a, request.body orelse "", &message));
        if (modern.isModernRequest(headers, body)) return handleModern(a, cli, process, request, headers, body.?);
    }
    const state = session orelse &stateless_session;
    if (std.mem.eql(u8, request.method, "GET")) {
        const accept = request.headers.get("accept") orelse "";
        if (std.mem.find(u8, accept, "text/event-stream") == null) return transportError(a, 406, -32000, "Not Acceptable: Client must accept text/event-stream");
        if (try validateSession(a, session, request)) |e| return e;
        if (try validateVersion(a, request)) |e| return e;
        // Server-sent events need a streaming response; JSON responses carry every result.
        return transportError(a, 405, -32000, "Method not allowed.");
    }
    if (std.mem.eql(u8, request.method, "DELETE")) {
        if (try validateSession(a, session, request)) |e| return e;
        if (try validateVersion(a, request)) |e| return e;
        return .{ .status = 200 };
    }
    if (!std.mem.eql(u8, request.method, "POST")) {
        var response = try transportError(a, 405, -32000, "Method not allowed.");
        try response.headers.set(a, "allow", "GET, POST, DELETE");
        return response;
    }
    const accept = request.headers.get("accept") orelse "";
    if (std.mem.find(u8, accept, "application/json") == null or std.mem.find(u8, accept, "text/event-stream") == null)
        return transportError(a, 406, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    const content_type = request.headers.get("content-type") orelse "";
    if (std.mem.find(u8, content_type, "application/json") == null)
        return transportError(a, 415, -32000, "Unsupported Media Type: Content-Type must be application/json");
    var message: []const u8 = undefined;
    const body = try command.optional(json.parse(a, request.body orelse "", &message)) orelse return transportError(a, 400, -32700, "Parse error: Invalid JSON");
    const messages: []const Value = if (body == .array) body.array else try a.dupe(Value, &.{body});
    var initializing = false;
    var has_request = false;
    for (messages) |m| {
        const kind = classify(m);
        if (kind == .invalid) return transportError(a, 400, -32700, "Parse error: Invalid JSON-RPC message");
        if (kind == .request) {
            has_request = true;
            if (std.mem.eql(u8, m.get("method").?.string, "initialize")) initializing = true;
        }
    }
    if (initializing) {
        if (session != null and state.initialized) return transportError(a, 400, -32600, "Invalid Request: Server already initialized");
        if (messages.len > 1) return transportError(a, 400, -32600, "Invalid Request: Only one initialization request is allowed");
        if (session != null) {
            uuid(process.io, &state.id);
        }
        state.initialized = true;
    } else {
        if (try validateSession(a, session, request)) |e| return e;
        if (try validateVersion(a, request)) |e| return e;
    }
    if (!has_request) return .{ .status = 202 };
    var server = switch (try Server.init(a, cli, process, false, .{})) {
        .ok => |s| s,
        // The handler cannot serve these tools; report it like a failed request.
        .err => |e| return transportError(a, 500, -32603, e.message),
    };
    server.request = request;
    var responses: std.ArrayList(Value) = .empty;
    for (messages) |m| if (try server.handle(m)) |response| try responses.append(a, response);
    var response = try http.Response.json(a, if (body == .array) .{ .array = responses.items } else responses.items[0], 200);
    if (session) |s| try response.headers.set(a, "mcp-session-id", try a.dupe(u8, &s.id));
    return response;
}

/// Answers a request that claims protocol revision 2026-07-28 with a fresh server.
fn handleModern(a: Allocator, cli: *Cli, process: *const Process, request: *const http.Request, headers: modern.Headers, body: Value) ServeError!http.Response {
    if (!modern.isJson(request.headers.get("content-type")))
        return transportError(a, 415, -32000, "Unsupported Media Type: Content-Type must be application/json");
    const method = body.get("method");
    const raw_id = if (method != null and method.? == .string) body.get("id") else null;
    const id: Value = if (raw_id != null and raw_id.? != .object and raw_id.? != .array and raw_id.? != .bool and raw_id.? != .null) raw_id.? else .null;
    const routed = switch (try modern.classify(a, headers, body, &classify)) {
        .reject => |r| return rejectResponse(a, r, id, 400),
        .ok => |ok| ok,
    };
    if (!std.mem.eql(u8, routed.revision, modern.version)) return rejectResponse(a, try modern.unsupported(a, routed.revision), id, 400);
    if (classify(routed.message) == .notification) return .{ .status = 202 };
    if (try modern.checkHeaders(a, headers, routed.message, routed.revision)) |r| return rejectResponse(a, r, id, 400);
    var server = switch (try Server.init(a, cli, process, false, .{})) {
        .ok => |s| s,
        .err => return rejectResponse(a, .{ .code = -32603, .message = "Internal server error" }, id, 500),
    };
    server.request = request;
    var unknown = false;
    const response = (try server.handleModern(routed.message, &unknown)).?;
    return http.Response.json(a, response, if (unknown) 404 else 200);
}

/// Returns a rejection as an HTTP JSON-RPC error response.
fn rejectResponse(a: Allocator, reject: modern.Reject, id: Value, status: u16) Allocator.Error!http.Response {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "jsonrpc", .{ .string = "2.0" });
    try out.put(a, "error", try reject.err(a));
    try out.put(a, "id", id);
    return http.Response.json(a, out.finish(), status);
}

/// Rejects requests that do not belong to the stateful session.
fn validateSession(a: Allocator, session: ?*Session, request: *const http.Request) Allocator.Error!?http.Response {
    const s = session orelse return null;
    if (!s.initialized) return try transportError(a, 400, -32000, "Bad Request: Server not initialized");
    const id = request.headers.get("mcp-session-id") orelse return try transportError(a, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
    if (!std.mem.eql(u8, id, &s.id)) return try transportError(a, 404, -32001, "Session not found");
    return null;
}

/// Rejects requests whose `mcp-protocol-version` header names an unsupported version.
fn validateVersion(a: Allocator, request: *const http.Request) Allocator.Error!?http.Response {
    const version = request.headers.get("mcp-protocol-version") orelse return null;
    for (supported_versions) |v| if (std.mem.eql(u8, v, version)) return null;
    return try transportError(a, 400, -32000, try std.fmt.allocPrint(a, "Bad Request: Unsupported protocol version: {s} (supported versions: {s})", .{ version, try std.mem.join(a, ", ", &supported_versions) }));
}

/// Returns a transport-level JSON-RPC error response.
fn transportError(a: Allocator, status: u16, code: i64, message: []const u8) Allocator.Error!http.Response {
    var e: json.ObjectBuilder = .{};
    try e.put(a, "code", .{ .integer = code });
    try e.put(a, "message", .{ .string = message });
    var out: json.ObjectBuilder = .{};
    try out.put(a, "jsonrpc", .{ .string = "2.0" });
    try out.put(a, "error", e.finish());
    try out.put(a, "id", .null);
    return http.Response.json(a, out.finish(), status);
}
