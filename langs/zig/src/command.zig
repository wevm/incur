//! Commands, their run context, results, and middleware.

const std = @import("std");
const json = @import("json.zig");
const schema = @import("schema.zig");
const errors = @import("errors.zig");
const derive = @import("derive.zig");
const help = @import("help.zig");
const formatter = @import("formatter.zig");
const http = @import("http.zig");
const elicit_ = @import("elicit.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;
const Error = errors.Error;

/// Where a command's output may appear.
pub const OutputPolicy = enum {
    /// Humans and agents see the data.
    all,
    /// Only agents see the data. Terminals see suggestions and errors only.
    agent_only,
};

/// Variables that middleware sets and handlers read, keyed by name.
pub const Vars = json.ObjectBuilder;

/// The error a handler, middleware, or config loader returns after recording an incur `Error`
/// with `fail`.
pub const Failed = error{Failed};

/// Errors that end serving instead of being reported as incur errors: allocation failure, and
/// cancelation of the task serving the CLI, which handlers see as `error.Canceled` from `std.Io`.
pub const ServeError = Allocator.Error || std.Io.Cancelable;

/// Returns the name of an error to report, or propagates it when it is a `ServeError`.
pub fn errorName(err: anyerror) ServeError![]const u8 {
    return if (err == error.Canceled) error.Canceled else if (err == error.OutOfMemory) error.OutOfMemory else @errorName(err);
}

/// Returns the payload of a fallible result, or null when it failed with an error other than a
/// `ServeError`, which propagates.
pub fn optional(result: anytype) ServeError!?@typeInfo(@TypeOf(result)).error_union.payload {
    return result catch |err| {
        _ = try errorName(err);
        return null;
    };
}

/// Holds the `Error` recorded by `fail` until the CLI reports it.
pub const Failure = struct {
    /// The recorded error.
    err: ?Error = null,

    /// Records an error and returns `error.Failed`.
    pub fn fail(f: *Failure, e: Error) Failed {
        f.err = e;
        return error.Failed;
    }

    /// Converts a returned error into an incur error. Errors other than `error.Failed` become
    /// `UNKNOWN` errors named after the Zig error, except `error.FetchFailed`, which reports
    /// `fetch failed`; `error.OutOfMemory` and `error.Canceled` propagate.
    pub fn take(f: *Failure, err: anyerror) ServeError!Error {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        if (err == error.Canceled) return error.Canceled;
        if (err == error.Failed) if (f.err) |e| {
            f.err = null;
            return e;
        };
        // A request that never reached its server reports as JavaScript's `fetch` does.
        if (err == error.FetchFailed) return .{ .message = "fetch failed" };
        return .{ .message = @errorName(err) };
    }
};

/// The input types a handler declares: `void` for none, or a struct for `incur.schema`.
pub const Input = struct {
    /// Positional arguments.
    args: type = void,
    /// Named options.
    options: type = void,
    /// Environment variables.
    env: type = void,
};

/// The context a command handler receives, with typed arguments, options, and environment.
///
/// ```zig
/// fn greet(c: *incur.Context(.{ .args = GreetArgs })) !incur.Outcome {
///     return c.ok(.{ .message = c.args.name });
/// }
/// ```
pub fn Context(comptime input: Input) type {
    return struct {
        const Self = @This();

        /// The declared input types.
        pub const declared = input;

        /// Allocator for this invocation. Memory is freed when the CLI finishes serving. It is
        /// thread-safe when the CLI's allocator is, so concurrent tasks may share it.
        allocator: Allocator,
        /// The I/O implementation: files, the network, clocks, and `io.async` and
        /// `io.concurrent` for concurrent work.
        io: std.Io,
        /// Whether the consumer is an agent (stdout is not a terminal).
        agent: bool,
        /// Positional arguments.
        args: input.args,
        /// The binary name the user invoked.
        display_name: []const u8,
        /// Environment variables declared by the command.
        env: input.env,
        /// The resolved output format.
        format: formatter.Format,
        /// Whether the user passed `--format` or `--json`.
        format_explicit: bool,
        /// Global options, as parsed JSON.
        globals: Value,
        /// The CLI name.
        name: []const u8,
        /// Named options.
        options: input.options,
        /// Variables set by middleware.
        vars: *Vars,
        /// The CLI version.
        version: ?[]const u8,
        /// The HTTP request when the command runs through `Cli.fetch`, or null.
        request: ?*const http.Request,
        /// The failure slot `fail` writes.
        failure: *Failure,
        /// Elicitation for a 2026-07-28 MCP tool call, or null elsewhere.
        elicitation: ?*elicit_.Elicitation = null,

        /// Asks the MCP client's user for form input described by `T`, a flat struct of
        /// primitive fields, while the command runs as a 2026-07-28 tool. The call answers
        /// `input_required`, and when the client retries it with the answer, the command reruns
        /// and this returns it. Code before the call runs again on each retry. Fails with
        /// `ELICITATION_UNSUPPORTED` outside MCP and when the client does not support forms.
        pub fn elicit(c: *Self, comptime T: type, message: []const u8) (Failed || Allocator.Error)!elicit_.Elicited(T) {
            return switch (try elicit_.Elicitation.form(c.elicitation, c.allocator, T, message)) {
                .ok => |answer| answer,
                .err => |e| c.fail(e),
            };
        }

        /// Sends the MCP client's user to a URL for input that must not pass through the client,
        /// such as credentials or payment. `accept` means the user agreed to open it, not that
        /// the interaction finished.
        pub fn elicitUrl(c: *Self, message: []const u8, url: []const u8) (Failed || Allocator.Error)!elicit_.Elicited(void) {
            return switch (try elicit_.Elicitation.url(c.elicitation, c.allocator, message, url)) {
                .ok => |answer| answer,
                .err => |e| c.fail(e),
            };
        }

        /// Returns data as a successful outcome. Accepts anything `incur.encode` converts.
        pub fn ok(c: *Self, data: anytype) Allocator.Error!Outcome {
            const value = try json.normalize(c.allocator, try derive.encode(c.allocator, data));
            return .{ .data = .{ .value = if (value == .null) null else value } };
        }

        /// Records an error for the CLI to report and returns `error.Failed`.
        pub fn fail(c: *Self, e: Error) Failed {
            return c.failure.fail(e);
        }

        /// Returns a variable set by middleware or as a CLI default.
        pub fn get(c: *Self, key: []const u8) ?Value {
            return c.vars.finish().get(key);
        }

        /// Converts the global options into a typed struct described by `incur.schema(G)`.
        pub fn globalsAs(c: *Self, comptime G: type) Allocator.Error!G {
            return derive.decode(G, c.allocator, c.globals);
        }

        /// Streams chunks from an iterator with a `next(self, std.Io, Allocator) !?Chunk` method,
        /// which may perform I/O and wait. Human and TOON output writes each chunk as it
        /// arrives; JSONL writes one `chunk` record per item; other explicit formats buffer the
        /// chunks into one array. A Zig error from `next` ends the stream as an `UNKNOWN` error.
        pub fn stream(_: *Self, iterator: anytype) Outcome {
            const Ptr = @TypeOf(iterator);
            const Iterator = @typeInfo(Ptr).pointer.child;
            return .{ .stream = .{ .stream = .{
                .context = iterator,
                .next = struct {
                    fn next(context: *anyopaque, io: std.Io, a: Allocator) anyerror!?Chunk {
                        const it: Ptr = @ptrCast(@alignCast(context));
                        return Iterator.next(it, io, a);
                    }
                }.next,
            } } };
        }

        /// Streams a fixed list of chunks, stopping at the first failure.
        pub fn streamSlice(c: *Self, chunks: []const Chunk) Allocator.Error!Outcome {
            const it = try c.allocator.create(SliceIterator);
            it.* = .{ .chunks = chunks };
            return c.stream(it);
        }
    };
}

/// Iterates a slice of chunks.
const SliceIterator = struct {
    chunks: []const Chunk,
    index: usize = 0,

    fn next(it: *SliceIterator, _: std.Io, _: Allocator) anyerror!?Chunk {
        if (it.index == it.chunks.len) return null;
        it.index += 1;
        return it.chunks[it.index - 1];
    }
};

/// One streamed item: data or a failure that ends the stream.
pub const Chunk = union(enum) {
    /// A data chunk, normalized to JavaScript key order when written.
    data: Value,
    /// A failure.
    failure: Error,
};

/// A type-erased chunk iterator.
pub const Stream = struct {
    /// The iterator.
    context: *anyopaque,
    /// Returns the next chunk, or null at the end.
    next: *const fn (context: *anyopaque, io: std.Io, a: Allocator) anyerror!?Chunk,
};

/// A command result: data or a stream of chunks. Failures are returned with `Context.fail`.
pub const Outcome = union(enum) {
    /// Returned data.
    data: struct {
        /// The data, or null for no data.
        value: ?Value,
        /// Suggested next commands.
        cta: ?errors.CtaBlock = null,
    },
    /// Streamed chunks.
    stream: struct {
        /// The chunks.
        stream: Stream,
        /// Suggested next commands, shown after the stream.
        cta: ?errors.CtaBlock = null,
    },

    /// Returns no data.
    pub const none: Outcome = .{ .data = .{ .value = null } };

    /// Attaches suggested next commands.
    pub fn withCta(outcome: Outcome, block: errors.CtaBlock) Outcome {
        var out = outcome;
        switch (out) {
            inline else => |*o| o.cta = block,
        }
        return out;
    }
};

/// The raw inputs a type-erased handler receives.
pub const Invocation = struct {
    /// The handler's `context`.
    context: ?*const anyopaque = null,
    /// Allocator for this invocation.
    allocator: Allocator,
    /// The I/O implementation.
    io: std.Io,
    /// Whether the consumer is an agent.
    agent: bool,
    /// Parsed arguments.
    args: Value,
    /// Display name.
    display_name: []const u8,
    /// Parsed command environment.
    env: Value,
    /// Output format.
    format: formatter.Format,
    /// Whether the format was explicit.
    format_explicit: bool,
    /// Parsed globals.
    globals: Value,
    /// CLI name.
    name: []const u8,
    /// Parsed options.
    options: Value,
    /// Variables.
    vars: *Vars,
    /// CLI version.
    version: ?[]const u8,
    /// The HTTP request, or null.
    request: ?*const http.Request = null,
    /// The failure slot.
    failure: *Failure,
    /// Elicitation for a 2026-07-28 MCP tool call, or null elsewhere.
    elicitation: ?*elicit_.Elicitation = null,
    /// The process, which handlers generated from OpenAPI documents and MCP servers send
    /// requests through.
    process: ?*const @import("cli.zig").Process = null,
};

/// A type-erased handler with the schemas its context declares. Create one with `handler`.
pub const Handler = struct {
    /// State passed to `call` as `Invocation.context`, for handlers built at runtime.
    context: ?*const anyopaque = null,
    /// Positional arguments schema.
    args: ?*const Type,
    /// Options schema.
    options: ?*const Type,
    /// Environment schema.
    env: ?*const Type,
    /// Calls the handler.
    call: *const fn (*const Invocation) anyerror!Outcome,
};

/// Returns the schema of an input type, or null for `void`.
fn inputSchema(comptime T: type) ?*const Type {
    return if (T == void) null else derive.of(T);
}

/// Decodes an input value, or returns `{}` for `void`.
fn decodeInput(comptime T: type, a: Allocator, value: Value) Allocator.Error!T {
    return if (T == void) {} else derive.decode(T, a, value);
}

/// Wraps a handler function `fn (*incur.Context(.{ ... })) !incur.Outcome`. The argument,
/// option, and environment schemas come from the context type.
pub fn handler(comptime f: anytype) Handler {
    const Ctx = @typeInfo(@typeInfo(@TypeOf(f)).@"fn".param_types[0].?).pointer.child;
    const input = Ctx.declared;
    return .{
        .args = inputSchema(input.args),
        .options = inputSchema(input.options),
        .env = inputSchema(input.env),
        .call = struct {
            fn call(i: *const Invocation) anyerror!Outcome {
                const a = i.allocator;
                var c = contextOf(Ctx, i, try decodeInput(input.args, a, i.args), try decodeInput(input.options, a, i.options), try decodeInput(input.env, a, i.env));
                return f(&c);
            }
        }.call,
    };
}

/// Returns the context of an invocation with decoded input.
pub fn contextOf(comptime Ctx: type, i: *const Invocation, args: Ctx.declared.args, options: Ctx.declared.options, env: Ctx.declared.env) Ctx {
    return .{
        .allocator = i.allocator,
        .io = i.io,
        .agent = i.agent,
        .args = args,
        .display_name = i.display_name,
        .env = env,
        .format = i.format,
        .format_explicit = i.format_explicit,
        .globals = i.globals,
        .name = i.name,
        .options = options,
        .vars = i.vars,
        .version = i.version,
        .request = i.request,
        .failure = i.failure,
        .elicitation = i.elicitation,
    };
}

/// Middleware: runs around command handlers in registration order. Call `next.run(c)` to run
/// the rest of the chain, and `c.fail(...)` to report an error.
pub const Middleware = *const fn (c: *MiddlewareContext, next: Next) anyerror!void;

/// MCP tool annotations that describe a tool's behavior to clients.
pub const Annotations = struct {
    /// A human-readable title.
    title: ?[]const u8 = null,
    /// Whether the tool does not modify its environment.
    read_only_hint: ?bool = null,
    /// Whether the tool may perform destructive updates.
    destructive_hint: ?bool = null,
    /// Whether repeated calls with the same arguments have no additional effect.
    idempotent_hint: ?bool = null,
    /// Whether the tool may interact with external entities.
    open_world_hint: ?bool = null,

    /// Returns the annotations as MCP JSON, in declaration order.
    pub fn toValue(an: Annotations, a: Allocator) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        if (an.title) |t| try out.put(a, "title", .{ .string = t });
        inline for (.{ .{ "readOnlyHint", an.read_only_hint }, .{ "destructiveHint", an.destructive_hint }, .{ "idempotentHint", an.idempotent_hint }, .{ "openWorldHint", an.open_world_hint } }) |entry| {
            if (entry[1]) |b| try out.put(a, entry[0], .{ .bool = b });
        }
        return out.finish();
    }
};

/// An icon clients may show for a tool.
pub const Icon = struct {
    /// The icon URL, such as an `https:` or `data:` URI.
    src: []const u8,
    /// The MIME type, such as `image/png`.
    mime_type: ?[]const u8 = null,
    /// The sizes the icon suits, such as `48x48` or `any`.
    sizes: ?[]const []const u8 = null,
    /// The theme the icon suits.
    theme: ?enum { light, dark } = null,

    /// Returns the icon as MCP JSON.
    pub fn toValue(icon: Icon, a: Allocator) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        try out.put(a, "src", .{ .string = icon.src });
        if (icon.mime_type) |m| try out.put(a, "mimeType", .{ .string = m });
        if (icon.sizes) |sizes| {
            const items = try a.alloc(Value, sizes.len);
            for (sizes, items) |size, *slot| slot.* = .{ .string = size };
            try out.put(a, "sizes", .{ .array = items });
        }
        if (icon.theme) |t| try out.put(a, "theme", .{ .string = @tagName(t) });
        return out.finish();
    }
};

/// An input MCP 2026-07-28 clients mirror into an `Mcp-Param-*` HTTP header.
pub const Header = struct {
    /// The argument or option name.
    input: []const u8,
    /// The header name after `Mcp-Param-`.
    name: []const u8,
};

/// How a command appears as an MCP tool.
pub const Tool = struct {
    /// The tool name. Defaults to the command path joined with `_`.
    name: ?[]const u8 = null,
    /// The tool description. Defaults to the command description.
    description: ?[]const u8 = null,
    /// Usage guidance sent as `_meta.instructions`.
    instructions: ?[]const u8 = null,
    /// Behavior annotations.
    annotations: ?Annotations = null,
    /// Annotations as JSON, kept in their original key order. Generated commands set this to
    /// forward a remote tool's annotations; it takes precedence over `annotations`.
    annotations_json: ?Value = null,
    /// A human-readable title.
    title: ?[]const u8 = null,
    /// Icons clients may show.
    icons: ?[]const Icon = null,
    /// Inputs MCP 2026-07-28 clients mirror into headers, for directly listed tools.
    headers: []const Header = &.{},

    /// Returns the annotations as JSON, or null.
    pub fn annotationsValue(t: Tool, a: Allocator) Allocator.Error!?Value {
        if (t.annotations_json) |v| return v;
        return if (t.annotations) |an| try an.toValue(a) else null;
    }
};

/// A command definition.
pub const Command = struct {
    /// Alternative names.
    aliases: []const []const u8 = &.{},
    /// Description.
    description: ?[]const u8 = null,
    /// Whether the command changes or deletes state, shown in agent skills.
    destructive: bool = false,
    /// Examples: the arguments after the command name and an optional description.
    examples: []const help.Example = &.{},
    /// Default output format.
    format: ?formatter.Format = null,
    /// Guidance shown after examples.
    hint: ?[]const u8 = null,
    /// MCP tool settings. Null hides the command from MCP.
    mcp: ?Tool = .{},
    /// Per-command middleware, which runs after CLI and group middleware.
    middleware: []const Middleware = &.{},
    /// Output schema, such as `incur.schema(Output)`.
    output: ?*const Type = null,
    /// Output policy.
    output_policy: ?OutputPolicy = null,
    /// The handler, from `incur.handler(fn)`. A command without one returns no data.
    run: ?Handler = null,
    /// Alternative usage lines.
    usage: []const help.Usage = &.{},

    /// Returns the arguments schema.
    pub fn args(c: *const Command) ?*const Type {
        return if (c.run) |r| r.args else null;
    }

    /// Returns the options schema.
    pub fn options(c: *const Command) ?*const Type {
        return if (c.run) |r| r.options else null;
    }

    /// Returns the environment schema.
    pub fn env(c: *const Command) ?*const Type {
        return if (c.run) |r| r.env else null;
    }
};

/// The context middleware receives.
pub const MiddlewareContext = struct {
    /// Allocator for this invocation.
    allocator: Allocator,
    /// The I/O implementation.
    io: std.Io,
    /// Whether the consumer is an agent.
    agent: bool,
    /// The resolved command path.
    command: []const u8,
    /// The binary name the user invoked.
    display_name: []const u8,
    /// CLI-level environment variables, as parsed JSON.
    env: Value,
    /// The resolved output format.
    format: formatter.Format,
    /// Whether the user passed `--format` or `--json`.
    format_explicit: bool,
    /// Global options, as parsed JSON.
    globals: Value,
    /// The CLI name.
    name: []const u8,
    /// Variables for downstream middleware and handlers.
    vars: *Vars,
    /// The CLI version.
    version: ?[]const u8,
    /// The HTTP request when the command runs through `Cli.fetch`, or null.
    request: ?*const http.Request = null,
    /// The failure slot `fail` writes.
    failure: *Failure,

    /// Sets a variable for downstream middleware and handlers.
    pub fn set(c: *MiddlewareContext, key: []const u8, value: Value) Allocator.Error!void {
        try c.vars.put(c.allocator, key, value);
    }

    /// Returns a variable.
    pub fn get(c: *MiddlewareContext, key: []const u8) ?Value {
        return c.vars.finish().get(key);
    }

    /// Records an error for the CLI to report and returns `error.Failed`.
    pub fn fail(c: *MiddlewareContext, e: Error) Failed {
        return c.failure.fail(e);
    }
};

/// Runs the rest of the middleware chain and the command.
pub const Next = struct {
    /// The chain being run.
    chain: *Chain,
    /// The index of the next middleware.
    index: usize,

    /// Runs downstream middleware and the command handler.
    pub fn run(next: Next, c: *MiddlewareContext) ServeError!void {
        return next.chain.run(next.index, c);
    }
};

/// A middleware chain around a final step.
pub const Chain = struct {
    /// The middleware.
    middleware: []const Middleware,
    /// The final step's state.
    context: *anyopaque,
    /// Runs the command.
    last: *const fn (context: *anyopaque, c: *MiddlewareContext) ServeError!void,
    /// The error that replaces the result. The outermost middleware error wins, as the last
    /// `c.error()` call does in TypeScript.
    err: ?Error = null,

    /// Runs the chain from `index`.
    pub fn run(chain: *Chain, index: usize, c: *MiddlewareContext) ServeError!void {
        if (index == chain.middleware.len) return chain.last(chain.context, c);
        chain.middleware[index](c, .{ .chain = chain, .index = index + 1 }) catch |err| {
            chain.err = try c.failure.take(err);
        };
    }
};
