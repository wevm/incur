//! MCP resources, resource templates, prompts, and completion, served next to tools.

const std = @import("std");
const json = @import("json.zig");
const schema = @import("schema.zig");
const command = @import("command.zig");
const modern = @import("modern.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;
const Icon = command.Icon;

/// Suggests values for a prompt argument or template variable from its partial value and the
/// values already chosen, an object of strings. Clients receive the first 100.
pub const Completer = *const fn (a: Allocator, value: []const u8, chosen: Value) Allocator.Error![]const []const u8;

/// A completer for one prompt argument or template variable.
pub const Completion = struct {
    /// The argument or variable name.
    name: []const u8,
    /// Suggests values.
    complete: Completer,
};

/// A resource at a fixed URI.
pub const Resource = struct {
    /// The URI clients read, matched exactly.
    uri: []const u8,
    /// Programmatic name.
    name: []const u8,
    /// Human-readable title.
    title: ?[]const u8 = null,
    /// Description.
    description: ?[]const u8 = null,
    /// MIME type of the contents.
    mime_type: ?[]const u8 = null,
    /// Icons clients may show.
    icons: ?[]const Icon = null,
    /// Reads the contents: a string, one contents object as MCP spells it (with `text` or base64
    /// `blob`), or an array of them. `uri` defaults to the URI read and `mimeType` to the
    /// resource's.
    read: *const fn (a: Allocator) Allocator.Error!Value,
};

/// External origins an MCP App may reach, as hosts map them to Content Security Policy
/// directives.
pub const AppCsp = struct {
    /// Origins for fetch, XHR, and WebSocket connections (`connect-src`).
    connect_domains: ?[]const []const u8 = null,
    /// Origins for scripts, styles, images, fonts, and media.
    resource_domains: ?[]const []const u8 = null,
    /// Origins for nested iframes (`frame-src`).
    frame_domains: ?[]const []const u8 = null,
    /// Allowed document base URIs (`base-uri`).
    base_uri_domains: ?[]const []const u8 = null,
};

/// An MCP App: an HTML view hosts render for the tools that link to it with `Tool.app`. It is
/// listed and read as a resource after the others.
pub const App = struct {
    /// The `ui://` URI hosts read the view from.
    uri: []const u8,
    /// Programmatic name, which tools link to.
    name: []const u8,
    /// The HTML document.
    html: []const u8,
    /// Human-readable title.
    title: ?[]const u8 = null,
    /// Description.
    description: ?[]const u8 = null,
    /// External origins the view may reach. Hosts block every other origin.
    csp: ?AppCsp = null,
    /// Whether the host draws a border and background around the view. Hosts decide when null.
    prefers_border: ?bool = null,

    /// The view as `resources/read` returns it, with the app's hints in `_meta.ui`.
    fn contents(app: App, a: Allocator) Allocator.Error!Value {
        var ui: json.ObjectBuilder = .{};
        if (app.csp) |csp| {
            var out: json.ObjectBuilder = .{};
            const domains = [_]struct { []const u8, ?[]const []const u8 }{
                .{ "connectDomains", csp.connect_domains },
                .{ "resourceDomains", csp.resource_domains },
                .{ "frameDomains", csp.frame_domains },
                .{ "baseUriDomains", csp.base_uri_domains },
            };
            for (domains) |domain| if (domain[1]) |list| {
                const items = try a.alloc(Value, list.len);
                for (list, items) |origin, *slot| slot.* = .{ .string = origin };
                try out.put(a, domain[0], .{ .array = items });
            };
            try ui.put(a, "csp", out.finish());
        }
        if (app.prefers_border) |border| try ui.put(a, "prefersBorder", .{ .bool = border });
        var item: json.ObjectBuilder = .{};
        try item.put(a, "uri", .{ .string = app.uri });
        try item.put(a, "mimeType", .{ .string = app_mime_type });
        try item.put(a, "text", .{ .string = app.html });
        const hints = ui.finish();
        if (hints.object.len > 0) try item.put(a, "_meta", try single(a, "ui", hints));
        return .{ .array = try a.dupe(Value, &.{item.finish()}) };
    }
};

/// The MIME type of MCP App views.
const app_mime_type = "text/html;profile=mcp-app";

/// Resources whose URIs match a template such as `docs://{section}/{page}`. Templates support
/// `{name}` expressions, which match one or more characters other than `/` and `,`.
pub const ResourceTemplate = struct {
    /// The URI template.
    uri_template: []const u8,
    /// Programmatic name.
    name: []const u8,
    /// Human-readable title.
    title: ?[]const u8 = null,
    /// Description.
    description: ?[]const u8 = null,
    /// MIME type of the contents.
    mime_type: ?[]const u8 = null,
    /// Icons clients may show.
    icons: ?[]const Icon = null,
    /// Completers for template variables.
    complete: []const Completion = &.{},
    /// Reads a matching URI, given the URI and its variables as an object of strings. Returns
    /// what `Resource.read` returns.
    read: *const fn (a: Allocator, uri: []const u8, variables: Value) Allocator.Error!Value,
};

/// A prompt template clients can list and render.
pub const Prompt = struct {
    /// Programmatic name.
    name: []const u8,
    /// Human-readable title.
    title: ?[]const u8 = null,
    /// Description.
    description: ?[]const u8 = null,
    /// Icons clients may show.
    icons: ?[]const Icon = null,
    /// The arguments, which clients send as strings, such as `incur.schema(Args)`. Without one,
    /// `get` receives the raw arguments object.
    args: ?*const Type = null,
    /// Completers for arguments.
    complete: []const Completion = &.{},
    /// Renders the prompt from its validated arguments: a string becomes one user message, and
    /// an array holds messages as MCP spells them.
    get: *const fn (a: Allocator, args: Value) Allocator.Error!Value,
};

/// The methods features answer.
pub const methods = [_][]const u8{ "resources/list", "resources/templates/list", "resources/read", "prompts/list", "prompts/get", "completion/complete" };

/// A compiled level 1 URI template: literals around variables.
const Pattern = struct {
    /// The text before, between, and after the variables; one longer than `names`.
    literals: []const []const u8,
    /// The variable names.
    names: []const []const u8,

    /// Compiles a template, or returns null for other expressions and stray braces.
    fn compile(a: Allocator, template: []const u8) Allocator.Error!?Pattern {
        var literals: std.ArrayList([]const u8) = .empty;
        var names: std.ArrayList([]const u8) = .empty;
        var rest = template;
        while (std.mem.findAny(u8, rest, "{}")) |start| {
            if (rest[start] != '{') return null;
            const close = std.mem.findScalar(u8, rest[start..], '}') orelse return null;
            const name = rest[start + 1 .. start + close];
            if (name.len == 0) return null;
            for (name) |c| if (!std.ascii.isAlphanumeric(c) and c != '_') return null;
            try literals.append(a, rest[0..start]);
            try names.append(a, name);
            rest = rest[start + close + 1 ..];
        }
        try literals.append(a, rest);
        return .{ .literals = literals.items, .names = names.items };
    }

    /// Matches a URI, filling `values` with the variables. Each variable takes as much as still
    /// lets the rest match, like a greedy regex. Failed positions are remembered, so matching
    /// stays polynomial in the URI length.
    fn match(p: Pattern, a: Allocator, uri: []const u8, values: [][]const u8) Allocator.Error!bool {
        if (!std.mem.startsWith(u8, uri, p.literals[0])) return false;
        const rest = uri[p.literals[0].len..];
        // One flag per variable and remaining length: whether matching from there failed.
        const failed = try a.alloc(bool, p.names.len * (rest.len + 1));
        @memset(failed, false);
        return p.from(0, rest, values, failed);
    }

    fn from(p: Pattern, index: usize, uri: []const u8, values: [][]const u8, failed: []bool) bool {
        if (index == p.names.len) return uri.len == 0;
        const seen = &failed[index * (failed.len / p.names.len) + uri.len];
        if (seen.*) return false;
        var longest: usize = 0;
        while (longest < uri.len and uri[longest] != '/' and uri[longest] != ',') longest += 1;
        var len = longest;
        while (len > 0) : (len -= 1) {
            // Split only between UTF-8 characters, as the reference splits between JavaScript characters.
            if (len < uri.len and uri[len] & 0xC0 == 0x80) continue;
            const after = uri[len..];
            const literal = p.literals[index + 1];
            if (!std.mem.startsWith(u8, after, literal)) continue;
            values[index] = uri[0..len];
            if (p.from(index + 1, after[literal.len..], values, failed)) return true;
        }
        seen.* = true;
        return false;
    }
};

/// The result of a feature request.
pub const Answer = union(enum) {
    ok: Value,
    err: modern.Reject,
};

/// The resources, templates, and prompts of one server.
pub const Features = struct {
    resources: []const Resource,
    templates: []const ResourceTemplate,
    patterns: []const Pattern,
    prompts: []const Prompt,
    apps: []const App,

    /// Compiles the features, or returns the error text for an app without a `ui://` URI or an
    /// unsupported template.
    pub fn init(a: Allocator, resources: []const Resource, templates: []const ResourceTemplate, prompts: []const Prompt, apps: []const App) Allocator.Error!union(enum) { ok: Features, err: []const u8 } {
        for (apps) |app| if (!std.mem.startsWith(u8, app.uri, "ui://"))
            return .{ .err = try std.fmt.allocPrint(a, "MCP app \"{s}\" needs a ui:// URI, got \"{s}\".", .{ app.name, app.uri }) };
        const patterns = try a.alloc(Pattern, templates.len);
        for (templates, patterns) |template, *slot|
            slot.* = try Pattern.compile(a, template.uri_template) orelse
                return .{ .err = try std.fmt.allocPrint(a, "Unsupported URI template: {s}", .{template.uri_template}) };
        return .{ .ok = .{ .resources = resources, .templates = templates, .patterns = patterns, .prompts = prompts, .apps = apps } };
    }

    fn hasResources(f: Features) bool {
        return f.resources.len > 0 or f.templates.len > 0 or f.apps.len > 0;
    }

    fn hasCompletions(f: Features) bool {
        return f.prompts.len > 0 or f.templates.len > 0;
    }

    /// Adds the capabilities features declare after `tools`.
    pub fn capabilities(f: Features, a: Allocator, out: *json.ObjectBuilder) Allocator.Error!void {
        var changed: json.ObjectBuilder = .{};
        try changed.put(a, "listChanged", .{ .bool = true });
        if (f.hasResources()) try out.put(a, "resources", changed.finish());
        if (f.prompts.len > 0) try out.put(a, "prompts", changed.finish());
        if (f.hasCompletions()) try out.put(a, "completions", .{ .object = &.{} });
    }

    /// Whether a configured feature answers a method.
    pub fn handles(f: Features, method: []const u8) bool {
        if (std.mem.startsWith(u8, method, "resources/")) {
            for (methods[0..3]) |m| if (std.mem.eql(u8, m, method)) return f.hasResources();
            return false;
        }
        if (std.mem.eql(u8, method, "prompts/list") or std.mem.eql(u8, method, "prompts/get")) return f.prompts.len > 0;
        return std.mem.eql(u8, method, "completion/complete") and f.hasCompletions();
    }

    /// Answers a method `handles` accepts.
    pub fn answer(f: Features, a: Allocator, method: []const u8, params: Value) Allocator.Error!Answer {
        if (std.mem.eql(u8, method, "resources/list")) {
            const items = try a.alloc(Value, f.resources.len + f.apps.len);
            for (f.resources, items[0..f.resources.len]) |r, *slot| slot.* = try entry(a, "uri", r.uri, r.name, r.title, r.description, r.mime_type, r.icons);
            for (f.apps, items[f.resources.len..]) |app, *slot| slot.* = try entry(a, "uri", app.uri, app.name, app.title, app.description, app_mime_type, null);
            return .{ .ok = try single(a, "resources", .{ .array = items }) };
        }
        if (std.mem.eql(u8, method, "resources/templates/list")) {
            const items = try a.alloc(Value, f.templates.len);
            for (f.templates, items) |t, *slot| slot.* = try entry(a, "uriTemplate", t.uri_template, t.name, t.title, t.description, t.mime_type, t.icons);
            return .{ .ok = try single(a, "resourceTemplates", .{ .array = items }) };
        }
        if (std.mem.eql(u8, method, "resources/read")) return f.read(a, text(params.get("uri")));
        if (std.mem.eql(u8, method, "prompts/list")) {
            const items = try a.alloc(Value, f.prompts.len);
            for (f.prompts, items) |p, *slot| slot.* = try promptEntry(a, p);
            return .{ .ok = try single(a, "prompts", .{ .array = items }) };
        }
        if (std.mem.eql(u8, method, "prompts/get")) return f.get(a, params);
        return f.complete(a, params);
    }

    /// Answers `resources/read`.
    fn read(f: Features, a: Allocator, uri: []const u8) Allocator.Error!Answer {
        for (f.resources) |r| if (std.mem.eql(u8, r.uri, uri))
            return .{ .ok = try single(a, "contents", try contents(a, try r.read(a), uri, r.mime_type)) };
        for (f.apps) |app| if (std.mem.eql(u8, app.uri, uri))
            return .{ .ok = try single(a, "contents", try app.contents(a)) };
        for (f.templates, f.patterns) |t, p| {
            const values = try a.alloc([]const u8, p.names.len);
            if (!try p.match(a, uri, values)) continue;
            var variables: json.ObjectBuilder = .{};
            for (p.names, values) |name, value| try variables.put(a, name, .{ .string = value });
            return .{ .ok = try single(a, "contents", try contents(a, try t.read(a, uri, variables.finish()), uri, t.mime_type)) };
        }
        return .{ .err = .{
            .code = -32602,
            .message = try std.fmt.allocPrint(a, "Resource not found: {s}", .{uri}),
            .data = try single(a, "uri", .{ .string = uri }),
        } };
    }

    /// Answers `prompts/get`.
    fn get(f: Features, a: Allocator, params: Value) Allocator.Error!Answer {
        const name = text(params.get("name"));
        const prompt = for (f.prompts) |p| {
            if (std.mem.eql(u8, p.name, name)) break p;
        } else return .{ .err = .{ .code = -32602, .message = try std.fmt.allocPrint(a, "Prompt {s} not found", .{name}) } };
        const raw = params.get("arguments") orelse Value{ .object = &.{} };
        const args = if (prompt.args) |ty| args: {
            var v: schema.Validator = .{ .a = a };
            const parsed = try v.parse(ty, raw);
            if (v.issues.items.len == 0) break :args parsed orelse Value{ .object = &.{} };
            var issues: std.ArrayList([]const u8) = .empty;
            for (v.issues.items) |issue| {
                var parts: std.ArrayList([]const u8) = .empty;
                for (issue.path) |part| try parts.append(a, try json.toString(a, part));
                try issues.append(a, if (parts.items.len == 0) issue.message else try std.fmt.allocPrint(a, "{s}: {s}", .{ try std.mem.join(a, ".", parts.items), issue.message }));
            }
            return .{ .err = .{ .code = -32602, .message = try std.fmt.allocPrint(a, "Invalid arguments for prompt {s}: {s}", .{ name, try std.mem.join(a, ", ", issues.items) }) } };
        } else if (raw == .object) raw else Value{ .object = &.{} };
        const rendered = try prompt.get(a, args);
        var out: json.ObjectBuilder = .{};
        if (nonEmpty(prompt.description)) |d| try out.put(a, "description", .{ .string = d });
        try out.put(a, "messages", if (rendered == .string) messages: {
            var content: json.ObjectBuilder = .{};
            try content.put(a, "type", .{ .string = "text" });
            try content.put(a, "text", rendered);
            var message: json.ObjectBuilder = .{};
            try message.put(a, "role", .{ .string = "user" });
            try message.put(a, "content", content.finish());
            break :messages .{ .array = try a.dupe(Value, &.{message.finish()}) };
        } else rendered);
        return .{ .ok = out.finish() };
    }

    /// Answers `completion/complete`.
    fn complete(f: Features, a: Allocator, params: Value) Allocator.Error!Answer {
        const ref = params.get("ref") orelse @as(Value, .null);
        const argument = params.get("argument") orelse @as(Value, .null);
        const name = text(argument.get("name"));
        const completions: []const Completion = if (std.mem.eql(u8, text(ref.get("type")), "ref/prompt")) completions: {
            const target = text(ref.get("name"));
            for (f.prompts) |p| if (std.mem.eql(u8, p.name, target)) break :completions p.complete;
            return .{ .err = .{ .code = -32602, .message = try std.fmt.allocPrint(a, "Prompt {s} not found", .{target}) } };
        } else completions: {
            const uri = text(ref.get("uri"));
            for (f.templates) |t| if (std.mem.eql(u8, t.uri_template, uri)) break :completions t.complete;
            for (f.resources) |r| if (std.mem.eql(u8, r.uri, uri)) break :completions &.{};
            return .{ .err = .{ .code = -32602, .message = try std.fmt.allocPrint(a, "Resource template {s} not found", .{uri}) } };
        };
        const completer = for (completions) |c| {
            if (std.mem.eql(u8, c.name, name)) break c.complete;
        } else {
            var empty: json.ObjectBuilder = .{};
            try empty.put(a, "values", .{ .array = &.{} });
            try empty.put(a, "hasMore", .{ .bool = false });
            return .{ .ok = try single(a, "completion", empty.finish()) };
        };
        var chosen: json.ObjectBuilder = .{};
        const context = params.get("context") orelse @as(Value, .null);
        if (context.get("arguments")) |given| if (given == .object) for (given.object) |e|
            try chosen.put(a, e.key, .{ .string = try json.toString(a, e.value) });
        const values = try completer(a, text(argument.get("value")), chosen.finish());
        const shown = try a.alloc(Value, @min(values.len, 100));
        for (shown, values[0..shown.len]) |*slot, value| slot.* = .{ .string = value };
        var out: json.ObjectBuilder = .{};
        try out.put(a, "values", .{ .array = shown });
        try out.put(a, "total", .{ .integer = @intCast(values.len) });
        try out.put(a, "hasMore", .{ .bool = values.len > 100 });
        return .{ .ok = try single(a, "completion", out.finish()) };
    }
};

/// Returns a string value's text, or the empty string.
fn text(value: ?Value) []const u8 {
    const v = value orelse return "";
    return if (v == .string) v.string else "";
}

fn nonEmpty(value: ?[]const u8) ?[]const u8 {
    const v = value orelse return null;
    return if (v.len > 0) v else null;
}

/// Returns an object with one entry.
fn single(a: Allocator, key: []const u8, value: Value) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, key, value);
    return out.finish();
}

/// Writes icons as MCP JSON, when set.
fn putIcons(a: Allocator, out: *json.ObjectBuilder, icons: ?[]const Icon) Allocator.Error!void {
    const list = icons orelse return;
    const items = try a.alloc(Value, list.len);
    for (list, items) |icon, *slot| slot.* = try icon.toValue(a);
    try out.put(a, "icons", .{ .array = items });
}

/// Lists a resource or template.
fn entry(a: Allocator, key: []const u8, uri: []const u8, name: []const u8, title: ?[]const u8, description: ?[]const u8, mime_type: ?[]const u8, icons: ?[]const Icon) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, key, .{ .string = uri });
    try out.put(a, "name", .{ .string = name });
    if (nonEmpty(title)) |t| try out.put(a, "title", .{ .string = t });
    if (nonEmpty(description)) |d| try out.put(a, "description", .{ .string = d });
    if (nonEmpty(mime_type)) |m| try out.put(a, "mimeType", .{ .string = m });
    try putIcons(a, &out, icons);
    return out.finish();
}

/// Lists a prompt as `prompts/list` shows it.
fn promptEntry(a: Allocator, p: Prompt) Allocator.Error!Value {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "name", .{ .string = p.name });
    if (nonEmpty(p.title)) |t| try out.put(a, "title", .{ .string = t });
    if (nonEmpty(p.description)) |d| try out.put(a, "description", .{ .string = d });
    if (p.args) |ty| {
        const fields = ty.fields();
        const items = try a.alloc(Value, fields.len);
        for (fields, items) |field, *slot| {
            var item: json.ObjectBuilder = .{};
            try item.put(a, "name", .{ .string = field.name });
            if (field.ty.description) |d| try item.put(a, "description", .{ .string = d });
            try item.put(a, "required", .{ .bool = !field.ty.optional and field.ty.default == null });
            slot.* = item.finish();
        }
        try out.put(a, "arguments", .{ .array = items });
    }
    try putIcons(a, &out, p.icons);
    return out.finish();
}

/// Normalizes what a read returned into `resources/read` contents.
fn contents(a: Allocator, result: Value, uri: []const u8, mime_type: ?[]const u8) Allocator.Error!Value {
    const items: []const Value = switch (result) {
        .string => try a.dupe(Value, &.{try single(a, "text", result)}),
        .array => |items| items,
        else => &.{result},
    };
    const out = try a.alloc(Value, items.len);
    for (items, out) |item, *slot| {
        var e: json.ObjectBuilder = .{};
        try e.put(a, "uri", item.get("uri") orelse .{ .string = uri });
        const kind = if (item.get("mimeType")) |m| (if (m == .string) m.string else null) else mime_type;
        if (nonEmpty(kind)) |k| try e.put(a, "mimeType", .{ .string = k });
        if (item == .object) for (item.object) |field| if (!std.mem.eql(u8, field.key, "uri") and !std.mem.eql(u8, field.key, "mimeType"))
            try e.put(a, field.key, field.value);
        slot.* = e.finish();
    }
    return .{ .array = out };
}
