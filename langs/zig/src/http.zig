//! HTTP requests and responses, handlers, URLs, and the adapters that connect handlers to
//! `std.http.Server` and `std.http.Client`.
//!
//! A `Handler` maps a `Request` to a `Response`. A CLI is one (`Cli.handler`), fetch-backed
//! commands call one, and `serveConnection` answers HTTP/1.1 requests on a connection with one.
//! Handlers receive the `Process` they run in: its `io` for I/O and `network` for outgoing
//! requests, which `send` routes to `std.http.Client` when no override is set.

const std = @import("std");
const json = @import("json.zig");
const cli = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Process = cli.Process;

/// A header name and value.
pub const Header = struct {
    /// The name, lowercase.
    name: []const u8,
    /// The value.
    value: []const u8,
};

/// Header fields with lowercase names, as the Fetch API's `Headers` normalizes them.
pub const Headers = struct {
    /// The fields in insertion order.
    list: std.ArrayList(Header) = .empty,

    /// Returns a header value, matching the name case-insensitively.
    pub fn get(h: *const Headers, name: []const u8) ?[]const u8 {
        for (h.list.items) |header| if (std.ascii.eqlIgnoreCase(header.name, name)) return header.value;
        return null;
    }

    /// Sets a header, replacing an existing value.
    pub fn set(h: *Headers, a: Allocator, name: []const u8, value: []const u8) Allocator.Error!void {
        for (h.list.items) |*header| if (std.ascii.eqlIgnoreCase(header.name, name)) {
            header.value = value;
            return;
        };
        try h.list.append(a, .{ .name = try std.ascii.allocLowerString(a, name), .value = value });
    }

    /// Returns the fields sorted by name, as iterating `Headers` does.
    pub fn sorted(h: *const Headers, a: Allocator) Allocator.Error![]const Header {
        const out = try a.dupe(Header, h.list.items);
        std.mem.sort(Header, out, {}, struct {
            fn lessThan(_: void, x: Header, y: Header) bool {
                return std.mem.lessThan(u8, x.name, y.name);
            }
        }.lessThan);
        return out;
    }

    /// Returns the fields as a JSON object sorted by name, as `Object.fromEntries(headers)` does.
    pub fn toValue(h: *const Headers, a: Allocator) Allocator.Error!Value {
        const fields = try h.sorted(a);
        const entries = try a.alloc(Value.Entry, fields.len);
        for (fields, entries) |f, *slot| slot.* = .{ .key = f.name, .value = .{ .string = f.value } };
        return .{ .object = entries };
    }
};

/// An HTTP request.
pub const Request = struct {
    /// The method, such as `GET`.
    method: []const u8 = "GET",
    /// The absolute URL.
    url: []const u8,
    /// The headers.
    headers: Headers = .{},
    /// The body, or null for none.
    body: ?[]const u8 = null,
};

/// An HTTP response.
pub const Response = struct {
    /// The status code.
    status: u16 = 200,
    /// The headers.
    headers: Headers = .{},
    /// The body.
    body: []const u8 = "",

    /// Whether the status is in the 2xx range.
    pub fn ok(r: *const Response) bool {
        return r.status >= 200 and r.status < 300;
    }

    /// Returns a response with a JSON body and an `application/json` content type.
    pub fn json(a: Allocator, value: Value, status: u16) Allocator.Error!Response {
        return text(a, try @import("json.zig").stringify(a, value), status, "application/json");
    }

    /// Returns a response with a body and an optional content type.
    pub fn text(a: Allocator, body: []const u8, status: u16, content_type: ?[]const u8) Allocator.Error!Response {
        var headers: Headers = .{};
        if (content_type) |t| try headers.set(a, "content-type", t);
        return .{ .status = status, .headers = headers, .body = body };
    }
};

/// The error a handler returns when a request cannot reach its server. It reports as the
/// message `fetch failed`, as a failed `fetch` does in JavaScript.
pub const FetchError = error{FetchFailed};

/// Handles HTTP requests. Allocate the response with `a`, whose memory the caller frees.
pub const Handler = struct {
    /// State passed to `call`.
    context: ?*const anyopaque = null,
    /// Answers a request.
    call: *const fn (context: ?*const anyopaque, a: Allocator, process: *const Process, request: *const Request) anyerror!Response,

    /// Wraps a function without state.
    pub fn of(comptime f: fn (a: Allocator, process: *const Process, request: *const Request) anyerror!Response) Handler {
        return .{ .call = struct {
            fn call(_: ?*const anyopaque, a: Allocator, process: *const Process, request: *const Request) anyerror!Response {
                return f(a, process, request);
            }
        }.call };
    }

    /// Answers a request.
    pub fn handle(h: Handler, a: Allocator, process: *const Process, request: *const Request) anyerror!Response {
        return h.call(h.context, a, process, request);
    }
};

/// Sends a request to the network: through `process.network` when set, otherwise with
/// `std.http.Client`. Connection failures return `error.FetchFailed`.
pub fn send(a: Allocator, process: *const Process, request: *const Request) anyerror!Response {
    if (process.network) |network| return network.handle(a, process, request);
    return clientSend(a, process.io, request);
}

/// Sends a request with `std.http.Client`.
fn clientSend(a: Allocator, io: std.Io, request: *const Request) (Allocator.Error || std.Io.Cancelable || FetchError)!Response {
    var client: std.http.Client = .{ .allocator = a, .io = io };
    defer client.deinit();
    return clientRequest(a, &client, request) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.Canceled => error.Canceled,
        else => error.FetchFailed,
    };
}

/// Performs one request on a client and buffers the response.
fn clientRequest(a: Allocator, client: *std.http.Client, request: *const Request) !Response {
    const uri = try std.Uri.parse(request.url);
    const method = std.meta.stringToEnum(std.http.Method, request.method) orelse return error.FetchFailed;
    const extra = try a.alloc(std.http.Header, request.headers.list.items.len);
    for (request.headers.list.items, extra) |h, *slot| slot.* = .{ .name = h.name, .value = h.value };
    var req = try client.request(method, uri, .{
        .extra_headers = extra,
        .redirect_behavior = .unhandled,
        .keep_alive = false,
        .headers = .{ .accept_encoding = .omit, .user_agent = .omit },
    });
    defer req.deinit();
    if (request.body) |body| {
        req.transfer_encoding = .{ .content_length = body.len };
        var writer = try req.sendBodyUnflushed(&.{});
        try writer.writer.writeAll(body);
        try writer.end();
        try req.connection.?.flush();
    } else try req.sendBodiless();
    var response = try req.receiveHead(&.{});
    var headers: Headers = .{};
    var it = response.head.iterateHeaders();
    while (it.next()) |h| try headers.set(a, try a.dupe(u8, h.name), try a.dupe(u8, h.value));
    const status: u16 = @backingInt(response.head.status);
    var transfer: [64]u8 = undefined;
    const reader = response.reader(&transfer);
    const body = try reader.allocRemaining(a, .unlimited);
    return .{ .status = status, .headers = headers, .body = body };
}

/// Answers HTTP/1.1 requests on one connection with a handler until the client closes it. Each
/// request's memory is freed after its response is written.
///
/// ```zig
/// const stream = try listener.accept(io);
/// var server: std.http.Server = .init(&reader.interface, &writer.interface);
/// try incur.http.serveConnection(gpa, &process, &server, cli.handler());
/// ```
pub fn serveConnection(gpa: Allocator, process: *const Process, server: *std.http.Server, handler: Handler) !void {
    while (true) {
        var request = server.receiveHead() catch |err| switch (err) {
            error.HttpConnectionClosing => return,
            else => |e| return e,
        };
        var arena: std.heap.ArenaAllocator = .init(gpa);
        defer arena.deinit();
        const a = arena.allocator();
        var headers: Headers = .{};
        var it = request.iterateHeaders();
        while (it.next()) |h| try headers.set(a, try a.dupe(u8, h.name), try a.dupe(u8, h.value));
        const host = headers.get("host") orelse "localhost";
        const url = try std.fmt.allocPrint(a, "http://{s}{s}", .{ host, request.head.target });
        const method = @tagName(request.head.method);
        const has_body = request.head.content_length != null or request.head.transfer_encoding == .chunked;
        var buffer: [4096]u8 = undefined;
        const body: ?[]const u8 = if (has_body) try (try request.readerExpectContinue(&buffer)).allocRemaining(a, .unlimited) else null;
        const incoming: Request = .{ .method = method, .url = url, .headers = headers, .body = body };
        const response = try handler.handle(a, process, &incoming);
        const extra = try a.alloc(std.http.Header, response.headers.list.items.len);
        for (response.headers.list.items, extra) |h, *slot| slot.* = .{ .name = h.name, .value = h.value };
        try request.respond(response.body, .{ .status = @fromBackingInt(@intCast(response.status)), .extra_headers = extra });
    }
}

/// A parsed absolute URL: `<scheme>://<host><path>?<query>`. The fragment is dropped.
pub const Url = struct {
    /// The scheme, such as `http`.
    scheme: []const u8,
    /// The host with its port, if any.
    host: []const u8,
    /// The path, starting with `/`.
    path: []const u8,
    /// The query without `?`, or empty.
    query: []const u8,

    /// Parses an absolute URL. Returns null for text without a scheme and host.
    pub fn parse(text: []const u8) ?Url {
        const colon = std.mem.find(u8, text, "://") orelse return null;
        const scheme = text[0..colon];
        if (scheme.len == 0) return null;
        for (scheme) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '+' and ch != '-' and ch != '.') return null;
        var rest = text[colon + 3 ..];
        if (std.mem.findScalar(u8, rest, '#')) |hash| rest = rest[0..hash];
        const path_start = std.mem.findAny(u8, rest, "/?") orelse rest.len;
        const host = rest[0..path_start];
        if (host.len == 0) return null;
        rest = rest[path_start..];
        const question = std.mem.findScalar(u8, rest, '?');
        const path = rest[0 .. question orelse rest.len];
        return .{
            .scheme = scheme,
            .host = host,
            .path = if (path.len == 0) "/" else path,
            .query = if (question) |q| rest[q + 1 ..] else "",
        };
    }

    /// Returns `<scheme>://<host>`.
    pub fn origin(u: Url, a: Allocator) Allocator.Error![]const u8 {
        return std.fmt.allocPrint(a, "{s}://{s}", .{ u.scheme, u.host });
    }

    /// Returns the URL as text.
    pub fn format(u: Url, a: Allocator) Allocator.Error![]const u8 {
        if (u.query.len == 0) return std.fmt.allocPrint(a, "{s}://{s}{s}", .{ u.scheme, u.host, u.path });
        return std.fmt.allocPrint(a, "{s}://{s}{s}?{s}", .{ u.scheme, u.host, u.path, u.query });
    }

    /// Resolves a reference against this URL, as `new URL(reference, base)` does for absolute
    /// URLs, absolute paths, and relative paths.
    pub fn resolve(base: Url, a: Allocator, reference: []const u8) Allocator.Error![]const u8 {
        if (parse(reference) != null) return reference;
        const question = std.mem.findScalar(u8, reference, '?');
        const ref_path = reference[0 .. question orelse reference.len];
        const query = if (question) |q| reference[q + 1 ..] else "";
        const path = if (std.mem.startsWith(u8, ref_path, "/"))
            ref_path
        else
            try std.mem.concat(a, u8, &.{ base.path[0 .. (std.mem.findScalarLast(u8, base.path, '/') orelse 0) + 1], ref_path });
        return (Url{ .scheme = base.scheme, .host = base.host, .path = try encodePath(a, path), .query = query }).format(a);
    }
};

/// Percent-encodes a URL path as the URL parser does: controls, space, `"`, `<`, `>`, `` ` ``,
/// `{`, `}`, and non-ASCII bytes.
pub fn encodePath(a: Allocator, path: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (path) |ch| {
        if (ch <= 0x20 or ch >= 0x7f or std.mem.findScalar(u8, "\"<>`{}", ch) != null)
            try out.print(a, "%{X:0>2}", .{ch})
        else
            try out.append(a, ch);
    }
    return out.items;
}

/// Percent-encodes text as `encodeURIComponent` does.
pub fn encodeComponent(a: Allocator, text: []const u8) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (text) |ch| {
        if (std.ascii.isAlphanumeric(ch) or std.mem.findScalar(u8, "-_.!~*'()", ch) != null)
            try out.append(a, ch)
        else
            try out.print(a, "%{X:0>2}", .{ch});
    }
    return out.items;
}

/// Decodes percent escapes, as `decodeURIComponent` does for valid input. Invalid escapes are
/// kept as they are.
pub fn decodeComponent(a: Allocator, text: []const u8, plus_as_space: bool) Allocator.Error![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        const ch = text[i];
        if (ch == '%' and i + 2 < text.len) {
            if (std.fmt.parseInt(u8, text[i + 1 .. i + 3], 16)) |byte| {
                try out.append(a, byte);
                i += 2;
                continue;
            } else |_| {}
        }
        try out.append(a, if (plus_as_space and ch == '+') ' ' else ch);
    }
    return out.items;
}

/// Query parameters in order, as `URLSearchParams` holds them.
pub const SearchParams = struct {
    /// The parameters.
    list: std.ArrayList(Value.Entry) = .empty,

    /// Parses a query string without its `?`.
    pub fn parse(a: Allocator, query: []const u8) Allocator.Error!SearchParams {
        var params: SearchParams = .{};
        var it = std.mem.splitScalar(u8, query, '&');
        while (it.next()) |pair| {
            if (pair.len == 0) continue;
            const eq = std.mem.findScalar(u8, pair, '=');
            const key = try decodeComponent(a, pair[0 .. eq orelse pair.len], true);
            const value = if (eq) |e| try decodeComponent(a, pair[e + 1 ..], true) else "";
            try params.list.append(a, .{ .key = key, .value = .{ .string = value } });
        }
        return params;
    }

    /// Sets a parameter: replaces the first with this name and removes the rest, or appends.
    pub fn set(p: *SearchParams, a: Allocator, key: []const u8, value: []const u8) Allocator.Error!void {
        var found = false;
        var i: usize = 0;
        while (i < p.list.items.len) {
            if (std.mem.eql(u8, p.list.items[i].key, key)) {
                if (found) {
                    _ = p.list.orderedRemove(i);
                    continue;
                }
                p.list.items[i].value = .{ .string = value };
                found = true;
            }
            i += 1;
        }
        if (!found) try p.list.append(a, .{ .key = key, .value = .{ .string = value } });
    }

    /// Returns the parameters as `application/x-www-form-urlencoded` text.
    pub fn format(p: *const SearchParams, a: Allocator) Allocator.Error![]const u8 {
        var out: std.ArrayList(u8) = .empty;
        for (p.list.items, 0..) |entry, i| {
            if (i > 0) try out.append(a, '&');
            try formEncode(a, &out, entry.key);
            try out.append(a, '=');
            try formEncode(a, &out, entry.value.string);
        }
        return out.items;
    }
};

/// Appends text encoded as `application/x-www-form-urlencoded`.
fn formEncode(a: Allocator, out: *std.ArrayList(u8), text: []const u8) Allocator.Error!void {
    for (text) |ch| {
        if (std.ascii.isAlphanumeric(ch) or std.mem.findScalar(u8, "*-._", ch) != null)
            try out.append(a, ch)
        else if (ch == ' ')
            try out.append(a, '+')
        else
            try out.print(a, "%{X:0>2}", .{ch});
    }
}
