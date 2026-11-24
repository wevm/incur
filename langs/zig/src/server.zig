//! The CLI as an HTTP handler: commands at their paths, MCP at `/mcp`, the OpenAPI document,
//! and Agent Skills discovery.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const errors = @import("errors.zig");
const command = @import("command.zig");
const http = @import("http.zig");
const parser = @import("parser.zig");
const skill = @import("skill.zig");
const yaml = @import("yaml.zig");
const mcp = @import("mcp.zig");
const openapi = @import("openapi.zig");
const cli_ = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Error = errors.Error;
const Command = command.Command;
const Middleware = command.Middleware;
const ServeError = command.ServeError;
const Cli = cli_.Cli;
const Process = cli_.Process;

/// Answers a request with the CLI.
pub fn handle(cli: *Cli, a: Allocator, process: *const Process, request: *const http.Request) ServeError!http.Response {
    const start = std.Io.Clock.awake.now(process.io);
    _ = try cli.load(a, process, null);
    const url = http.Url.parse(request.url) orelse http.Url{ .scheme = "http", .host = "localhost", .path = "/", .query = "" };
    var segments: std.ArrayList([]const u8) = .empty;
    var it = std.mem.tokenizeScalar(u8, url.path, '/');
    while (it.next()) |segment| try segments.append(a, segment);
    const parts = segments.items;
    const get = std.mem.eql(u8, request.method, "GET");

    if (get and isOpenapiRoute(parts)) {
        const document = try openapi.fromCli(a, cli);
        const is_yaml = std.mem.eql(u8, parts[0], "openapi.yml") or std.mem.eql(u8, parts[0], "openapi.yaml");
        var response = try http.Response.text(a, if (is_yaml) try yaml.stringifyAliased(a, document) else try json.stringify(a, document), 200, if (is_yaml) "application/yaml" else "application/json");
        try response.headers.set(a, "cache-control", "public, max-age=300");
        return response;
    }

    if (parts.len == 1 and std.mem.eql(u8, parts[0], "mcp")) return mcp.handleHttp(a, cli, process, request);

    if (get and parts.len >= 3 and std.mem.eql(u8, parts[0], ".well-known") and
        (std.mem.eql(u8, parts[1], "agent-skills") or std.mem.eql(u8, parts[1], "skills")))
        return skills(a, cli, url, parts);

    var options: Value = .{ .object = &.{} };
    if (get) {
        const params = try http.SearchParams.parse(a, url.query);
        var out: json.ObjectBuilder = .{};
        for (params.list.items) |entry| try out.put(a, entry.key, entry.value);
        options = out.finish();
    } else if (std.mem.find(u8, request.headers.get("content-type") orelse "", "application/json") != null) {
        var message: []const u8 = undefined;
        options = try command.optional(json.parse(a, request.body orelse "", &message)) orelse options;
    }

    var call: Call = .{ .a = a, .cli = cli, .process = process, .request = request, .start = start };
    if (parts.len == 0) {
        if (cli.options.root) |*root| return call.execute(root, &.{}, cli.name, &.{}, options);
        return call.notFound("No root command defined.", "/");
    }
    var commands: cli_.Commands = cli.commands.items;
    var middleware: std.ArrayList(Middleware) = .empty;
    var path: std.ArrayList([]const u8) = .empty;
    var index: usize = 0;
    while (true) {
        const token = parts[index];
        const entry = cli_.lookup(commands, token) orelse return call.notFound(try notFoundMessage(a, cli.name, path.items, token, commands), token);
        try path.append(a, token);
        index += 1;
        switch (entry) {
            .gateway => |g| return g.fetch.send(a, process, request) catch |err| call.fetchFailure(err),
            .alias, .command => |c| return call.execute(c, middleware.items, try std.mem.join(a, " ", path.items), parts[index..], options),
            .group => |g| {
                try middleware.appendSlice(a, g.middleware.items);
                if (index == parts.len) {
                    if (g.options.root) |*root| return call.execute(root, middleware.items, try std.mem.join(a, " ", path.items), &.{}, options);
                    const joined = try std.mem.join(a, " ", path.items);
                    return call.notFound(try std.fmt.allocPrint(a, "'{s}' is a command group. Specify a subcommand.", .{joined}), joined);
                }
                if (cli_.lookup(g.commands.items, parts[index]) == null) if (g.options.root) |*root| {
                    if (try cli_.suggest(a, parts[index], try cli_.names(a, g.commands.items)) == null)
                        return call.execute(root, middleware.items, try std.mem.join(a, " ", path.items), parts[index..], options);
                };
                commands = g.commands.items;
            },
        }
    }
}

/// Returns the message for an unknown command.
fn notFoundMessage(a: Allocator, name: []const u8, path: []const []const u8, token: []const u8, commands: cli_.Commands) Allocator.Error![]const u8 {
    const parent = if (path.len == 0) name else try std.fmt.allocPrint(a, "{s} {s}", .{ name, try std.mem.join(a, " ", path) });
    const suggestion = try cli_.suggest(a, token, try cli_.names(a, commands));
    const did_you_mean = if (suggestion) |s| try std.fmt.allocPrint(a, " Did you mean '{s}'?", .{s}) else "";
    return std.fmt.allocPrint(a, "'{s}' is not a command for '{s}'.{s}", .{ token, parent, did_you_mean });
}

/// Whether a path names the OpenAPI document.
fn isOpenapiRoute(parts: []const []const u8) bool {
    if (parts.len == 1) for ([_][]const u8{ "openapi.json", "openapi.yml", "openapi.yaml" }) |name| {
        if (std.mem.eql(u8, parts[0], name)) return true;
    };
    return parts.len == 2 and std.mem.eql(u8, parts[0], ".well-known") and std.mem.eql(u8, parts[1], "openapi.json");
}

/// Answers Agent Skills discovery: the v0.2.0 index at `/.well-known/agent-skills/`, the v0.1.0
/// index at `/.well-known/skills/`, and each `SKILL.md`.
fn skills(a: Allocator, cli: *Cli, url: http.Url, parts: []const []const u8) ServeError!http.Response {
    const infos = try cli_.skillInfos(a, cli);
    const shown = if (cli.options.sync) |s| s.command orelse cli.name else cli.name;
    const files = try skill.splitAs(a, cli.name, shown, infos.commands, infos.groups, 1);
    if (parts.len == 3 and std.mem.eql(u8, parts[2], "index.json")) {
        const v2 = std.mem.eql(u8, parts[1], "agent-skills");
        var entries: std.ArrayList(skill.Discovered) = .empty;
        for (files) |f| try entries.append(a, .{
            .name = if (f.dir.len > 0) f.dir else cli.name,
            .description = f.description,
            .content = f.content,
        });
        const index = if (v2) try skill.discovery(a, try url.origin(a), entries.items) else index: {
            const items = try a.alloc(Value, entries.items.len);
            for (entries.items, items) |e, *slot| {
                var entry: json.ObjectBuilder = .{};
                try entry.put(a, "name", .{ .string = e.name });
                try entry.put(a, "description", .{ .string = e.description });
                try entry.put(a, "files", .{ .array = try a.dupe(Value, &.{.{ .string = "SKILL.md" }}) });
                slot.* = entry.finish();
            }
            var out: json.ObjectBuilder = .{};
            try out.put(a, "skills", .{ .array = items });
            break :index out.finish();
        };
        var response = try http.Response.json(a, index, 200);
        try response.headers.set(a, "cache-control", "public, max-age=300");
        return response;
    }
    if (parts.len == 4 and std.mem.eql(u8, parts[3], "SKILL.md")) for (files) |f| {
        if (!std.mem.eql(u8, if (f.dir.len > 0) f.dir else cli.name, parts[2])) continue;
        var response = try http.Response.text(a, f.content, 200, "text/markdown");
        try response.headers.set(a, "cache-control", "public, max-age=300");
        return response;
    };
    return http.Response.text(a, "Not Found", 404, "text/plain;charset=UTF-8");
}

/// A command invocation over HTTP.
const Call = struct {
    a: Allocator,
    cli: *Cli,
    process: *const Process,
    request: *const http.Request,
    start: std.Io.Timestamp,

    /// Returns the elapsed time as `Nms`.
    fn duration(c: *const Call) Allocator.Error![]const u8 {
        const elapsed = c.start.durationTo(std.Io.Clock.awake.now(c.process.io));
        return std.fmt.allocPrint(c.a, "{d}ms", .{@divTrunc(elapsed.nanoseconds, std.time.ns_per_ms)});
    }

    /// Returns the `meta` object of a response.
    fn meta(c: *const Call, path: []const u8, cta: ?errors.FormattedCtaBlock) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        try out.put(c.a, "command", .{ .string = path });
        try out.put(c.a, "duration", .{ .string = try c.duration() });
        if (cta) |block| try out.put(c.a, "cta", try block.toValue(c.a));
        return out.finish();
    }

    /// Returns a JSON envelope response.
    fn envelope(c: *const Call, ok: bool, body: ?Value, path: []const u8, cta: ?errors.FormattedCtaBlock, status: u16) Allocator.Error!http.Response {
        var out: json.ObjectBuilder = .{};
        try out.put(c.a, "ok", .{ .bool = ok });
        if (body) |b| try out.put(c.a, if (ok) "data" else "error", b);
        try out.put(c.a, "meta", try c.meta(path, cta));
        return http.Response.json(c.a, out.finish(), status);
    }

    /// Returns a 404 for an unknown command.
    fn notFound(c: *const Call, message: []const u8, path: []const u8) Allocator.Error!http.Response {
        return c.envelope(false, try (Error{ .code = "COMMAND_NOT_FOUND", .message = message }).toValue(c.a), path, null, 404);
    }

    /// Reports a fetch-backed command whose handler failed.
    fn fetchFailure(c: *const Call, err: anyerror) ServeError!http.Response {
        var failure: command.Failure = .{};
        const e = try failure.take(err);
        return c.envelope(false, try e.toValue(c.a), "", null, 500);
    }

    /// Runs a command with path arguments and options from the query or body.
    fn execute(c: *const Call, cmd: *const Command, middleware: []const Middleware, path: []const u8, rest: []const []const u8, input: Value) ServeError!http.Response {
        const a = c.a;
        var globals: Value = .{ .object = &.{} };
        var options = input;
        if (c.cli.options.globals) |schema_| {
            var raw: json.ObjectBuilder = .{};
            var others: json.ObjectBuilder = .{};
            if (input == .object) for (input.object) |entry| {
                try (if (schema_.field(entry.key) != null) &raw else &others).put(a, entry.key, entry.value);
            };
            options = others.finish();
            globals = switch (try parser.validate(a, schema_, raw.finish())) {
                .ok => |v| v,
                .err => |e| {
                    var messages: std.ArrayList([]const u8) = .empty;
                    for (e.field_errors.?) |f| try messages.append(a, f.message);
                    const failure: Error = .{ .code = "VALIDATION_ERROR", .message = try std.mem.join(a, "; ", messages.items) };
                    return c.envelope(false, try failure.toValue(a), path, null, 400);
                },
            };
        }
        var sink: Ndjson = .{ .call = c, .path = path };
        const exec: cli_.Exec = .{
            .a = a,
            .process = c.process,
            .cli = c.cli,
            .display_name = c.cli.name,
            .agent = true,
            .format = .json,
            .format_explicit = true,
            .globals = globals,
            .request = c.request,
            .sink = .{ .context = &sink, .consume = Ndjson.consume },
        };
        return switch (try exec.run(cmd, middleware, path, .{ .split = .{ .tokens = rest, .options = options } })) {
            .streamed => http.Response.text(a, sink.body.items, 200, "application/x-ndjson"),
            .ok => |r| c.envelope(true, r.data, path, try errors.FormattedCtaBlock.init(a, c.cli.name, r.cta), 200),
            .err => |e| c.envelope(false, try e.toValue(a), path, try errors.FormattedCtaBlock.init(a, c.cli.name, e.cta), if (std.mem.eql(u8, e.code, "VALIDATION_ERROR")) 400 else 500),
        };
    }
};

/// Renders a stream as NDJSON records.
const Ndjson = struct {
    call: *const Call,
    path: []const u8,
    body: std.ArrayList(u8) = .empty,

    fn line(s: *Ndjson, value: Value) Allocator.Error!void {
        try s.body.appendSlice(s.call.a, try json.stringify(s.call.a, value));
        try s.body.append(s.call.a, '\n');
    }

    fn consume(context: *anyopaque, stream: command.Stream, cta: ?errors.CtaBlock) ServeError!cli_.ExecResult {
        const s: *Ndjson = @ptrCast(@alignCast(context));
        const c = s.call;
        const a = c.a;
        var failure: command.Failure = .{};
        while (true) {
            const next = stream.next(stream.context, c.process.io, a) catch |err| return s.fail(try failure.take(err));
            switch (next orelse break) {
                .failure => |e| return s.fail(e),
                .data => |raw| {
                    var record: json.ObjectBuilder = .{};
                    try record.put(a, "type", .{ .string = "chunk" });
                    try record.put(a, "data", try json.normalize(a, raw));
                    try s.line(record.finish());
                },
            }
        }
        var record: json.ObjectBuilder = .{};
        try record.put(a, "type", .{ .string = "done" });
        try record.put(a, "ok", .{ .bool = true });
        try record.put(a, "meta", try c.meta(s.path, try errors.FormattedCtaBlock.init(a, c.cli.name, cta)));
        try s.line(record.finish());
        return .streamed;
    }

    fn fail(s: *Ndjson, e: Error) ServeError!cli_.ExecResult {
        const a = s.call.a;
        var record: json.ObjectBuilder = .{};
        try record.put(a, "type", .{ .string = "error" });
        try record.put(a, "ok", .{ .bool = false });
        try record.put(a, "error", try e.toValue(a));
        try record.put(a, "meta", try s.call.meta(s.path, try errors.FormattedCtaBlock.init(a, s.call.cli.name, e.cta)));
        try s.line(record.finish());
        return .streamed;
    }
};
