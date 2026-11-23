//! Commands, their run context, results, and middleware.

const std = @import("std");
const json = @import("json.zig");
const schema = @import("schema.zig");
const errors = @import("errors.zig");
const derive = @import("derive.zig");
const help = @import("help.zig");
const formatter = @import("formatter.zig");

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
    /// `UNKNOWN` errors named after the Zig error; `error.OutOfMemory` propagates.
    pub fn take(f: *Failure, err: anyerror) Allocator.Error!Error {
        if (err == error.OutOfMemory) return error.OutOfMemory;
        if (err == error.Failed) if (f.err) |e| {
            f.err = null;
            return e;
        };
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

        /// Allocator for this invocation. Memory is freed when the CLI finishes serving.
        allocator: Allocator,
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
        /// The failure slot `fail` writes.
        failure: *Failure,

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

        /// Streams chunks from an iterator with a `next(self, Allocator) anyerror!?Chunk` method.
        /// Human and TOON output writes each chunk as it arrives; JSONL writes one `chunk`
        /// record per item; other explicit formats buffer the chunks into one array.
        pub fn stream(_: *Self, iterator: anytype) Outcome {
            const Ptr = @TypeOf(iterator);
            const Iterator = @typeInfo(Ptr).pointer.child;
            return .{ .stream = .{ .stream = .{
                .context = iterator,
                .next = struct {
                    fn next(context: *anyopaque, a: Allocator) anyerror!?Chunk {
                        const it: Ptr = @ptrCast(@alignCast(context));
                        return Iterator.next(it, a);
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

    fn next(it: *SliceIterator, _: Allocator) anyerror!?Chunk {
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
    next: *const fn (context: *anyopaque, a: Allocator) anyerror!?Chunk,
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
    /// Allocator for this invocation.
    allocator: Allocator,
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
    /// The failure slot.
    failure: *Failure,
};

/// A type-erased handler with the schemas its context declares. Create one with `handler`.
pub const Handler = struct {
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
                var c: Ctx = .{
                    .allocator = a,
                    .agent = i.agent,
                    .args = try decodeInput(input.args, a, i.args),
                    .display_name = i.display_name,
                    .env = try decodeInput(input.env, a, i.env),
                    .format = i.format,
                    .format_explicit = i.format_explicit,
                    .globals = i.globals,
                    .name = i.name,
                    .options = try decodeInput(input.options, a, i.options),
                    .vars = i.vars,
                    .version = i.version,
                    .failure = i.failure,
                };
                return f(&c);
            }
        }.call,
    };
}

/// Middleware: runs around command handlers in registration order. Call `next.run(c)` to run
/// the rest of the chain, and `c.fail(...)` to report an error.
pub const Middleware = *const fn (c: *MiddlewareContext, next: Next) anyerror!void;

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
    pub fn run(next: Next, c: *MiddlewareContext) Allocator.Error!void {
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
    last: *const fn (context: *anyopaque, c: *MiddlewareContext) Allocator.Error!void,
    /// The error that replaces the result. The outermost middleware error wins, as the last
    /// `c.error()` call does in TypeScript.
    err: ?Error = null,

    /// Runs the chain from `index`.
    pub fn run(chain: *Chain, index: usize, c: *MiddlewareContext) Allocator.Error!void {
        if (index == chain.middleware.len) return chain.last(chain.context, c);
        chain.middleware[index](c, .{ .chain = chain, .index = index + 1 }) catch |err| {
            chain.err = try c.failure.take(err);
        };
    }
};
