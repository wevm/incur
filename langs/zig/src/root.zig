//! incur: build CLIs for agents and humans, with TOON output, LLM manifests, shell
//! completions, and typed commands declared as plain Zig structs.
//!
//! This is the Zig port of the TypeScript package. For the same invocation it prints the same
//! stdout and stderr and exits with the same code. See `README.md` for a tour.

const std = @import("std");

const cli_ = @import("cli.zig");
const command = @import("command.zig");
const derive = @import("derive.zig");
const declare = @import("declare.zig");
const errors_ = @import("errors.zig");

/// A CLI: a router of commands, optionally with its own root command.
pub const Cli = cli_.Cli;
/// Options for `Cli.create`.
pub const CliOptions = cli_.Options;
/// Errors `Cli.create` reports.
pub const CreateError = cli_.CreateError;
/// Process I/O for `Cli.serveWith`.
pub const Process = cli_.Process;
/// Text shown above root help.
pub const Banner = cli_.Banner;
/// Who sees the banner.
pub const BannerMode = cli_.BannerMode;
/// Config-file option defaults.
pub const Config = cli_.Config;
/// Skill sync settings.
pub const Sync = cli_.Sync;
/// Self-update settings.
pub const Update = cli_.Update;
/// MCP server settings.
pub const Mcp = cli_.Mcp;
/// A command backed by an HTTP handler, optionally described by an OpenAPI document.
pub const Gateway = cli_.Gateway;
/// A group of commands generated from a remote MCP server's tools.
pub const McpSource = cli_.McpSource;

/// Creates a CLI named and described by a declared type: a struct is a command, a
/// `union(enum)` a group of commands. Add the commands with `Cli.handle` or `Cli.parse`.
pub const cli = declare.cli;
/// Declares a CLI and parses the process arguments into the typed command.
pub const parse = declare.parse;
/// Declares a CLI and parses explicit arguments, returning the command or an exit code.
pub const parseWith = declare.parseWith;
/// Declares a CLI and serves it, running a handler with the typed command.
pub const serve = declare.serve;
/// The result of `parseWith`: the command or an exit code.
pub const Parsed = declare.Parsed;
/// The handler `serve` and `Cli.handle` run with a typed command.
pub const Run = declare.Run;

/// A command definition.
pub const Command = command.Command;
/// The context a command handler receives.
pub const Context = command.Context;
/// The user's answer to an elicitation.
pub const Elicited = @import("elicit.zig").Elicited;
/// How the user answered an elicitation.
pub const ElicitAction = @import("elicit.zig").Action;
/// The input types a handler declares.
pub const Input = command.Input;
/// A command result.
pub const Outcome = command.Outcome;
/// One streamed item.
pub const Chunk = command.Chunk;
/// A type-erased handler.
pub const Handler = command.Handler;
/// Wraps a handler function.
pub const handler = command.handler;
/// Middleware that runs around command handlers.
pub const Middleware = command.Middleware;
/// The context middleware receives.
pub const MiddlewareContext = command.MiddlewareContext;
/// Runs the rest of the middleware chain.
pub const Next = command.Next;
/// How a command appears as an MCP tool.
pub const Tool = command.Tool;
/// MCP tool annotations.
pub const Annotations = command.Annotations;
/// An icon clients may show for an MCP tool.
pub const Icon = command.Icon;
/// An input MCP clients mirror into an `Mcp-Param-*` header.
pub const Header = command.Header;
/// Where a command's output may appear.
pub const OutputPolicy = command.OutputPolicy;
/// The error returned after recording an incur `Error` with `fail`.
pub const Failed = command.Failed;
/// Errors that end serving: allocation failure and cancelation.
pub const ServeError = command.ServeError;

/// A command failure with a machine-readable code.
pub const Error = errors_.Error;
/// A field-level validation error.
pub const FieldError = errors_.FieldError;
/// A suggested command.
pub const Cta = errors_.Cta;
/// A list of suggested commands.
pub const CtaBlock = errors_.CtaBlock;

/// A JSON value with exact integers.
pub const Value = json.Value;
/// Builds JSON objects in insertion order.
pub const ObjectBuilder = json.ObjectBuilder;

/// Returns the schema of a struct or other supported type, computed at compile time.
pub const schema = derive.of;
/// Converts a typed value to JSON.
pub const encode = derive.encode;

/// JSON values, `JSON.stringify`, and `JSON.parse` with V8's messages.
pub const json = @import("json.zig");
/// Schema nodes and JSON Schema output.
pub const schemas = @import("schema.zig");
/// Output formats.
pub const formatter = @import("formatter.zig");
/// Output filtering with `--filter-output` paths.
pub const filter = @import("filter.zig");
/// Help text.
pub const help = @import("help.zig");
/// Shell completions.
pub const completions = @import("completions.zig");
/// Argv and environment parsing.
pub const parser = @import("parser.zig");
/// Markdown manifests.
pub const skill = @import("skill.zig");
/// HTTP requests, responses, handlers, and the `std.http` adapters.
pub const http = @import("http.zig");
/// Fetch-backed command sources and curl-style argv parsing.
pub const fetch = @import("fetch.zig");
/// Commands generated from OpenAPI documents.
pub const openapi = @import("openapi.zig");
/// The MCP server.
pub const mcp = @import("mcp.zig");
/// Self-update callbacks.
pub const update = @import("update.zig");
/// Output format names.
pub const Format = formatter.Format;
