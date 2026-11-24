//! MCP protocol revision 2026-07-28: per-request `_meta` envelopes, `server/discover`, and the
//! HTTP validation ladder, as `@modelcontextprotocol/server` serves them.

const std = @import("std");
const json = @import("json.zig");
const http = @import("http.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// The modern protocol revision the server speaks.
pub const version = "2026-07-28";
const version_key = "io.modelcontextprotocol/protocolVersion";
const info_key = "io.modelcontextprotocol/clientInfo";
const capabilities_key = "io.modelcontextprotocol/clientCapabilities";
const log_key = "io.modelcontextprotocol/logLevel";
const server_info_key = "io.modelcontextprotocol/serverInfo";
const reserved = [_][]const u8{ version_key, info_key, capabilities_key, log_key };
const required = [_][]const u8{ version_key, capabilities_key };
const levels = [_][]const u8{ "debug", "info", "notice", "warning", "error", "critical", "alert", "emergency" };

/// An envelope problem: the key path and what is wrong with it.
pub const Issue = struct { key: []const u8, problem: []const u8 };

/// A JSON-RPC error a request is rejected with.
pub const Reject = struct {
    code: i64,
    message: []const u8,
    data: ?Value = null,

    /// Returns the `error` object.
    pub fn err(r: Reject, a: Allocator) Allocator.Error!Value {
        var e: json.ObjectBuilder = .{};
        try e.put(a, "code", .{ .integer = r.code });
        try e.put(a, "message", .{ .string = r.message });
        if (r.data) |d| try e.put(a, "data", d);
        return e.finish();
    }

    /// Returns the rejection as a JSON-RPC response, `id` first as stdio writes it.
    pub fn response(r: Reject, a: Allocator, id: Value) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        try out.put(a, "jsonrpc", .{ .string = "2.0" });
        try out.put(a, "id", id);
        try out.put(a, "error", try r.err(a));
        return out.finish();
    }
};

/// Whether a protocol revision belongs to the 2026-07-28 era.
pub fn isModern(revision: []const u8) bool {
    return std.mem.order(u8, revision, version) != .lt;
}

fn metaOf(params: Value) ?Value {
    const meta = params.get("_meta") orelse return null;
    return if (meta == .object) meta else null;
}

/// Whether params name a protocol version in `_meta`.
pub fn hasClaim(params: Value) bool {
    const meta = metaOf(params) orelse return false;
    return meta.get(version_key) != null;
}

/// The protocol version params name in `_meta`, when it is a string.
pub fn claimed(params: Value) ?[]const u8 {
    const v = (metaOf(params) orelse return null).get(version_key) orelse return null;
    return if (v == .string) v.string else null;
}

fn received(object: Value, key: []const u8) []const u8 {
    return switch (object.get(key) orelse return "undefined") {
        .null => "null",
        .bool => "boolean",
        .integer, .big_integer, .float => "number",
        .string => "string",
        .array => "array",
        .object => "object",
    };
}

fn expected(a: Allocator, what: []const u8, object: Value, key: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(a, "Invalid input: expected {s}, received {s}", .{ what, received(object, key) });
}

/// The envelope schema's issues, in schema order.
fn schemaIssues(a: Allocator, meta: Value) Allocator.Error![]const Issue {
    var issues: std.ArrayList(Issue) = .empty;
    const v = meta.get(version_key);
    if (v == null or v.? != .string) try issues.append(a, .{ .key = version_key, .problem = try expected(a, "string", meta, version_key) });
    if (meta.get(info_key)) |info| {
        if (info == .object) {
            for ([_][]const u8{ "name", "version" }) |name| {
                const field = info.get(name);
                if (field == null or field.? != .string)
                    try issues.append(a, .{ .key = try std.fmt.allocPrint(a, "{s}.{s}", .{ info_key, name }), .problem = try expected(a, "string", info, name) });
            }
        } else try issues.append(a, .{ .key = info_key, .problem = try expected(a, "object", meta, info_key) });
    }
    const caps = meta.get(capabilities_key);
    if (caps == null or caps.? != .object) try issues.append(a, .{ .key = capabilities_key, .problem = try expected(a, "object", meta, capabilities_key) });
    if (meta.get(log_key)) |level| {
        const known = level == .string and for (levels) |l| {
            if (std.mem.eql(u8, l, level.string)) break true;
        } else false;
        if (!known) try issues.append(a, .{ .key = log_key, .problem = "Invalid option: expected one of \"debug\"|\"info\"|\"notice\"|\"warning\"|\"error\"|\"critical\"|\"alert\"|\"emergency\"" });
    }
    return issues.items;
}

/// Validates `_meta` as a per-request envelope: missing keys first, then schema issues.
pub fn envelopeIssues(a: Allocator, meta: Value) Allocator.Error![]const Issue {
    var issues: std.ArrayList(Issue) = .empty;
    for (required) |key| if (meta.get(key) == null) try issues.append(a, .{ .key = key, .problem = "missing" });
    const missing = issues.items.len;
    outer: for (try schemaIssues(a, meta)) |issue| {
        for (issues.items[0..missing]) |m| if (std.mem.eql(u8, m.key, issue.key)) continue :outer;
        try issues.append(a, issue);
    }
    return issues.items;
}

/// The issues of params' `_meta`, empty when it has none.
pub fn paramsIssues(a: Allocator, params: Value) Allocator.Error![]const Issue {
    return envelopeIssues(a, metaOf(params) orelse Value{ .object = &.{} });
}

/// Whether params carry a valid envelope naming a modern revision.
pub fn validClaim(a: Allocator, params: Value) Allocator.Error!bool {
    const claim = claimed(params) orelse return false;
    return isModern(claim) and (try paramsIssues(a, params)).len == 0;
}

/// The error a modern-era server answers a request with when its envelope is invalid.
pub fn envelopeError(a: Allocator, params: Value) Allocator.Error!?[]const u8 {
    const meta = metaOf(params) orelse Value{ .object = &.{} };
    var envelope: json.ObjectBuilder = .{};
    for (reserved) |key| if (meta.get(key)) |v| try envelope.put(a, key, v);
    if (envelope.entries.items.len == 0)
        return "Request is missing the required _meta envelope for protocol revision 2026-07-28 (" ++ version_key ++ ", " ++ capabilities_key ++ ")";
    const issues = try schemaIssues(a, envelope.finish());
    if (issues.len == 0) return null;
    var listed: std.ArrayList(u8) = .empty;
    for (issues, 0..) |issue, i| {
        if (i > 0) try listed.appendSlice(a, "; ");
        try listed.appendSlice(a, issue.problem);
    }
    return try std.fmt.allocPrint(a, "Invalid _meta envelope for protocol revision 2026-07-28: {s}", .{listed.items});
}

/// Stamps `resultType`, cache hints, and the server identity on a modern result.
pub fn encode(a: Allocator, method: []const u8, result: Value, info: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    for (result.object) |entry| try out.put(a, entry.key, entry.value);
    try out.put(a, "resultType", .{ .string = "complete" });
    if (std.mem.eql(u8, method, "tools/list") or std.mem.eql(u8, method, "server/discover")) {
        try out.put(a, "ttlMs", .{ .integer = 0 });
        try out.put(a, "cacheScope", .{ .string = "private" });
    }
    var meta: json.ObjectBuilder = .{};
    if (result.get("_meta")) |m| for (m.object) |entry| try meta.put(a, entry.key, entry.value);
    try meta.put(a, server_info_key, info);
    try out.put(a, "_meta", meta.finish());
    return out.finish();
}

fn mismatch(a: Allocator, header: []const u8, body: []const u8) Allocator.Error!Reject {
    var m: json.ObjectBuilder = .{};
    try m.put(a, "header", .{ .string = header });
    try m.put(a, "body", .{ .string = body });
    var data: json.ObjectBuilder = .{};
    try data.put(a, "mismatch", m.finish());
    return .{ .code = -32020, .message = try std.fmt.allocPrint(a, "Bad Request: the request headers and body disagree: {s}", .{body}), .data = data.finish() };
}

/// Returns an invalid-envelope error for an issue.
pub fn envelopeReject(a: Allocator, issue: Issue) Allocator.Error!Reject {
    var e: json.ObjectBuilder = .{};
    try e.put(a, "key", .{ .string = issue.key });
    try e.put(a, "problem", .{ .string = issue.problem });
    var data: json.ObjectBuilder = .{};
    try data.put(a, "envelope", e.finish());
    return .{ .code = -32602, .message = try std.fmt.allocPrint(a, "Invalid _meta envelope for protocol revision 2026-07-28: {s}: {s}", .{ issue.key, issue.problem }), .data = data.finish() };
}

fn supported(a: Allocator) Allocator.Error!Value {
    return .{ .array = try a.dupe(Value, &.{.{ .string = version }}) };
}

/// Returns the `UnsupportedProtocolVersion` error for a requested revision.
pub fn unsupported(a: Allocator, requested: []const u8) Allocator.Error!Reject {
    var data: json.ObjectBuilder = .{};
    try data.put(a, "supported", try supported(a));
    try data.put(a, "requested", .{ .string = requested });
    return .{ .code = -32022, .message = try std.fmt.allocPrint(a, "Unsupported protocol version: {s}", .{requested}), .data = data.finish() };
}

/// Returns the `UnsupportedProtocolVersion` error for an `initialize` request.
pub fn initializeReject(a: Allocator, params: Value) Allocator.Error!Reject {
    if (params.get("protocolVersion")) |v| if (v == .string) return unsupported(a, v.string);
    var data: json.ObjectBuilder = .{};
    try data.put(a, "supported", try supported(a));
    return .{ .code = -32022, .message = "Unsupported protocol version: the request did not name a protocol version", .data = data.finish() };
}

/// The standard MCP request headers, trimmed of spaces and tabs.
pub const Headers = struct {
    version: ?[]const u8,
    method: ?[]const u8,
    name: ?[]const u8,

    /// Reads the standard headers of a request.
    pub fn of(request: *const http.Request) Headers {
        return .{ .version = trimmed(request, "mcp-protocol-version"), .method = trimmed(request, "mcp-method"), .name = trimmed(request, "mcp-name") };
    }

    fn trimmed(request: *const http.Request, name: []const u8) ?[]const u8 {
        return std.mem.trim(u8, request.headers.get(name) orelse return null, " \t");
    }
};

/// Whether an MCP POST body claims the 2026-07-28 revision, by header or by `_meta`.
pub fn isModernRequest(headers: Headers, body: ?Value) bool {
    const value = body orelse return false;
    if (headers.version) |v| if (isModern(v)) return true;
    const messages: []const Value = if (value == .array) value.array else &.{value};
    for (messages) |m| if (hasClaim(m.get("params") orelse .null)) return true;
    return false;
}

/// The routed message and its revision, or the rejection.
pub const Routed = union(enum) { ok: struct { message: Value, revision: []const u8 }, reject: Reject };

/// The role of a JSON-RPC message, as the MCP SDK's schemas classify it.
pub const Kind = enum { request, notification, response, invalid };

/// Routes a modern-claiming body.
pub fn classify(a: Allocator, headers: Headers, body: Value, kindOf: *const fn (Value) Kind) Allocator.Error!Routed {
    if (body == .array) {
        if (body.array.len == 0) return .{ .reject = .{ .code = -32600, .message = "Bad Request: empty JSON-RPC batch" } };
        for (body.array) |item| {
            if (hasClaim(item.get("params") orelse .null)) return .{ .reject = .{ .code = -32600, .message = "Bad Request: JSON-RPC batches may not contain requests for protocol revision 2026-07-28 or later" } };
            if (kindOf(item) == .invalid) return .{ .reject = .{ .code = -32600, .message = "Bad Request: JSON-RPC batch contains an invalid message" } };
        }
        return .{ .reject = .{ .code = -32600, .message = "Bad Request: JSON-RPC batches are not supported by this endpoint" } };
    }
    const kind = kindOf(body);
    if (kind == .invalid) return .{ .reject = .{ .code = -32600, .message = "Bad Request: the request body is not a valid JSON-RPC message" } };
    if (kind == .response) return .{ .reject = .{ .code = -32600, .message = "Bad Request: JSON-RPC responses cannot be posted to this endpoint" } };
    const method = body.get("method").?.string;
    const params = body.get("params") orelse Value{ .object = &.{} };
    const claim = claimed(params);
    const header = headers.version;
    if (kind == .notification) {
        const revision = if (hasClaim(params)) revision: {
            // A claim that is not a string is the envelope's protocol version issue.
            const c = claim orelse return .{ .reject = try envelopeReject(a, .{ .key = version_key, .problem = try expected(a, "string", metaOf(params).?, version_key) }) };
            if (header) |h| if (!std.mem.eql(u8, h, c)) {
                const body_text = try std.fmt.allocPrint(a, "the notification envelope names protocol version {s} but the MCP-Protocol-Version header names {s}", .{ c, h });
                return .{ .reject = try mismatch(a, h, body_text) };
            };
            break :revision c;
        } else header.?;
        if (headers.method) |named| if (isModern(revision) and !std.mem.eql(u8, named, method))
            return .{ .reject = try mismatch(a, named, try std.fmt.allocPrint(a, "the notification body names method {s} but the Mcp-Method header names {s}", .{ method, named })) };
        return .{ .ok = .{ .message = body, .revision = revision } };
    }
    if (std.mem.eql(u8, method, "initialize") and !try validClaim(a, params)) {
        if (header) |h| if (isModern(h))
            return .{ .reject = try mismatch(a, h, "an initialize request (legacy handshake) was sent with a modern MCP-Protocol-Version header") };
        return .{ .reject = try initializeReject(a, params) };
    }
    if (hasClaim(params)) {
        const issues = try paramsIssues(a, params);
        if (issues.len > 0) return .{ .reject = try envelopeReject(a, issues[0]) };
        const c = claim.?;
        if (header) |h| if (!std.mem.eql(u8, h, c))
            return .{ .reject = try mismatch(a, h, try std.fmt.allocPrint(a, "the body envelope names protocol version {s} but the MCP-Protocol-Version header names {s}", .{ c, h })) };
        if (headers.method) |named| if (!std.mem.eql(u8, named, method))
            return .{ .reject = try mismatch(a, named, try std.fmt.allocPrint(a, "the body names method {s} but the Mcp-Method header names {s}", .{ method, named })) };
        return .{ .ok = .{ .message = body, .revision = c } };
    }
    var missing: std.ArrayList(Value) = .empty;
    if (metaOf(params)) |meta| {
        for (try envelopeIssues(a, meta)) |issue| if (std.mem.eql(u8, issue.problem, "missing")) try missing.append(a, .{ .string = issue.key });
    } else try missing.append(a, .{ .string = "_meta" });
    var names: std.ArrayList(u8) = .empty;
    for (missing.items, 0..) |m, i| {
        if (i > 0) try names.appendSlice(a, ", ");
        try names.appendSlice(a, m.string);
    }
    var e: json.ObjectBuilder = .{};
    try e.put(a, "missing", .{ .array = missing.items });
    var data: json.ObjectBuilder = .{};
    try data.put(a, "envelope", e.finish());
    return .{ .reject = .{
        .code = -32602,
        .message = try std.fmt.allocPrint(a, "Invalid params: the MCP-Protocol-Version header names protocol revision {s}, but the request is missing the required per-request envelope key(s): {s}", .{ header.?, names.items }),
        .data = data.finish(),
    } };
}

fn digit(c: u8) ?u32 {
    return switch (c) {
        'A'...'Z' => c - 'A',
        'a'...'z' => c - 'a' + 26,
        '0'...'9' => c - '0' + 52,
        '+' => 62,
        '/' => 63,
        else => null,
    };
}

/// Decodes an `Mcp-Name` value: a `=?base64?…?=` sentinel carries canonical Base64 UTF-8.
fn decodeName(a: Allocator, value: []const u8) Allocator.Error!?[]const u8 {
    if (!std.mem.startsWith(u8, value, "=?base64?") or !std.mem.endsWith(u8, value, "?=")) return value;
    const payload = if (value.len >= 11) value[9 .. value.len - 2] else "";
    const data = std.mem.trimEnd(u8, payload, "=");
    // Canonical Base64: whole groups of four, with at most two padding characters.
    if (payload.len % 4 != 0 or payload.len - data.len > 2) return null;
    var digits: std.ArrayList(u32) = .empty;
    for (data) |c| try digits.append(a, digit(c) orelse return null);
    var bytes: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < digits.items.len) : (i += 4) {
        const group = digits.items[i..@min(i + 4, digits.items.len)];
        var bits: u32 = 0;
        for (group) |d| bits = bits << 6 | d;
        bits <<= @intCast(6 * (4 - group.len));
        const be = std.mem.toBytes(std.mem.nativeToBig(u32, bits));
        try bytes.appendSlice(a, be[1..group.len]);
    }
    return if (std.unicode.utf8ValidateSlice(bytes.items)) bytes.items else null;
}

/// Checks the standard request headers of a modern request against its body.
pub fn checkHeaders(a: Allocator, headers: Headers, message: Value, revision: []const u8) Allocator.Error!?Reject {
    const method = message.get("method").?.string;
    if (headers.version == null)
        return try mismatch(a, "(missing)", try std.fmt.allocPrint(a, "the body envelope names protocol version {s} but the required MCP-Protocol-Version header is absent", .{revision}));
    if (headers.method == null)
        return try mismatch(a, "(missing)", try std.fmt.allocPrint(a, "the body names method {s} but the required Mcp-Method header is absent", .{method}));
    const field: []const u8 = if (std.mem.eql(u8, method, "tools/call") or std.mem.eql(u8, method, "prompts/get"))
        "name"
    else if (std.mem.eql(u8, method, "resources/read")) "uri" else return null;
    const raw = (message.get("params") orelse Value{ .null = {} }).get(field);
    const value: ?[]const u8 = if (raw != null and raw.? == .string) raw.?.string else null;
    const header = headers.name orelse {
        const v = value orelse return null;
        return try mismatch(a, "(missing)", try std.fmt.allocPrint(a, "the body carries params.{s}=\"{s}\" but the required Mcp-Name header is absent", .{ field, v }));
    };
    const decoded = try decodeName(a, header) orelse return try mismatch(a, header, "the Mcp-Name header carries an invalid Base64 sentinel value");
    if (value) |v| if (!std.mem.eql(u8, v, decoded)) {
        const body_text = try std.fmt.allocPrint(a, "the body carries params.{s}=\"{s}\" but the Mcp-Name header names \"{s}\"", .{ field, v, decoded });
        return try mismatch(a, header, body_text);
    };
    return null;
}

/// Whether a `content-type` header names JSON.
pub fn isJson(content_type: ?[]const u8) bool {
    const t = content_type orelse return false;
    var parts = std.mem.splitScalar(u8, t, ';');
    return std.ascii.eqlIgnoreCase(std.mem.trim(u8, parts.first(), " \t"), "application/json");
}
