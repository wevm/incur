//! Commands generated from a remote MCP server's tools, over its streamable-HTTP endpoint.
//! A server that lists exactly the four discovery tools (`search_tools`, `get_tool_details`,
//! `call_read_tool`, `call_write_tool`) is browsed progressively; others list tools directly.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const http = @import("http.zig");
const errors = @import("errors.zig");
const command = @import("command.zig");
const schema = @import("schema.zig");
const json_schema = @import("json_schema.zig");
const mcp = @import("mcp.zig");
const cli_ = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const ServeError = command.ServeError;

/// The protocol version this client requests.
const protocol_version = "2025-06-18";

/// A connection to a remote server.
const Session = struct {
    source: *const cli_.McpSource,
    /// Owns the session id.
    arena: Allocator,
    /// The last session id the server returned.
    id: ?[]const u8 = null,
    /// Whether initialization completed.
    initialized: bool = false,
    /// Whether tools are called through `call_read_tool` and `call_write_tool`.
    progressive: bool = false,
};

/// A result or an error message.
const Reply = union(enum) { ok: Value, err: []const u8 };

/// Connects to the server and registers its tools as commands on `group`. Returns the error
/// that stopped the connection.
pub fn load(group: *cli_.Cli, a: Allocator, process: *const cli_.Process, source: *const cli_.McpSource) ServeError!?errors.Error {
    const arena = group.arena.allocator();
    const session = try arena.create(Session);
    session.* = .{ .source = source, .arena = arena };
    var client: json.ObjectBuilder = .{};
    try client.put(a, "name", .{ .string = "incur" });
    try client.put(a, "version", .{ .string = "1.0.0" });
    var init_params: json.ObjectBuilder = .{};
    try init_params.put(a, "protocolVersion", .{ .string = protocol_version });
    try init_params.put(a, "capabilities", .{ .object = &.{} });
    try init_params.put(a, "clientInfo", client.finish());
    if (failed(try request(session, process, arena, "initialize", init_params.finish()))) |m| return .{ .message = m };
    session.initialized = true;
    if (failed(try request(session, process, arena, "notifications/initialized", null))) |m| return .{ .message = m };
    const listed = switch (try request(session, process, arena, "tools/list", null)) {
        .ok => |v| v.get("tools") orelse Value{ .array = &.{} },
        .err => |m| return .{ .message = m },
    };
    var tools: std.ArrayList(Value) = .empty;
    if (listed == .array) try tools.appendSlice(arena, listed.array);
    if (isCatalog(tools.items)) {
        session.progressive = true;
        tools.clearRetainingCapacity();
        if (try discover(session, process, arena, &tools)) |m| return .{ .message = m };
    }
    for (tools.items) |tool| try register(group, arena, session, tool);
    return null;
}

fn failed(reply: Reply) ?[]const u8 {
    return switch (reply) {
        .ok => null,
        .err => |m| m,
    };
}

fn stringField(value: Value, key: []const u8) ?[]const u8 {
    const v = value.get(key) orelse return null;
    return if (v == .string) v.string else null;
}

/// Whether the tools are exactly incur's four discovery tools.
fn isCatalog(tools: []const Value) bool {
    if (tools.len != 4) return false;
    for ([_][]const u8{ "search_tools", "get_tool_details", "call_read_tool", "call_write_tool" }) |name| {
        for (tools) |t| {
            if (std.mem.eql(u8, stringField(t, "name") orelse "", name)) break;
        } else return false;
    }
    return true;
}

/// Pages through `search_tools` and fetches each tool's details.
fn discover(session: *Session, process: *const cli_.Process, a: Allocator, tools: *std.ArrayList(Value)) ServeError!?[]const u8 {
    var offset: ?Value = .{ .integer = 0 };
    while (offset) |current| {
        var arguments: json.ObjectBuilder = .{};
        try arguments.put(a, "query", .{ .string = "" });
        try arguments.put(a, "limit", .{ .integer = 20 });
        try arguments.put(a, "offset", current);
        const search = switch (try callTool(session, process, a, "search_tools", arguments.finish())) {
            .ok => |v| v,
            .err => |m| return m,
        };
        const matches = search.get("tools") orelse Value{ .array = &.{} };
        if (matches == .array) for (matches.array) |match| {
            const name = stringField(match, "name") orelse continue;
            if (name.len == 0) continue;
            var details: json.ObjectBuilder = .{};
            try details.put(a, "name", .{ .string = name });
            const tool = switch (try callTool(session, process, a, "get_tool_details", details.finish())) {
                .ok => |v| v,
                .err => |m| return m,
            };
            if (stringField(tool, "name")) |n| if (n.len > 0) try tools.append(a, tool);
        };
        offset = search.get("nextOffset");
        if (offset) |next| if ((next.toFloat() orelse 0) <= (current.toFloat() orelse 0)) return "MCP tool catalog returned a non-advancing offset";
    }
    return null;
}

/// Calls a discovery tool and returns its value.
fn callTool(session: *Session, process: *const cli_.Process, a: Allocator, name: []const u8, arguments: Value) ServeError!Reply {
    var params: json.ObjectBuilder = .{};
    try params.put(a, "name", .{ .string = name });
    try params.put(a, "arguments", arguments);
    const result = switch (try request(session, process, a, "tools/call", params.finish())) {
        .ok => |v| v,
        .err => |m| return .{ .err = m },
    };
    if (isError(result)) {
        const text = try resultText(a, result);
        return .{ .err = if (text.len > 0) text else try std.fmt.allocPrint(a, "MCP tool failed: {s}", .{name}) };
    }
    return .{ .ok = try resultValue(a, result) };
}

fn isError(result: Value) bool {
    const v = result.get("isError") orelse return false;
    // JavaScript truthiness of the flag.
    return switch (v) {
        .null => false,
        .bool => |b| b,
        .string => |s| s.len > 0,
        .integer => |i| i != 0,
        .float => |f| f != 0 and !std.math.isNan(f),
        else => true,
    };
}

/// Sends one JSON-RPC message and returns its result.
fn request(session: *Session, process: *const cli_.Process, a: Allocator, method: []const u8, params: ?Value) ServeError!Reply {
    const source = session.source;
    const notification = std.mem.startsWith(u8, method, "notifications/");
    var id: [36]u8 = undefined;
    mcp.uuid(process.io, &id);
    var headers: http.Headers = .{};
    for (source.headers) |h| try headers.set(a, h.name, h.value);
    try headers.set(a, "content-type", "application/json");
    try headers.set(a, "accept", "application/json, text/event-stream");
    if (session.id) |sid| try headers.set(a, "mcp-session-id", sid);
    if (session.initialized) try headers.set(a, "mcp-protocol-version", protocol_version);
    var body: json.ObjectBuilder = .{};
    try body.put(a, "jsonrpc", .{ .string = "2.0" });
    if (!notification) try body.put(a, "id", .{ .string = try a.dupe(u8, &id) });
    try body.put(a, "method", .{ .string = method });
    if (params) |p| try body.put(a, "params", p);
    const req: http.Request = .{ .method = "POST", .url = source.url, .headers = headers, .body = try json.stringify(a, body.finish()) };
    var failure: command.Failure = .{};
    const response = (if (source.fetch) |h| h.handle(a, process, &req) else http.send(a, process, &req)) catch |err|
        return .{ .err = (try failure.take(err)).message };
    if (response.headers.get("mcp-session-id")) |sid| if (sid.len > 0) {
        session.id = try session.arena.dupe(u8, sid);
    };
    if (!response.ok()) return .{ .err = try std.fmt.allocPrint(a, "MCP HTTP {d}", .{response.status}) };
    if (notification and response.status == 202) return .{ .ok = .{ .object = &.{} } };
    if (response.body.len == 0) return .{ .ok = .{ .object = &.{} } };
    const content_type = response.headers.get("content-type") orelse "";
    const message = if (std.mem.find(u8, content_type, "text/event-stream") != null)
        switch (try parseSse(a, response.body, if (notification) null else &id)) {
            .ok => |v| v,
            .err => |m| return .{ .err = m },
        }
    else switch (try parse(a, response.body)) {
        .ok => |v| v,
        .err => |m| return .{ .err = m },
    };
    if (message.get("error")) |e| if (e != .null) {
        return .{ .err = if (e.get("message")) |m| try json.toString(a, m) else "MCP request failed" };
    };
    const result = message.get("result") orelse return .{ .ok = .{ .object = &.{} } };
    return .{ .ok = if (result == .null) .{ .object = &.{} } else result };
}

fn parse(a: Allocator, text: []const u8) ServeError!Reply {
    var message: []const u8 = undefined;
    return .{ .ok = try command.optional(json.parse(a, text, &message)) orelse return .{ .err = message } };
}

/// Returns the message with the request's id from a server-sent event stream.
fn parseSse(a: Allocator, text: []const u8, id: ?[]const u8) ServeError!Reply {
    const normalized = try std.mem.replaceOwned(u8, a, text, "\r\n", "\n");
    var events = std.mem.splitSequence(u8, normalized, "\n\n");
    while (events.next()) |event| {
        var data: std.ArrayList([]const u8) = .empty;
        var lines = std.mem.splitScalar(u8, event, '\n');
        while (lines.next()) |line| {
            if (std.mem.startsWith(u8, line, "data:")) try data.append(a, std.mem.trimStart(u8, line[5..], " \t"));
        }
        if (data.items.len == 0) continue;
        const joined = try std.mem.join(a, "\n", data.items);
        if (joined.len == 0) continue;
        const message = switch (try parse(a, joined)) {
            .ok => |v| v,
            .err => |m| return .{ .err = m },
        };
        const expected = id orelse return .{ .ok = message };
        if (stringField(message, "id")) |got| if (std.mem.eql(u8, got, expected)) return .{ .ok = message };
    }
    return .{ .err = "MCP SSE response did not include the matching JSON-RPC message" };
}

/// Joins a result's text content.
fn resultText(a: Allocator, result: Value) Allocator.Error![]const u8 {
    const content = result.get("content") orelse return "";
    if (content != .array) return "";
    var parts: std.ArrayList([]const u8) = .empty;
    for (content.array) |item| {
        if (!std.mem.eql(u8, stringField(item, "type") orelse "", "text")) continue;
        const text = stringField(item, "text") orelse continue;
        if (text.len > 0) try parts.append(a, text);
    }
    return std.mem.join(a, "\n", parts.items);
}

/// Returns a result's data: structured content, a single text item parsed as JSON or kept as
/// text, or every text item.
fn resultValue(a: Allocator, result: Value) ServeError!Value {
    if (result.get("structuredContent")) |v| return v;
    var texts: std.ArrayList(Value) = .empty;
    if (result.get("content")) |content| if (content == .array) for (content.array) |item| {
        if (!std.mem.eql(u8, stringField(item, "type") orelse "", "text")) continue;
        try texts.append(a, item.get("text") orelse .null);
    };
    if (texts.items.len == 1 and texts.items[0] == .string) return switch (try parse(a, texts.items[0].string)) {
        .ok => |v| v,
        .err => texts.items[0],
    };
    return .{ .array = texts.items };
}

/// What a generated command's handler needs.
const Call = struct {
    session: *Session,
    name: []const u8,
    read_only: bool,
};

/// Registers one remote tool as a command.
fn register(group: *cli_.Cli, a: Allocator, session: *Session, tool: Value) ServeError!void {
    const name = stringField(tool, "name") orelse return;
    var fields: std.ArrayList(schema.Field) = .empty;
    if (tool.get("inputSchema")) |input| {
        const required = if (input.get("required")) |r| (if (r == .array) r.array else &.{}) else &.{};
        if (input.get("properties")) |props| if (props == .object) for (props.object) |entry| {
            var s = try json_schema.convert(a, entry.value);
            var listed = false;
            for (required) |r| listed = listed or (r == .string and std.mem.eql(u8, r.string, entry.key));
            if (!listed) s = try s.optional(a);
            if (stringField(entry.value, "description")) |d| s = try s.describe(a, d);
            try fields.append(a, .{ .name = entry.key, .ty = try (try s.coerceIfNeeded(a)).toType(a) });
        };
    }
    const output: ?*const schema.Type = if (tool.get("outputSchema")) |o| output: {
        if (!std.mem.eql(u8, stringField(o, "type") orelse "", "object")) break :output null;
        const ty = try a.create(schema.Type);
        ty.* = try (try json_schema.convert(a, o)).toType(a);
        break :output ty;
    } else null;
    const options: ?*const schema.Type = if (fields.items.len > 0) options: {
        const ty = try a.create(schema.Type);
        ty.* = .{ .kind = .{ .object = fields.items } };
        break :options ty;
    } else null;
    const annotations = tool.get("annotations");
    const read_only = if (annotations) |an| (if (an.get("readOnlyHint")) |r| r == .bool and r.bool else false) else false;
    const call = try a.create(Call);
    call.* = .{ .session = session, .name = name, .read_only = read_only };
    try group.command(name, .{
        .description = stringField(tool, "description"),
        .mcp = .{ .annotations_json = if (annotations) |an| (if (an == .object) an else null) else null },
        .output = output,
        .run = .{ .context = call, .args = null, .options = options, .env = null, .call = run },
    });
}

/// Calls the remote tool with the command's options.
fn run(i: *const command.Invocation) anyerror!command.Outcome {
    const call: *const Call = @ptrCast(@alignCast(i.context.?));
    const a = i.allocator;
    var arguments: json.ObjectBuilder = .{};
    for ([_]Value{ i.args, i.options }) |input| for (input.object) |entry| try arguments.put(a, entry.key, entry.value);
    var params: json.ObjectBuilder = .{};
    try params.put(a, "name", .{ .string = call.name });
    try params.put(a, "arguments", arguments.finish());
    const sent = if (call.session.progressive) progressive: {
        var outer: json.ObjectBuilder = .{};
        try outer.put(a, "name", .{ .string = if (call.read_only) "call_read_tool" else "call_write_tool" });
        try outer.put(a, "arguments", params.finish());
        break :progressive outer.finish();
    } else params.finish();
    const result = switch (try request(call.session, i.process.?, a, "tools/call", sent)) {
        .ok => |v| v,
        .err => |m| return i.failure.fail(.{ .message = m }),
    };
    if (isError(result)) return i.failure.fail(.{ .code = "MCP_TOOL_ERROR", .message = try resultText(a, result) });
    const value = try json.normalize(a, try resultValue(a, result));
    return .{ .data = .{ .value = value } };
}
