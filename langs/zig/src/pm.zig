//! Package managers: which one launched the CLI, its runner, and running its commands.

const std = @import("std");
const builtin = @import("builtin");
const js = @import("js.zig");
const command = @import("command.zig");
const cli_ = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Process = cli_.Process;
const ServeError = command.ServeError;

/// A package manager.
pub const Manager = enum { npm, pnpm, bun };

/// Returns the real path of the program, or the path itself when it cannot be resolved.
pub fn entry(a: Allocator, process: *const Process) ServeError![]const u8 {
    const program = process.program orelse return "";
    return try realPath(a, process.io, program) orelse program;
}

/// Resolves a path through symlinks, or returns null.
pub fn realPath(a: Allocator, io: std.Io, path: []const u8) ServeError!?[]const u8 {
    return command.optional(std.Io.Dir.cwd().realPathFileAlloc(io, path, a));
}

/// Detects the package manager from `npm_config_user_agent`, `npm_execpath`, and the program
/// path.
pub fn detect(a: Allocator, process: *const Process) ServeError!Manager {
    const env = process.env;
    const agent = env.get("npm_config_user_agent") orelse "";
    const exec_path = env.get("npm_execpath") orelse "";
    const path = try entry(a, process);
    if (std.mem.find(u8, agent, "pnpm") != null) return .pnpm;
    if (std.mem.find(u8, agent, "bun") != null) return .bun;
    if (std.mem.startsWith(u8, agent, "npm/")) return .npm;
    if (std.mem.find(u8, exec_path, "pnpm") != null) return .pnpm;
    if (std.mem.find(u8, exec_path, "bun") != null) return .bun;
    if (std.mem.find(u8, exec_path, "npm") != null) return .npm;
    if (std.mem.find(u8, path, "/.pnpm/") != null) return .pnpm;
    if (std.mem.find(u8, path, "/.bun/") != null) return .bun;
    return .npm;
}

/// Returns the package runner: `npx`, `pnpx`, or `bunx`.
pub fn runner(a: Allocator, process: *const Process) ServeError![]const u8 {
    return switch (try detect(a, process)) {
        .pnpm => "pnpx",
        .bun => "bunx",
        .npm => "npx",
    };
}

/// Returns the command that installs a package globally with the detected package manager.
pub fn globalInstall(a: Allocator, process: *const Process, name: []const u8) ServeError![]const []const u8 {
    const latest = try std.fmt.allocPrint(a, "{s}@latest", .{name});
    return a.dupe([]const u8, switch (try detect(a, process)) {
        .pnpm => &.{ "pnpm", "add", "--global", latest },
        .bun => &.{ "bun", "add", "--global", latest },
        .npm => &.{ "npm", "install", "--global", latest },
    });
}

/// The result of `exec`: standard output, or an error message.
pub const Exec = union(enum) { ok: []const u8, err: []const u8 };

/// Runs a command found on the `PATH` of the process environment and waits for it. A failure
/// reports its trimmed standard error, its trimmed standard output, or a `Command failed`
/// message, as Node's `execFile` errors do.
///
/// On Windows, npm, npx, pnpm, and pnpx are `.cmd` scripts. `std.process` runs a script through
/// `cmd.exe` with batch-safe quoting.
pub fn exec(a: Allocator, process: *const Process, argv: []const []const u8) ServeError!Exec {
    const path = try which(a, process, argv[0]) orelse return .{ .err = try std.fmt.allocPrint(a, "spawn {s} ENOENT", .{argv[0]}) };
    // `cmd.exe` ends the command line at a line break, which would drop the arguments after it.
    if (builtin.os.tag == .windows and (std.ascii.endsWithIgnoreCase(path, ".bat") or std.ascii.endsWithIgnoreCase(path, ".cmd")))
        for (argv[1..]) |arg| if (std.mem.findAny(u8, arg, "\r\n") != null) return .{ .err = try std.fmt.allocPrint(a, "spawn {s} EINVAL", .{argv[0]}) };
    var resolved = try a.dupe([]const u8, argv);
    resolved[0] = path;
    const result = std.process.run(a, process.io, .{ .argv = resolved, .environ_map = process.env }) catch |err|
        return .{ .err = try std.fmt.allocPrint(a, "spawn {s} {s}", .{ argv[0], try command.errorName(err) }) };
    if (result.term.success()) return .{ .ok = result.stdout };
    const stderr = js.trim(result.stderr);
    if (stderr.len > 0) return .{ .err = stderr };
    const stdout = js.trim(result.stdout);
    if (stdout.len > 0) return .{ .err = stdout };
    return .{ .err = try std.fmt.allocPrint(a, "Command failed: {s}", .{try std.mem.join(a, " ", argv)}) };
}

/// Finds an executable on the `PATH` of the process environment. On Windows, it tries each
/// `PATHEXT` extension, as `cmd.exe` does, without searching the working directory.
fn which(a: Allocator, process: *const Process, name: []const u8) ServeError!?[]const u8 {
    if (builtin.os.tag == .windows) {
        const extensions = process.env.get("PATHEXT") orelse ".COM;.EXE;.BAT;.CMD";
        var dirs = std.mem.tokenizeScalar(u8, process.env.get("PATH") orelse "", ';');
        while (dirs.next()) |dir| {
            var it = std.mem.tokenizeScalar(u8, extensions, ';');
            while (it.next()) |extension| {
                const file = try std.fmt.allocPrint(a, "{s}{s}", .{ name, extension });
                const candidate = try std.fs.path.join(a, &.{ try std.mem.replaceOwned(u8, a, dir, "\"", ""), file });
                const stat = try command.optional(std.Io.Dir.cwd().statFile(process.io, candidate, .{})) orelse continue;
                if (stat.kind == .file) return candidate;
            }
        }
        return null;
    }
    if (std.mem.findScalar(u8, name, '/') != null) return name;
    var dirs = std.mem.tokenizeScalar(u8, process.env.get("PATH") orelse "", ':');
    while (dirs.next()) |dir| {
        const candidate = try std.fs.path.join(a, &.{ dir, name });
        try command.optional(std.Io.Dir.cwd().access(process.io, candidate, .{ .execute = true })) orelse continue;
        return candidate;
    }
    return null;
}
