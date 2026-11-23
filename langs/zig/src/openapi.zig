//! Commands generated from OpenAPI documents.

const std = @import("std");
const json = @import("json.zig");
const errors = @import("errors.zig");
const command = @import("command.zig");
const fetch = @import("fetch.zig");
const http = @import("http.zig");
const schema = @import("schema.zig");
const js = @import("js.zig");
const json_schema = @import("json_schema.zig");
const cli_ = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Error = errors.Error;
const ServeError = command.ServeError;
const Type = schema.Type;

/// An OpenAPI document.
pub const Spec = union(enum) {
    /// The document as JSON text.
    json: []const u8,
    /// The parsed document.
    value: Value,
    /// A URL to fetch the document from, absolute or relative to a hosted source.
    url: []const u8,
};

/// An operation offered to `Config.include`.
pub const Operation = struct {
    /// The lowercase method.
    method: []const u8,
    /// The path template.
    path: []const u8,
    /// The operation object from the document, with references resolved.
    operation: Value,
};

/// How operations map to command names.
pub const Mode = enum {
    /// One command per operation, named after its `operationId`.
    operation,
    /// Commands nested by path segments and method.
    namespace,
};

/// Which versioned paths to keep.
pub const Versions = enum {
    /// Every version.
    all,
    /// Only the latest version of each path.
    latest,
};

/// A description for a generated group, by its space-separated path.
pub const Group = struct {
    /// The group path.
    path: []const u8,
    /// The description.
    description: []const u8,
};

/// How OpenAPI operations become commands.
pub const Config = struct {
    /// Whether schemas omit descriptions and examples.
    compact: bool = false,
    /// Request headers forwarded from `Cli.fetch` requests.
    forward_headers: []const []const u8 = &.{},
    /// Group descriptions.
    groups: []const Group = &.{},
    /// Returns whether an operation becomes a command.
    include: ?*const fn (operation: Operation) bool = null,
    /// How operations map to command names.
    mode: Mode = .operation,
    /// Whether security schemes become options.
    security: bool = true,
    /// Which versioned paths to keep.
    versions: Versions = .all,
};

/// Generates commands on `group` from a document. Requests go to `source`, below `base_path`.
pub fn generate(group: *cli_.Cli, a: Allocator, process: *const cli_.Process, spec: Spec, source: fetch.Source, base_path: ?[]const u8, config: Config) ServeError!?Error {
    // Generated commands outlive the invocation, so the document lives in the group's arena.
    const arena = group.arena.allocator();
    const document = switch (try resolve(arena, process, spec, source)) {
        .ok => |v| v,
        .err => |message| return .{ .message = try a.dupe(u8, message) },
    };
    const resolved = try dereference(arena, document, document, 0);
    var operations: std.ArrayList(Entry) = .empty;
    if (resolved.get("paths")) |paths| if (paths == .object) for (paths.object) |path| {
        if (path.value != .object) continue;
        for (path.value.object) |method| {
            if (!contains(&methods, method.key)) continue;
            const operation = if (method.value == .object) method.value else Value{ .object = &.{} };
            if (config.include) |include| if (!include(.{ .method = method.key, .path = path.key, .operation = operation })) continue;
            try operations.append(arena, .{ .method = method.key, .operation = operation, .path = path.key, .route = path.key });
        }
    };
    if (config.versions == .latest) operations = try latestVersions(arena, operations.items);
    const info = try namespaceInfo(arena, operations.items);
    for (operations.items) |*op| {
        if (config.compact) op.operation = try compactOperation(arena, op.operation);
        try addOperation(group, arena, resolved, op, &info, source, base_path, config);
    }
    for (config.groups) |g| describeGroup(group, g);
    return null;
}

/// The HTTP methods OpenAPI path items may hold.
const methods = [_][]const u8{ "delete", "get", "head", "options", "patch", "post", "put", "trace" };

/// An operation in the document.
const Entry = struct {
    method: []const u8,
    operation: Value,
    path: []const u8,
    /// The path that names the command, without its version segment for `versions = .latest`.
    route: []const u8,
};

/// Returns the parsed document or an error message.
fn resolve(a: Allocator, process: *const cli_.Process, spec: Spec, source: fetch.Source) ServeError!union(enum) { ok: Value, err: []const u8 } {
    switch (spec) {
        .value => |v| return .{ .ok = v },
        .json => |text| {
            var message: []const u8 = undefined;
            return .{ .ok = try command.optional(json.parse(a, text, &message)) orelse return .{ .err = try std.fmt.allocPrint(a, "Invalid OpenAPI document: {s}", .{message}) } };
        },
        .url => |url| {
            const target = if (http.Url.parse(url) != null) url else target: {
                const base = source.base() orelse return .{ .err = try std.fmt.allocPrint(a, "Relative OpenAPI spec URL requires a fetch URL base: {s}", .{url}) };
                const parsed = http.Url.parse(base).?;
                var dir = parsed;
                if (!std.mem.endsWith(u8, dir.path, "/")) dir.path = try std.mem.concat(a, u8, &.{ dir.path, "/" });
                break :target try dir.resolve(a, url);
            };
            const get: http.Request = .{ .url = target };
            var failure: command.Failure = .{};
            const fetched = http.send(a, process, &get) catch |err| return .{ .err = (try failure.take(err)).message };
            if (!fetched.ok()) return .{ .err = try std.fmt.allocPrint(a, "Failed to fetch OpenAPI spec from {s}: {d}", .{ url, fetched.status }) };
            var message: []const u8 = undefined;
            return .{ .ok = try command.optional(json.parse(a, fetched.body, &message)) orelse return .{ .err = message } };
        },
    }
}

/// Resolves local `$ref` pointers. A reference cycle resolves to an empty schema.
fn dereference(a: Allocator, node: Value, root: Value, depth: usize) Allocator.Error!Value {
    switch (node) {
        .array => |items| {
            const out = try a.alloc(Value, items.len);
            for (items, out) |item, *slot| slot.* = try dereference(a, item, root, depth);
            return .{ .array = out };
        },
        .object => |entries| {
            if (node.get("$ref")) |ref| if (ref == .string and std.mem.startsWith(u8, ref.string, "#")) {
                if (depth > 32) return .{ .object = &.{} };
                const target = pointer(root, ref.string) orelse return .{ .object = &.{} };
                return dereference(a, target, root, depth + 1);
            };
            const out = try a.alloc(Value.Entry, entries.len);
            for (entries, out) |entry, *slot| slot.* = .{ .key = entry.key, .value = try dereference(a, entry.value, root, depth) };
            return .{ .object = out };
        },
        else => return node,
    }
}

/// Resolves a JSON Pointer such as `#/components/schemas/User`.
fn pointer(root: Value, text: []const u8) ?Value {
    const fragment = text[1..];
    if (fragment.len <= 1) return root;
    var current = root;
    var it = std.mem.splitScalar(u8, fragment[1..], '/');
    while (it.next()) |part| {
        var buffer: [256]u8 = undefined;
        // `~1` is `/` and `~0` is `~`.
        const key = if (part.len <= buffer.len) key: {
            var n = std.mem.replace(u8, part, "~1", "/", &buffer);
            var len = part.len - n;
            var second: [256]u8 = undefined;
            n = std.mem.replace(u8, buffer[0..len], "~0", "~", &second);
            len -= n;
            break :key second[0..len];
        } else part;
        current = current.get(key) orelse return null;
    }
    return current;
}

/// Keeps the highest version of each operation; unversioned paths count as version 0.
fn latestVersions(a: Allocator, operations: []const Entry) Allocator.Error!std.ArrayList(Entry) {
    var out: std.ArrayList(Entry) = .empty;
    var keys: std.ArrayList([]const u8) = .empty;
    var versions: std.ArrayList(u64) = .empty;
    for (operations) |op| {
        var version: u64 = 0;
        var route = op.path;
        if (std.mem.startsWith(u8, op.path, "/v")) {
            var end: usize = 2;
            while (end < op.path.len and std.ascii.isDigit(op.path[end])) end += 1;
            if (end > 2 and (end == op.path.len or op.path[end] == '/')) {
                version = std.fmt.parseInt(u64, op.path[2..end], 10) catch std.math.maxInt(u64);
                route = if (end == op.path.len) "/" else op.path[end..];
            }
        }
        var shape: std.ArrayList(u8) = .empty;
        var i: usize = 0;
        while (i < route.len) : (i += 1) {
            try shape.append(a, route[i]);
            if (route[i] != '{') continue;
            const close = std.mem.findScalarPos(u8, route, i + 1, '}') orelse continue;
            if (close == i + 1) continue;
            try shape.append(a, '}');
            i = close;
        }
        const key = try std.fmt.allocPrint(a, "{s} {s}", .{ op.method, shape.items });
        var entry = op;
        entry.route = route;
        for (keys.items, 0..) |k, index| {
            if (!std.mem.eql(u8, k, key)) continue;
            if (version > versions.items[index]) {
                out.items[index] = entry;
                versions.items[index] = version;
            }
            break;
        } else {
            try keys.append(a, key);
            try versions.append(a, version);
            try out.append(a, entry);
        }
    }
    return out;
}

/// Routes and parent paths, which decide whether namespace commands need a method segment.
const NamespaceInfo = struct {
    routes: []const []const u8,
    parents: []const []const u8,

    fn count(info: *const NamespaceInfo, route: []const u8) usize {
        var n: usize = 0;
        for (info.routes) |r| n += @intFromBool(std.mem.eql(u8, r, route));
        return n;
    }
};

fn namespaceInfo(a: Allocator, operations: []const Entry) Allocator.Error!NamespaceInfo {
    var routes: std.ArrayList([]const u8) = .empty;
    var parents: std.ArrayList([]const u8) = .empty;
    for (operations) |op| {
        try routes.append(a, op.route);
        const names = try namespaceNames(a, op.route);
        for (1..@max(names.len, 1)) |i| try parents.append(a, try std.fmt.allocPrint(a, "/{s}", .{try std.mem.join(a, "/", names[0..i])}));
    }
    return .{ .routes = routes.items, .parents = parents.items };
}

/// A command path segment.
const Segment = struct { name: []const u8, description: ?[]const u8 = null };

/// Returns the namespace segments of a path: braces dropped and other characters outside
/// `[\w.-]` replaced with `-`.
fn namespaceSegments(a: Allocator, path: []const u8, operation: ?Value) Allocator.Error![]Segment {
    var out: std.ArrayList(Segment) = .empty;
    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |segment| {
        if (segment.len == 0) continue;
        const name = if (segment.len >= 2 and segment[0] == '{' and segment[segment.len - 1] == '}') segment[1 .. segment.len - 1] else segment;
        var clean: std.ArrayList(u8) = .empty;
        var in_run = false;
        for (name) |ch| {
            const keep = std.ascii.isAlphanumeric(ch) or ch == '_' or ch == '.' or ch == '-';
            if (keep) try clean.append(a, ch) else if (!in_run) try clean.append(a, '-');
            in_run = !keep;
        }
        var description: ?[]const u8 = null;
        if (operation) |op| if (op.get("parameters")) |params| if (params == .array) for (params.array) |p| {
            if (!isIn(p, "path") or !std.mem.eql(u8, stringField(p, "name") orelse "", name)) continue;
            if (stringField(p, "description")) |d| if (d.len > 0) {
                description = d;
            };
            break;
        };
        try out.append(a, .{ .name = clean.items, .description = description });
    }
    return out.items;
}

fn namespaceNames(a: Allocator, path: []const u8) Allocator.Error![]const []const u8 {
    const segments = try namespaceSegments(a, path, null);
    const names = try a.alloc([]const u8, segments.len);
    for (segments, names) |s, *slot| slot.* = s.name;
    return names;
}

/// Returns the command path of an operation.
fn commandSegments(a: Allocator, op: *const Entry, mode: Mode, info: *const NamespaceInfo) Allocator.Error![]const Segment {
    if (mode == .operation) {
        if (stringField(op.operation, "operationId")) |id| return a.dupe(Segment, &.{.{ .name = id }});
        const name = try a.dupe(u8, op.path);
        for (name) |*ch| if (ch.* == '/' or ch.* == '{' or ch.* == '}') {
            ch.* = '_';
        };
        return a.dupe(Segment, &.{.{ .name = try std.fmt.allocPrint(a, "{s}_{s}", .{ op.method, name }) }});
    }
    const segments = try namespaceSegments(a, op.route, op.operation);
    const own_path = try std.fmt.allocPrint(a, "/{s}", .{try std.mem.join(a, "/", try namespaceNames(a, op.route))});
    const needs_method = segments.len == 0 or contains(info.parents, own_path) or info.count(op.route) > 1;
    const description = stringField(op.operation, "summary") orelse stringField(op.operation, "description");
    if (description) |d| if (d.len > 0 and segments.len > 0 and segments[segments.len - 1].description == null) {
        segments[segments.len - 1].description = d;
    };
    var out: std.ArrayList(Segment) = .empty;
    if (segments.len == 0) try out.append(a, .{ .name = "root" }) else try out.appendSlice(a, segments);
    if (needs_method) try out.append(a, .{ .name = op.method });
    return out.items;
}

/// A header option.
const HeaderParam = struct {
    /// The header name.
    name: []const u8,
    /// The option name.
    option: []const u8,
    description: []const u8,
    required: bool,
    schema: ?Value,
};

/// What a generated command's handler needs to build its request.
const Call = struct {
    source: fetch.Source,
    base_path: []const u8,
    forward_headers: []const []const u8,
    method: []const u8,
    path: []const u8,
    path_params: []const []const u8,
    query_params: []const []const u8,
    body_keys: []const []const u8,
    headers: []const HeaderParam,
};

fn isIn(param: Value, location: []const u8) bool {
    return std.mem.eql(u8, stringField(param, "in") orelse "", location);
}

fn stringField(value: Value, key: []const u8) ?[]const u8 {
    const v = value.get(key) orelse return null;
    return if (v == .string) v.string else null;
}

fn boolField(value: Value, key: []const u8) bool {
    const v = value.get(key) orelse return false;
    return v == .bool and v.bool;
}

/// Returns the header options of security requirements: `apiKey` headers and HTTP basic or
/// bearer authorization.
fn securityHeaders(a: Allocator, document: Value, operation: Value) Allocator.Error![]const HeaderParam {
    const schemes = if (document.get("components")) |c| c.get("securitySchemes") orelse Value{ .object = &.{} } else Value{ .object = &.{} };
    const requirements = operation.get("security") orelse document.get("security") orelse Value{ .array = &.{} };
    var out: std.ArrayList(HeaderParam) = .empty;
    if (requirements == .array) for (requirements.array) |requirement| {
        if (requirement != .object) continue;
        for (requirement.object) |entry| {
            const scheme = schemes.get(entry.key) orelse continue;
            const kind = stringField(scheme, "type") orelse "";
            const description = stringField(scheme, "description");
            if (std.mem.eql(u8, kind, "apiKey") and isIn(scheme, "header")) if (stringField(scheme, "name")) |name| if (name.len > 0) {
                try out.append(a, .{ .name = name, .option = name, .description = description orelse try std.fmt.allocPrint(a, "{s} header", .{name}), .required = false, .schema = null });
                continue;
            };
            const http_scheme = try std.ascii.allocLowerString(a, stringField(scheme, "scheme") orelse "");
            if (std.mem.eql(u8, kind, "http") and (std.mem.eql(u8, http_scheme, "basic") or std.mem.eql(u8, http_scheme, "bearer")))
                try out.append(a, .{ .name = "authorization", .option = "authorization", .description = description orelse try std.fmt.allocPrint(a, "{s} authorization header", .{entry.key}), .required = false, .schema = null });
        }
    };
    return out.items;
}

/// Converts a parameter schema, as `toZod` does, defaulting to a string.
fn paramSchema(a: Allocator, param: Value) Allocator.Error!json_schema.Schema {
    if (param.get("schema")) |s| if (s == .object) return json_schema.convert(a, s);
    return json_schema.convert(a, .{ .object = try a.dupe(Value.Entry, &.{.{ .key = "type", .value = .{ .string = "string" } }}) });
}

/// Registers the command of one operation.
fn addOperation(group: *cli_.Cli, a: Allocator, document: Value, op: *const Entry, info: *const NamespaceInfo, source: fetch.Source, base_path: ?[]const u8, config: Config) ServeError!void {
    const operation = op.operation;
    const segments = try commandSegments(a, op, config.mode, info);
    const params = if (operation.get("parameters")) |p| (if (p == .array) p.array else &.{}) else &.{};

    var headers: std.ArrayList(HeaderParam) = .empty;
    var seen: std.ArrayList([]const u8) = .empty;
    var candidates: std.ArrayList(HeaderParam) = .empty;
    for (params) |p| if (isIn(p, "header")) try candidates.append(a, .{
        .name = stringField(p, "name") orelse "",
        .option = "",
        .description = stringField(p, "description") orelse try std.fmt.allocPrint(a, "{s} header", .{stringField(p, "name") orelse ""}),
        .required = boolField(p, "required"),
        .schema = p,
    });
    if (config.security) try candidates.appendSlice(a, try securityHeaders(a, document, operation));
    for (candidates.items) |candidate| {
        const normalized = try std.ascii.allocLowerString(a, candidate.name);
        if (contains(seen.items, normalized)) continue;
        try seen.append(a, normalized);
        var header = candidate;
        header.option = normalized;
        try headers.append(a, header);
    }

    const body_schema: ?Value = if (operation.get("requestBody")) |b| if (b.get("content")) |c| if (c.get("application/json")) |m| m.get("schema") else null else null else null;
    const body_props = if (body_schema) |b| (if (b.get("properties")) |p| (if (p == .object) p.object else &.{}) else &.{}) else &.{};
    const body_required = if (body_schema) |b| (if (b.get("required")) |r| (if (r == .array) r.array else &.{}) else &.{}) else &.{};

    // Header options take names that query parameters and body properties leave free.
    var used: std.ArrayList([]const u8) = .empty;
    for (params) |p| if (isIn(p, "query")) try used.append(a, stringField(p, "name") orelse "");
    for (body_props) |entry| try used.append(a, entry.key);
    for (headers.items) |*header| {
        header.option = try freeName(a, header.option, used.items);
        try used.append(a, header.option);
    }

    var path_params: std.ArrayList([]const u8) = .empty;
    var arg_fields: std.ArrayList(schema.Field) = .empty;
    for (params) |p| if (isIn(p, "path")) {
        const name = stringField(p, "name") orelse "";
        try path_params.append(a, name);
        var s = try paramSchema(a, p);
        if (stringField(p, "description")) |d| if (d.len > 0) {
            s = try s.describe(a, d);
        };
        try arg_fields.append(a, .{ .name = name, .ty = try (try s.coerceIfNeeded(a)).toType(a) });
    };

    var query_params: std.ArrayList([]const u8) = .empty;
    var option_fields: std.ArrayList(schema.Field) = .empty;
    for (params) |p| if (isIn(p, "query")) {
        const name = stringField(p, "name") orelse "";
        try query_params.append(a, name);
        var s = try paramSchema(a, p);
        if (!boolField(p, "required")) s = try s.optional(a);
        if (stringField(p, "description")) |d| if (d.len > 0) {
            s = try s.describe(a, d);
        };
        try putField(a, &option_fields, name, try (try s.coerceIfNeeded(a)).toType(a));
    };
    var body_keys: std.ArrayList([]const u8) = .empty;
    for (body_props) |entry| {
        try body_keys.append(a, entry.key);
        var s = try json_schema.convert(a, entry.value);
        var listed = false;
        for (body_required) |r| listed = listed or (r == .string and std.mem.eql(u8, r.string, entry.key));
        if (!listed) s = try s.optional(a);
        try putField(a, &option_fields, entry.key, try s.toType(a));
    }
    for (headers.items) |header| {
        var s = if (header.schema) |p| try paramSchema(a, p) else try paramSchema(a, .{ .object = &.{} });
        if (!header.required) s = try s.optional(a);
        s = try s.describe(a, header.description);
        try putField(a, &option_fields, header.option, try (try s.coerceIfNeeded(a)).toType(a));
    }

    const call = try a.create(Call);
    call.* = .{
        .source = source,
        .base_path = base_path orelse "",
        .forward_headers = config.forward_headers,
        .method = try std.ascii.allocUpperString(a, op.method),
        .path = op.path,
        .path_params = path_params.items,
        .query_params = query_params.items,
        .body_keys = body_keys.items,
        .headers = headers.items,
    };
    const args = if (arg_fields.items.len > 0) try typePtr(a, .{ .kind = .{ .object = arg_fields.items } }) else null;
    const options = if (option_fields.items.len > 0) try typePtr(a, .{ .kind = .{ .object = option_fields.items } }) else null;

    const read_only = std.mem.eql(u8, op.method, "get") or std.mem.eql(u8, op.method, "head") or std.mem.eql(u8, op.method, "options") or std.mem.eql(u8, op.method, "trace");
    var annotations: json.ObjectBuilder = .{};
    try annotations.put(a, "destructiveHint", .{ .bool = !read_only });
    try annotations.put(a, "idempotentHint", .{ .bool = read_only or std.mem.eql(u8, op.method, "delete") or std.mem.eql(u8, op.method, "put") });
    try annotations.put(a, "openWorldHint", .{ .bool = true });
    try annotations.put(a, "readOnlyHint", .{ .bool = read_only });
    const summary = stringField(operation, "summary");
    const description = stringField(operation, "description");
    // Help keeps the short summary; MCP tools surface the full prose.
    const tool_description = if (summary != null and description != null and summary.?.len > 0 and description.?.len > 0 and !std.mem.eql(u8, summary.?, description.?))
        try std.fmt.allocPrint(a, "{s}\n\n{s}", .{ summary.?, description.? })
    else
        null;
    const definition: command.Command = .{
        .description = summary orelse description,
        .mcp = .{ .description = tool_description, .annotations_json = annotations.finish() },
        .run = .{ .context = call, .args = args, .options = options, .env = null, .call = callOperation },
    };
    try setCommand(group, segments, definition);
}

fn typePtr(a: Allocator, ty: Type) Allocator.Error!*const Type {
    const out = try a.create(Type);
    out.* = ty;
    return out;
}

/// Sets a field, replacing one with the same name in place.
fn putField(a: Allocator, fields: *std.ArrayList(schema.Field), name: []const u8, ty: Type) Allocator.Error!void {
    for (fields.items) |*f| if (std.mem.eql(u8, f.name, name)) {
        f.ty = ty;
        return;
    };
    try fields.append(a, .{ .name = name, .ty = ty });
}

/// Returns a header option name that does not collide: the name, `header-<name>`, or
/// `header-<name>-<n>`.
fn freeName(a: Allocator, name: []const u8, used: []const []const u8) Allocator.Error![]const u8 {
    if (!contains(used, name)) return name;
    const prefix = try std.fmt.allocPrint(a, "header-{s}", .{name});
    if (!contains(used, prefix)) return prefix;
    var index: usize = 2;
    while (true) : (index += 1) {
        const candidate = try std.fmt.allocPrint(a, "{s}-{d}", .{ prefix, index });
        if (!contains(used, candidate)) return candidate;
    }
}

/// Places a command at a path, creating groups along the way.
fn setCommand(group: *cli_.Cli, segments: []const Segment, definition: command.Command) ServeError!void {
    const head = segments[0];
    if (segments.len == 1) return group.command(head.name, definition);
    const child = if (cli_.lookup(group.commands.items, head.name)) |entry| switch (entry) {
        .group => |g| existing: {
            if (g.options.description == null) g.options.description = head.description;
            break :existing g;
        },
        else => null,
    } else null;
    const target = child orelse created: {
        // Without globals, mounting a CLI only fails to allocate.
        break :created group.mount(head.name, .{ .description = head.description, .sync = null, .update = null }) catch return error.OutOfMemory;
    };
    return setCommand(target, segments[1..], definition);
}

/// Applies a configured group description to an existing generated group.
fn describeGroup(group: *cli_.Cli, g: Group) void {
    var current = group;
    var found: ?*cli_.Cli = null;
    var it = std.mem.tokenizeAny(u8, g.path, " \t\n\r");
    while (it.next()) |name| {
        found = if (cli_.lookup(current.commands.items, name)) |entry| (if (entry == .group) entry.group else null) else null;
        current = found orelse return;
    }
    if (found) |f| f.options.description = g.description;
}

/// Sends a generated command's request and returns the response data.
fn callOperation(i: *const command.Invocation) anyerror!command.Outcome {
    const call: *const Call = @ptrCast(@alignCast(i.context.?));
    const a = i.allocator;
    var path = try std.mem.concat(a, u8, &.{ call.base_path, call.path });
    for (call.path_params) |name| if (i.args.get(name)) |value| {
        const placeholder = try std.fmt.allocPrint(a, "{{{s}}}", .{name});
        if (std.mem.find(u8, path, placeholder)) |at|
            path = try std.mem.concat(a, u8, &.{ path[0..at], try jsString(a, value), path[at + placeholder.len ..] });
    };
    var input: fetch.Input = .{ .path = path, .method = call.method, .headers = .{}, .body = null, .query = .{} };
    for (call.query_params) |name| if (i.options.get(name)) |value| try input.query.set(a, name, try jsString(a, value));
    var body: json.ObjectBuilder = .{};
    for (call.body_keys) |key| if (i.options.get(key)) |value| try body.put(a, key, value);
    if (body.entries.items.len > 0) input.body = try json.stringify(a, body.finish());
    for (call.headers) |header| if (i.options.get(header.option)) |value| try input.headers.set(a, header.name, try jsString(a, value));
    if (i.request) |incoming| for (call.forward_headers) |name| {
        if (input.headers.get(name) != null) continue;
        if (incoming.headers.get(name)) |value| try input.headers.set(a, name, value);
    };
    const req = try fetch.buildRequest(a, &input);
    const reply = try call.source.send(a, i.process.?, &req);
    const data = try fetch.parseBody(a, reply.body);
    if (!reply.ok()) {
        const parsed = try fetch.parseError(a, data, reply.status);
        return i.failure.fail(.{ .code = parsed.get("code").?.string, .message = parsed.get("message").?.string });
    }
    return .{ .data = .{ .value = try json.normalize(a, data) } };
}

/// Converts a value to text as JavaScript's `String(value)` does.
fn jsString(a: Allocator, value: Value) Allocator.Error![]const u8 {
    return switch (value) {
        .string => |s| s,
        .array => |items| array: {
            var parts: std.ArrayList([]const u8) = .empty;
            for (items) |item| try parts.append(a, if (item == .null) "" else try jsString(a, item));
            break :array std.mem.join(a, ",", parts.items);
        },
        .object => "[object Object]",
        else => json.toString(a, value),
    };
}

/// Strips examples, oversized patterns, and date and time formats from parameter and body
/// schemas.
fn compactOperation(a: Allocator, operation: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.entries.appendSlice(a, operation.object);
    if (operation.get("parameters")) |params| if (params == .array) {
        const items = try a.alloc(Value, params.array.len);
        for (params.array, items) |p, *slot| {
            slot.* = p;
            const s = p.get("schema") orelse continue;
            var copy: json.ObjectBuilder = .{};
            try copy.entries.appendSlice(a, p.object);
            try copy.put(a, "schema", try compactSchema(a, s));
            slot.* = copy.finish();
        }
        try out.put(a, "parameters", .{ .array = items });
    };
    if (operation.get("requestBody")) |b| if (b.get("content")) |c| if (c.get("application/json")) |m| if (m.get("schema")) |s| {
        const media = try withKey(a, m, "schema", try compactSchema(a, s));
        const content = try withKey(a, c, "application/json", media);
        try out.put(a, "requestBody", try withKey(a, b, "content", content));
    };
    return out.finish();
}

fn withKey(a: Allocator, target: Value, key: []const u8, value: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.entries.appendSlice(a, target.object);
    try out.put(a, key, value);
    return out.finish();
}

/// Returns a schema without `example`, `examples`, patterns over 100 characters, and the
/// `date`, `date-time`, `duration`, and `time` formats, recursively.
fn compactSchema(a: Allocator, value: Value) Allocator.Error!Value {
    if (value != .object) return value;
    var out: json.ObjectBuilder = .{};
    for (value.object) |entry| {
        if (std.mem.eql(u8, entry.key, "example") or std.mem.eql(u8, entry.key, "examples")) continue;
        if (std.mem.eql(u8, entry.key, "pattern") and entry.value == .string and js.utf16Len(entry.value.string) > 100) continue;
        if (std.mem.eql(u8, entry.key, "format") and entry.value == .string and contains(&.{ "date", "date-time", "duration", "time" }, entry.value.string)) continue;
        var v = entry.value;
        if (contains(&.{ "allOf", "anyOf", "oneOf", "prefixItems" }, entry.key)) {
            if (v != .array) {
                try out.entries.append(a, entry);
                continue;
            }
            var items: std.ArrayList(Value) = .empty;
            for (v.array) |item| {
                const compacted = try compactSchema(a, item);
                if (compacted != .object or compacted.object.len > 0) try items.append(a, compacted);
            }
            if (items.items.len == 0) continue;
            v = .{ .array = items.items };
        } else if (contains(&.{ "additionalProperties", "contains", "items", "not", "propertyNames" }, entry.key)) {
            v = try compactSchema(a, v);
        } else if (contains(&.{ "$defs", "patternProperties", "properties" }, entry.key) and v == .object) {
            const map = try a.alloc(Value.Entry, v.object.len);
            for (v.object, map) |e, *slot| slot.* = .{ .key = e.key, .value = try compactSchema(a, e.value) };
            v = .{ .object = map };
        }
        try out.entries.append(a, .{ .key = entry.key, .value = v });
    }
    return out.finish();
}

fn contains(list: []const []const u8, item: []const u8) bool {
    for (list) |l| if (std.mem.eql(u8, l, item)) return true;
    return false;
}

/// Returns the OpenAPI 3.2 document describing a CLI's commands over HTTP, as the CLI serves it
/// at `/openapi.json`.
pub fn fromCli(a: Allocator, cli: *const cli_.Cli) Allocator.Error!Value {
    var paths: json.ObjectBuilder = .{};
    const globals = cli.options.globals;
    if (cli.rootCommand()) |root| try addCommand(a, &paths, &.{}, &root, globals);
    try addEntries(a, &paths, &.{}, cli.commands.items, globals);
    var info: json.ObjectBuilder = .{};
    try info.put(a, "title", .{ .string = cli.name });
    try info.put(a, "version", .{ .string = cli.options.version orelse "0.0.0" });
    if (cli.options.description) |d| if (d.len > 0) try info.put(a, "description", .{ .string = d });
    var out: json.ObjectBuilder = .{};
    try out.put(a, "openapi", .{ .string = "3.2.0" });
    try out.put(a, "info", info.finish());
    try out.put(a, "paths", paths.finish());
    return out.finish();
}

/// Adds the operations of a command list.
fn addEntries(a: Allocator, paths: *json.ObjectBuilder, segments: []const []const u8, commands: cli_.Commands, globals: ?*const Type) Allocator.Error!void {
    for (commands) |named| {
        var next: std.ArrayList([]const u8) = .empty;
        try next.appendSlice(a, segments);
        var it = std.mem.tokenizeAny(u8, named.name, " \t\n\r");
        while (it.next()) |part| try next.append(a, part);
        switch (named.entry) {
            .alias, .gateway => {},
            .command => |c| try addCommand(a, paths, next.items, c, globals),
            .group => |g| {
                if (g.options.root) |*root| try addCommand(a, paths, next.items, root, globals);
                try addEntries(a, paths, next.items, g.commands.items, globals);
            },
        }
    }
}

/// Adds one operation per path variant of a command: required arguments always appear in the
/// path, and each optional argument adds a longer variant.
fn addCommand(a: Allocator, paths: *json.ObjectBuilder, segments: []const []const u8, cmd: *const command.Command, globals: ?*const Type) Allocator.Error!void {
    // Globals are read from the same query or body as options and win over a same-named option.
    const merged: ?Type = if (globals) |g| merged: {
        var fields: std.ArrayList(schema.Field) = .empty;
        if (cmd.options()) |o| try fields.appendSlice(a, o.fields());
        for (g.fields()) |f| {
            for (fields.items) |*existing| {
                if (std.mem.eql(u8, existing.name, f.name)) {
                    existing.* = f;
                    break;
                }
            } else try fields.append(a, f);
        }
        break :merged .{ .kind = .{ .object = fields.items } };
    } else null;
    const options = if (merged) |*m| m else cmd.options();
    const args_schema = if (cmd.args()) |t| try schema.jsonSchema(a, t) else null;
    const options_schema = if (options) |t| try schema.jsonSchema(a, t) else null;
    const output_schema = if (cmd.output) |t| try schema.jsonSchema(a, t) else null;
    const args = properties(args_schema);
    const required_args = required(args_schema);
    const method = inferMethod(segments);
    const query = std.mem.eql(u8, method, "get") or std.mem.eql(u8, method, "delete");

    var base: usize = args.len;
    for (args, 0..) |entry, i| if (!hasName(required_args, entry.key)) {
        base = i;
        break;
    };
    for (base..args.len + 1) |count| {
        var parts: std.ArrayList([]const u8) = .empty;
        for (segments) |segment| try parts.append(a, try http.encodeComponent(a, segment));
        var parameters: std.ArrayList(Value) = .empty;
        var names: std.ArrayList([]const u8) = .empty;
        for (args[0..count]) |entry| {
            try parts.append(a, try std.fmt.allocPrint(a, "{{{s}}}", .{entry.key}));
            try names.append(a, entry.key);
            var parameter: json.ObjectBuilder = .{};
            try parameter.put(a, "name", .{ .string = entry.key });
            try parameter.put(a, "in", .{ .string = "path" });
            try parameter.put(a, "required", .{ .bool = true });
            try parameter.put(a, "schema", entry.value);
            try parameters.append(a, parameter.finish());
        }
        if (query) for (properties(options_schema)) |entry| {
            var parameter: json.ObjectBuilder = .{};
            try parameter.put(a, "name", .{ .string = entry.key });
            try parameter.put(a, "in", .{ .string = "query" });
            if (hasName(required(options_schema), entry.key)) try parameter.put(a, "required", .{ .bool = true });
            try parameter.put(a, "schema", entry.value);
            try parameters.append(a, parameter.finish());
        };

        var operation: json.ObjectBuilder = .{};
        try operation.put(a, "operationId", .{ .string = try operationId(a, segments, method, names.items) });
        if (cmd.description) |d| if (d.len > 0) try operation.put(a, "summary", .{ .string = d });
        if (parameters.items.len > 0) try operation.put(a, "parameters", .{ .array = parameters.items });
        if (options_schema) |o| if (!query) {
            var body: json.ObjectBuilder = .{};
            try body.put(a, "required", .{ .bool = required(o).len > 0 });
            var media: json.ObjectBuilder = .{};
            try media.put(a, "schema", o);
            var content: json.ObjectBuilder = .{};
            try content.put(a, "application/json", media.finish());
            try body.put(a, "content", content.finish());
            try operation.put(a, "requestBody", body.finish());
        };
        try operation.put(a, "responses", try responses(a, output_schema));

        const path = try std.fmt.allocPrint(a, "/{s}", .{try std.mem.join(a, "/", parts.items)});
        const item = found: for (paths.entries.items) |*entry| {
            if (std.mem.eql(u8, entry.key, path)) break :found entry;
        } else created: {
            try paths.put(a, path, .{ .object = &.{} });
            break :created &paths.entries.items[paths.entries.items.len - 1];
        };
        var operations: json.ObjectBuilder = .{};
        try operations.entries.appendSlice(a, item.value.object);
        try operations.put(a, method, operation.finish());
        item.value = operations.finish();
    }
}

/// Infers the HTTP method from the words of a command path.
fn inferMethod(segments: []const []const u8) []const u8 {
    const groups = [_]struct { []const u8, []const []const u8 }{
        .{ "delete", &.{ "delete", "remove", "rm", "destroy", "clear" } },
        .{ "patch", &.{ "update", "edit", "modify", "set", "enable", "disable", "rename", "patch" } },
        .{ "get", &.{ "get", "list", "show", "read", "search", "find", "status", "describe", "info", "health", "check" } },
    };
    for (groups) |group| for (segments) |segment| {
        // Words split at non-word characters and at lowercase-or-digit to uppercase boundaries.
        var start: usize = 0;
        for (0..segment.len + 1) |i| {
            const end = i == segment.len or !isWord(segment[i]) or
                (i > 0 and std.ascii.isUpper(segment[i]) and (std.ascii.isLower(segment[i - 1]) or std.ascii.isDigit(segment[i - 1])));
            if (!end) continue;
            const word = segment[start..i];
            for (group[1]) |w| if (std.ascii.eqlIgnoreCase(word, w)) return group[0];
            start = if (i < segment.len and !isWord(segment[i])) i + 1 else i;
        }
    };
    return "post";
}

/// Whether a byte matches `[\s_-]`.
fn isSeparator(ch: u8) bool {
    return ch == '_' or ch == '-' or std.ascii.isWhitespace(ch);
}

/// Whether a byte is a regex word character.
fn isWord(ch: u8) bool {
    return std.ascii.isAlphanumeric(ch) or ch == '_';
}

/// Returns the operation id: the method followed by the path and arguments in PascalCase.
fn operationId(a: Allocator, segments: []const []const u8, method: []const u8, args: []const []const u8) Allocator.Error![]const u8 {
    var raw: std.ArrayList([]const u8) = .empty;
    try raw.appendSlice(a, segments);
    if (args.len > 0) try raw.append(a, try std.mem.join(a, " ", args));
    const text = try std.mem.join(a, " ", raw.items);
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(a, method);
    // Replaces `(?:^|[\s_-]+)(\w)` with the uppercased word character.
    var i: usize = 0;
    if (text.len > 0 and isWord(text[0])) {
        try out.append(a, std.ascii.toUpper(text[0]));
        i = 1;
    }
    while (i < text.len) {
        if (!isSeparator(text[i])) {
            try out.append(a, text[i]);
            i += 1;
            continue;
        }
        var end = i;
        while (end < text.len and isSeparator(text[end])) end += 1;
        // A word character follows the run.
        if (end < text.len and isWord(text[end])) {
            try out.append(a, std.ascii.toUpper(text[end]));
            i = end + 1;
            continue;
        }
        // The run backtracks to its last underscore after the first character.
        const last = std.mem.findScalarLast(u8, text[i + 1 .. end], '_') orelse {
            try out.appendSlice(a, text[i..end]);
            i = end;
            continue;
        };
        try out.append(a, '_');
        i = i + 1 + last + 1;
    }
    return out.items;
}

/// Returns the `properties` of an object schema.
fn properties(value: ?Value) []const Value.Entry {
    const v = value orelse return &.{};
    return if (v.get("properties")) |p| p.object else &.{};
}

/// Returns the `required` names of an object schema.
fn required(value: ?Value) []const Value {
    const v = value orelse return &.{};
    return if (v.get("required")) |r| r.array else &.{};
}

/// Whether a list of JSON strings contains a name.
fn hasName(names: []const Value, name: []const u8) bool {
    for (names) |n| if (std.mem.eql(u8, n.string, name)) return true;
    return false;
}

/// Returns the responses of a generated operation.
fn responses(a: Allocator, output: ?Value) Allocator.Error!Value {
    var props: json.ObjectBuilder = .{};
    try props.put(a, "ok", try constant(a, .{ .bool = true }));
    try props.put(a, "data", output orelse .{ .object = &.{} });
    try props.put(a, "meta", try metaSchema(a));
    var out: json.ObjectBuilder = .{};
    try out.put(a, "200", try response(a, "Command completed successfully.", &.{ "ok", "data", "meta" }, props.finish()));
    try out.put(a, "400", try errorResponse(a, "Validation error."));
    try out.put(a, "500", try errorResponse(a, "Command failed."));
    return out.finish();
}

/// Returns `{ const: value }`.
fn constant(a: Allocator, value: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "const", value);
    return out.finish();
}

/// Returns `{ type: name }`.
fn typed(a: Allocator, name: []const u8) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "type", .{ .string = name });
    return out.finish();
}

/// Returns an object schema with required properties.
fn object(a: Allocator, names: []const []const u8, props: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "type", .{ .string = "object" });
    try out.put(a, "required", try schema.strings(a, names));
    try out.put(a, "properties", props);
    return out.finish();
}

/// Returns a JSON response description.
fn response(a: Allocator, description: []const u8, names: []const []const u8, props: Value) Allocator.Error!Value {
    var media: json.ObjectBuilder = .{};
    try media.put(a, "schema", try object(a, names, props));
    var content: json.ObjectBuilder = .{};
    try content.put(a, "application/json", media.finish());
    var out: json.ObjectBuilder = .{};
    try out.put(a, "description", .{ .string = description });
    try out.put(a, "content", content.finish());
    return out.finish();
}

/// Returns an error response description.
fn errorResponse(a: Allocator, description: []const u8) Allocator.Error!Value {
    var fields: json.ObjectBuilder = .{};
    try fields.put(a, "code", try typed(a, "string"));
    try fields.put(a, "message", try typed(a, "string"));
    try fields.put(a, "hint", try typed(a, "string"));
    try fields.put(a, "retryable", try typed(a, "boolean"));
    var props: json.ObjectBuilder = .{};
    try props.put(a, "ok", try constant(a, .{ .bool = false }));
    try props.put(a, "error", try object(a, &.{ "code", "message" }, fields.finish()));
    try props.put(a, "meta", try metaSchema(a));
    return response(a, description, &.{ "ok", "error", "meta" }, props.finish());
}

/// Returns the schema of a response's `meta`.
fn metaSchema(a: Allocator) Allocator.Error!Value {
    var props: json.ObjectBuilder = .{};
    try props.put(a, "command", try typed(a, "string"));
    try props.put(a, "duration", try typed(a, "string"));
    return object(a, &.{ "command", "duration" }, props.finish());
}
