//! Fetch-backed commands: HTTP sources, curl-style argv parsing, and response decoding.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const http = @import("http.zig");
const command = @import("command.zig");
const cli = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Process = cli.Process;

/// Where a fetch-backed command sends its requests.
pub const Source = union(enum) {
    /// A handler, such as another CLI's `Cli.handler()` or an in-process API.
    handler: http.Handler,
    /// A hosted API reached over the network, from `fromRequest`.
    hosted: Hosted,

    /// Sends a request to the source.
    pub fn send(s: Source, a: Allocator, process: *const Process, request: *const http.Request) anyerror!http.Response {
        return switch (s) {
            .handler => |h| h.handle(a, process, request),
            .hosted => |h| h.send(a, process, request),
        };
    }

    /// Returns the base URL relative OpenAPI document URLs resolve against, or null.
    pub fn base(s: Source) ?[]const u8 {
        return switch (s) {
            .handler => null,
            .hosted => |h| h.url,
        };
    }
};

/// A hosted API: requests keep their path and query below the base URL's path and gain the
/// default headers.
pub const Hosted = struct {
    /// The base URL, such as `https://api.example.com/v1/`.
    url: []const u8,
    /// Headers sent with every request. Request headers take precedence.
    headers: []const http.Header = &.{},

    /// Forwards a request to the network below the base URL.
    pub fn send(h: Hosted, a: Allocator, process: *const Process, request: *const http.Request) anyerror!http.Response {
        const target = http.Url.parse(h.url) orelse return error.FetchFailed;
        const incoming = http.Url.parse(request.url) orelse return error.FetchFailed;
        const prefix = if (std.mem.endsWith(u8, target.path, "/")) target.path[0 .. target.path.len - 1] else target.path;
        var headers: http.Headers = .{};
        for (h.headers) |header| try headers.set(a, header.name, header.value);
        for (request.headers.list.items) |header| try headers.set(a, header.name, header.value);
        const url: http.Url = .{ .scheme = target.scheme, .host = target.host, .path = try std.mem.concat(a, u8, &.{ prefix, incoming.path }), .query = incoming.query };
        const forwarded: http.Request = .{ .method = request.method, .url = try url.format(a), .headers = headers, .body = request.body };
        return http.send(a, process, &forwarded);
    }
};

/// Returns a source that forwards requests to a hosted API.
///
/// ```zig
/// try cli.gateway("api", .{ .fetch = incur.fetch.fromRequest("https://api.example.com/v1/", &.{
///     .{ .name = "authorization", .value = "Bearer token" },
/// }) });
/// ```
pub fn fromRequest(url: []const u8, headers: []const http.Header) Source {
    return .{ .hosted = .{ .url = url, .headers = headers } };
}

/// Structured input parsed from curl-style argv.
pub const Input = struct {
    /// The request path.
    path: []const u8,
    /// The method.
    method: []const u8,
    /// The headers.
    headers: http.Headers,
    /// The body, or null.
    body: ?[]const u8,
    /// Query parameters.
    query: http.SearchParams,
};

/// The result of `parseArgv`: the input, or an error message.
pub const Parsed = union(enum) {
    ok: Input,
    err: []const u8,
};

/// Parses curl-style argv: path segments, `--key value` and `--key=value` query parameters,
/// `-X`/`--method`, `-H`/`--header`, and `-d`/`--data`/`--body`.
pub fn parseArgv(a: Allocator, argv: []const []const u8) Allocator.Error!Parsed {
    var segments: std.ArrayList([]const u8) = .empty;
    var input: Input = .{ .path = "", .method = "", .headers = .{}, .body = null, .query = .{} };
    var method: ?[]const u8 = null;
    var i: usize = 0;
    while (i < argv.len) {
        const token = argv[i];
        if (std.mem.startsWith(u8, token, "--")) {
            const key, const value = if (std.mem.findScalar(u8, token, '=')) |eq| entry: {
                i += 1;
                break :entry .{ token[2..eq], token[eq + 1 ..] };
            } else entry: {
                if (i + 1 >= argv.len) return .{ .err = try std.fmt.allocPrint(a, "Missing value for {s}", .{token}) };
                i += 2;
                break :entry .{ token[2..], argv[i - 1] };
            };
            if (try reserved(a, &input, &method, key, value)) continue;
            try input.query.set(a, key, value);
        } else if (token.len == 2 and token[0] == '-') {
            i += 1;
            const key = switch (token[1]) {
                'X' => "method",
                'd' => "data",
                'H' => "header",
                // An unknown short flag is skipped without consuming a value.
                else => continue,
            };
            if (i >= argv.len) return .{ .err = try std.fmt.allocPrint(a, "Missing value for {s}", .{token}) };
            _ = try reserved(a, &input, &method, key, argv[i]);
            i += 1;
        } else {
            try segments.append(a, token);
            i += 1;
        }
    }
    // Repeated slashes collapse, so a `/users` token cannot form a protocol-relative `//users`.
    var path: std.ArrayList(u8) = .empty;
    for (try std.fmt.allocPrint(a, "/{s}", .{try std.mem.join(a, "/", segments.items)})) |ch| {
        if (ch == '/' and path.items.len > 0 and path.items[path.items.len - 1] == '/') continue;
        try path.append(a, ch);
    }
    input.path = path.items;
    input.method = method orelse if (input.body != null) "POST" else "GET";
    return .{ .ok = input };
}

/// Applies a reserved flag. Returns false for query parameters.
fn reserved(a: Allocator, input: *Input, method: *?[]const u8, key: []const u8, value: []const u8) Allocator.Error!bool {
    if (std.mem.eql(u8, key, "method")) {
        method.* = try std.ascii.allocUpperString(a, value);
    } else if (std.mem.eql(u8, key, "body") or std.mem.eql(u8, key, "data")) {
        input.body = value;
    } else if (std.mem.eql(u8, key, "header")) {
        if (std.mem.findScalar(u8, value, ':')) |colon|
            try input.headers.set(a, js.trim(value[0..colon]), js.trim(value[colon + 1 ..]));
    } else return false;
    return true;
}

/// Builds a request to `http://localhost` from parsed input. A body without a content type is
/// sent as JSON.
pub fn buildRequest(a: Allocator, input: *Input) Allocator.Error!http.Request {
    const url = http.Url.parse(try (http.Url.parse("http://localhost/").?).resolve(a, input.path)).?;
    var query = try http.SearchParams.parse(a, url.query);
    for (input.query.list.items) |entry| try query.set(a, entry.key, entry.value.string);
    if (input.body != null and input.headers.get("content-type") == null) try input.headers.set(a, "content-type", "application/json");
    const target: http.Url = .{ .scheme = url.scheme, .host = url.host, .path = url.path, .query = try query.format(a) };
    return .{ .method = input.method, .url = try target.format(a), .headers = input.headers, .body = input.body };
}

/// Whether a response streams NDJSON.
pub fn isStreaming(response: *const http.Response) bool {
    const content_type = response.headers.get("content-type") orelse return false;
    return std.mem.eql(u8, content_type, "application/x-ndjson");
}

/// Parses a body as JSON, or returns it as a string.
pub fn parseBody(a: Allocator, body: []const u8) Allocator.Error!Value {
    var message: []const u8 = undefined;
    return json.parse(a, body, &message) catch |err| switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.SyntaxError => .{ .string = body },
    };
}

/// Iterates the lines of an NDJSON body: each non-blank line as JSON, or as a string.
pub const Lines = struct {
    /// The remaining lines.
    it: std.mem.SplitIterator(u8, .scalar),

    /// Iterates a body.
    pub fn init(body: []const u8) Lines {
        return .{ .it = std.mem.splitScalar(u8, body, '\n') };
    }

    /// Returns the next chunk.
    pub fn next(l: *Lines, _: std.Io, a: Allocator) anyerror!?command.Chunk {
        while (l.it.next()) |raw| {
            const line = js.trim(raw);
            if (line.len > 0) return .{ .data = try parseBody(a, line) };
        }
        return null;
    }
};

/// Extracts an error code and message from a failed response: a top-level `message` or an
/// `{ error: { code, message } }` envelope, falling back to the status.
pub fn parseError(a: Allocator, data: Value, status: u16) Allocator.Error!Value {
    const nested: ?Value = if (data == .object) if (data.get("error")) |e| (if (e == .object) e else null) else null else null;
    const code = if (nested) |e| if (e.get("code")) |c| (if (c == .string and c.string.len > 0) c.string else null) else null else null;
    const message = if (data == .object and data.get("message") != null)
        try json.toString(a, data.get("message").?)
    else if (nested != null and nested.?.get("message") != null)
        try json.toString(a, nested.?.get("message").?)
    else if (data == .string)
        data.string
    else
        try std.fmt.allocPrint(a, "HTTP {d}", .{status});
    var out: json.ObjectBuilder = .{};
    try out.put(a, "code", .{ .string = code orelse try std.fmt.allocPrint(a, "HTTP_{d}", .{status}) });
    try out.put(a, "message", .{ .string = message });
    return out.finish();
}

/// Returns help for a fetch-backed command.
pub fn help(a: Allocator, name: []const u8, description: ?[]const u8) Allocator.Error![]const u8 {
    const title = if (description) |d| (if (d.len > 0) try std.fmt.allocPrint(a, "{s} \u{2014} {s}", .{ name, d }) else name) else name;
    return std.fmt.allocPrint(a,
        \\{s}
        \\
        \\Usage: {s} <path> [options]
        \\
        \\Path segments are joined into the request URL path.
        \\
        \\Options:
        \\  -X, --method <METHOD>     HTTP method (default: GET, POST if body present)
        \\  -H, --header "Key: Val"   Set a request header (repeatable)
        \\  -d, --data <json>          Request body (implies POST)
        \\      --body <json>          Request body (implies POST)
        \\  --<key> <value>            Query string parameter
    , .{ title, name });
}
