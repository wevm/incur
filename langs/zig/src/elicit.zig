//! Elicitation: asks the user of a 2026-07-28 MCP client for input while a command runs as a tool.
//!
//! MCP tool calls are stateless: a call that needs input stops the command and answers
//! `input_required`, and the client retries the call with the answer. The command reruns, and its
//! `n`th elicitation reads the answer keyed `elicit-n`. Earlier answers ride in `requestState`,
//! since a retry carries only the answers to the latest request.

const std = @import("std");
const json = @import("json.zig");
const derive = @import("derive.zig");
const parser = @import("parser.zig");
const schema = @import("schema.zig");
const errors = @import("errors.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;

/// How the user answered an elicitation.
pub const Action = enum {
    /// The user submitted the form, or agreed to open the URL.
    accept,
    /// The user declined.
    decline,
    /// The user dismissed the request.
    cancel,
};

/// The user's answer to an elicitation, with the submitted fields of an accepted form.
pub fn Elicited(comptime T: type) type {
    return struct {
        /// How the user answered.
        action: Action,
        /// The submitted fields of an accepted form.
        content: ?T = null,
    };
}

/// The answers one tool call carries and what it still needs.
pub const Elicitation = struct {
    /// The client's `elicitation` capability, or null when it declares none.
    declared: ?Value = null,
    /// Answers keyed by input request.
    responses: json.ObjectBuilder = .{},
    /// The number of elicitations so far.
    index: usize = 0,
    /// The `input_required` result the first unanswered elicitation produced.
    pending: ?Value = null,

    /// Reads a 2026-07-28 tool call's client capabilities and answers.
    pub fn init(a: Allocator, capabilities: ?Value, params: Value) Allocator.Error!Elicitation {
        var e: Elicitation = .{};
        if (capabilities) |c| if (c.get("elicitation")) |d| if (d == .object) {
            e.declared = d;
        };
        if (params.get("requestState")) |state| if (state == .string) {
            const parsed = try parseState(a, state.string);
            if (parsed == .object) for (parsed.object) |entry| try e.responses.put(a, entry.key, entry.value);
        };
        // Like the SDK, drop input responses that are not bare result objects.
        if (params.get("inputResponses")) |given| if (given == .object) for (given.object) |entry| {
            if (entry.value == .object and entry.value.get("method") == null and entry.value.get("result") == null)
                try e.responses.put(a, entry.key, entry.value);
        };
        return e;
    }

    /// Parses an echoed `requestState`, or returns null when it is not JSON.
    fn parseState(a: Allocator, text: []const u8) Allocator.Error!Value {
        var message: []const u8 = undefined;
        return json.parse(a, text, &message) catch |err| switch (err) {
            error.OutOfMemory => error.OutOfMemory,
            error.SyntaxError => .null,
        };
    }

    /// What `ask` reports: the answer, or the error to fail with.
    pub fn Asked(comptime R: type) type {
        return union(enum) { ok: R, err: errors.Error };
    }

    /// Asks for form input described by `T`.
    pub fn form(e: ?*Elicitation, a: Allocator, comptime T: type, message: []const u8) Allocator.Error!Asked(Elicited(T)) {
        const ty = derive.of(T);
        const out = try schema.jsonSchema(a, ty);
        var requested: json.ObjectBuilder = .{};
        try requested.put(a, "type", .{ .string = "object" });
        try requested.put(a, "properties", out.get("properties") orelse .{ .object = &.{} });
        if (out.get("required")) |required| if (required.array.len > 0) try requested.put(a, "required", required);
        var params: json.ObjectBuilder = .{};
        try params.put(a, "message", .{ .string = message });
        try params.put(a, "requestedSchema", requested.finish());
        return ask(e, a, "form", params.finish(), Elicited(T), struct {
            fn read(r: Allocator, action: Action, response: Value) Allocator.Error!?Elicited(T) {
                if (action != .accept) return .{ .action = action };
                const content = response.get("content") orelse return null;
                if (content != .object) return null;
                return switch (try parser.validate(r, derive.of(T), content)) {
                    .ok => |v| .{ .action = action, .content = try derive.decode(T, r, v) },
                    .err => null,
                };
            }
        }.read);
    }

    /// Sends the user to a URL.
    pub fn url(e: ?*Elicitation, a: Allocator, message: []const u8, target: []const u8) Allocator.Error!Asked(Elicited(void)) {
        var params: json.ObjectBuilder = .{};
        try params.put(a, "message", .{ .string = message });
        try params.put(a, "url", .{ .string = target });
        return ask(e, a, "url", params.finish(), Elicited(void), struct {
            fn read(_: Allocator, action: Action, _: Value) Allocator.Error!?Elicited(void) {
                return .{ .action = action };
            }
        }.read);
    }

    fn ask(maybe: ?*Elicitation, a: Allocator, comptime mode: []const u8, params: Value, comptime R: type, comptime read: fn (Allocator, Action, Value) Allocator.Error!?R) Allocator.Error!Asked(R) {
        const unsupported: Asked(R) = .{ .err = .{
            .code = "ELICITATION_UNSUPPORTED",
            .message = "Elicitation requires an MCP client that supports " ++ mode ++ " elicitation.",
            .retryable = false,
        } };
        const e = maybe orelse return unsupported;
        const key = try std.fmt.allocPrint(a, "elicit-{d}", .{e.index});
        e.index += 1;
        const declared = e.declared orelse return unsupported;
        const supported = declared.get(mode) != null or (std.mem.eql(u8, mode, "form") and declared.get("url") == null);
        if (!supported) return unsupported;
        const responses = e.responses.finish();
        if (responses.get(key)) |response| if (response == .object) if (response.get("action")) |action| if (action == .string) {
            if (std.meta.stringToEnum(Action, action.string)) |parsed| {
                if (try read(a, parsed, response)) |value| return .{ .ok = value };
            }
        };
        if (e.pending == null) {
            var answered: json.ObjectBuilder = .{};
            for (0..e.index - 1) |i| {
                const earlier = try std.fmt.allocPrint(a, "elicit-{d}", .{i});
                if (responses.get(earlier)) |value| try answered.put(a, earlier, value);
            }
            var request: json.ObjectBuilder = .{};
            try request.put(a, "mode", .{ .string = mode });
            for (params.object) |entry| try request.put(a, entry.key, entry.value);
            var create: json.ObjectBuilder = .{};
            try create.put(a, "method", .{ .string = "elicitation/create" });
            try create.put(a, "params", request.finish());
            var requests: json.ObjectBuilder = .{};
            try requests.put(a, key, create.finish());
            var pending: json.ObjectBuilder = .{};
            try pending.put(a, "resultType", .{ .string = "input_required" });
            try pending.put(a, "inputRequests", requests.finish());
            if (answered.entries.items.len > 0) try pending.put(a, "requestState", .{ .string = try json.stringify(a, answered.finish()) });
            e.pending = pending.finish();
        }
        return .{ .err = .{ .code = "INPUT_REQUIRED", .message = "Waiting for the user to respond.", .retryable = false } };
    }
};
