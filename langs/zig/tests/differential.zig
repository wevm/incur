//! Differential test: replays every case in `langs/differential/cases.json` against the
//! TypeScript reference implementation and this port, and requires identical stdout, stderr, exit
//! codes, and sandbox files. Durations are normalized in both; sandboxed cases also normalize
//! sandbox paths and timestamps, as `run.ts` does.
//!
//! Cases with a `bin` and no `sandbox` run this executable again through a link with that name and
//! only the case's environment, so the process entry point `Cli.serve` reads its real arguments,
//! environment, and binary name. With `INCUR_KCOV=<dir>`, those runs happen under kcov.
//!
//! Sandboxed cases run in this process like `run.ts` runs them: a reset sandbox directory as `HOME`
//! and working directory, a cleared environment with stub package-manager runners on `PATH`,
//! `stdin` lines fed to `--mcp`, and `requests` sent to `Cli.fetch`.
//!
//! Requires Node.js and the repository's `pnpm install`. Run from `langs/zig`.

const std = @import("std");
const incur = @import("incur");
const fixtures = @import("fixtures.zig");

const Allocator = std.mem.Allocator;
const JsonValue = std.json.Value;

pub fn main(init: std.process.Init) !void {
    if (init.environ_map.get("INCUR_FIXTURE")) |name| {
        const cli = try fixtures.create(init.gpa, name);
        defer cli.destroy();
        return cli.serve(init);
    }
    try matchesTypescript(init);
}

/// The observable result of a case.
const Outcome = struct {
    exit: u8,
    stdout: []const u8,
    stderr: []const u8,
    /// The sandbox tree, one `path<TAB>entry` line per entry, or null for unsandboxed cases.
    files: ?[]const u8 = null,
};

/// The sandbox root: `home` is the sandbox, `bin` holds the stubs, `tmp` is TMPDIR.
const Sandbox = struct {
    root: []const u8,
    home: []const u8,
    bin: []const u8,
    tmp: []const u8,
};

/// The stub runner script, as `run.ts` writes it.
const stub =
    \\#!/bin/sh
    \\{ printf '%s' "${0##*/}"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$HOME/stub.log"
    \\printf '%s' "$STUB_STDERR" >&2
    \\printf '%s' "$STUB_STDOUT"
    \\exit "${STUB_EXIT:-0}"
    \\
;

/// Replaces durations such as `12ms` with `<n>ms`.
fn normalizeDurations(a: Allocator, text: []const u8) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < text.len) {
        if (std.ascii.isDigit(text[i]) and (i == 0 or !std.ascii.isAlphanumeric(text[i - 1]))) {
            const start = i;
            while (i < text.len and std.ascii.isDigit(text[i])) i += 1;
            const ms = std.mem.startsWith(u8, text[i..], "ms") and !(i + 2 < text.len and std.ascii.isAlphanumeric(text[i + 2]));
            try out.appendSlice(a, if (ms) "<n>" else text[start..i]);
            continue;
        }
        try out.append(a, text[i]);
        i += 1;
    }
    return out.items;
}

/// Replaces sandbox paths, ISO timestamps, and `"checkedAt":<n>` with placeholders, as `run.ts`
/// does.
fn normalizeSandbox(a: Allocator, sandbox: *const Sandbox, text: []const u8) ![]const u8 {
    const paths = try std.mem.replaceOwned(u8, a, try std.mem.replaceOwned(u8, a, text, sandbox.home, "<sandbox>"), sandbox.root, "<root>");
    var out: std.ArrayList(u8) = .empty;
    var i: usize = 0;
    while (i < paths.len) {
        if (isTimestamp(paths[i..])) {
            try out.appendSlice(a, "<time>");
            i += 24;
        } else if (std.mem.startsWith(u8, paths[i..], "\"checkedAt\":") and i + 12 < paths.len and std.ascii.isDigit(paths[i + 12])) {
            try out.appendSlice(a, "\"checkedAt\":0");
            i += 12;
            while (i < paths.len and std.ascii.isDigit(paths[i])) i += 1;
        } else {
            try out.append(a, paths[i]);
            i += 1;
        }
    }
    return out.items;
}

/// Whether text starts with an ISO timestamp such as `2024-01-02T03:04:05.678Z`.
fn isTimestamp(text: []const u8) bool {
    const pattern = "dddd-dd-ddTdd:dd:dd.dddZ";
    if (text.len < pattern.len) return false;
    for (pattern, text[0..pattern.len]) |p, ch| {
        if (p == 'd') {
            if (!std.ascii.isDigit(ch)) return false;
        } else if (p != ch) return false;
    }
    return true;
}

/// Replaces `<sandbox>` and `<root>` placeholders with real paths.
fn expand(a: Allocator, sandbox: *const Sandbox, text: []const u8) ![]const u8 {
    return std.mem.replaceOwned(u8, a, try std.mem.replaceOwned(u8, a, text, "<sandbox>", sandbox.home), "<root>", sandbox.root);
}

/// Serves a case in a child process started through a link named `bin`.
fn spawn(a: Allocator, init: std.process.Init, links: []const u8, self: []const u8, case: JsonValue, index: usize) !Outcome {
    const io = init.io;
    const bin = case.object.get("bin").?.string;
    const link = try std.fs.path.join(a, &.{ links, bin });
    std.Io.Dir.cwd().symLink(io, self, link, .{}) catch |err| if (err != error.PathAlreadyExists) return err;
    var env: std.process.Environ.Map = .init(a);
    try env.put("INCUR_FIXTURE", case.object.get("cli").?.string);
    if (case.object.get("env")) |vars| for (vars.object.keys(), vars.object.values()) |k, v| try env.put(k, v.string);
    var argv: std.ArrayList([]const u8) = .empty;
    if (init.environ_map.get("INCUR_KCOV")) |dir| {
        // Each child writes its own report; the coverage script merges them.
        const out = try std.fmt.allocPrint(a, "{s}/bin-{d}", .{ dir, index });
        try argv.appendSlice(a, &.{ init.environ_map.get("INCUR_KCOV_BIN").?, try std.fmt.allocPrint(a, "--include-path={s}", .{init.environ_map.get("INCUR_KCOV_INCLUDE").?}), out });
    }
    try argv.append(a, link);
    for (case.object.get("argv").?.array.items) |arg| try argv.append(a, arg.string);
    const result = try std.process.run(a, io, .{ .argv = argv.items, .environ_map = &env });
    return .{ .exit = result.term.exited, .stdout = result.stdout, .stderr = result.stderr };
}

/// Serves a case in this process with `Cli.serveWith`.
fn serveInProcess(a: Allocator, io: std.Io, case: JsonValue) !Outcome {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer if (gpa.deinit() == .leak) @panic("the CLI leaked memory");
    const cli = try fixtures.create(gpa.allocator(), case.object.get("cli").?.string);
    defer cli.destroy();
    var env: std.process.Environ.Map = .init(a);
    if (case.object.get("env")) |vars| for (vars.object.keys(), vars.object.values()) |k, v| try env.put(k, v.string);
    var argv: std.ArrayList([]const u8) = .empty;
    for (case.object.get("argv").?.array.items) |arg| try argv.append(a, arg.string);
    var stdout: std.Io.Writer.Allocating = .init(a);
    var stderr: std.Io.Writer.Allocating = .init(a);
    const tty = if (case.object.get("tty")) |t| t.bool else false;
    const exit = try cli.serveWith(argv.items, .{ .io = io, .env = &env, .stdout = &stdout.writer, .stderr = &stderr.writer, .tty = tty });
    return .{ .exit = exit, .stdout = stdout.written(), .stderr = stderr.written() };
}

/// Creates the sandbox root with the stub runners.
fn createSandbox(a: Allocator, io: std.Io) !Sandbox {
    const root = try std.fmt.allocPrint(a, "/tmp/incur-zig-sandbox-{d}", .{std.os.linux.getpid()});
    const cwd = std.Io.Dir.cwd();
    cwd.deleteTree(io, root) catch {};
    try cwd.createDirPath(io, root);
    const real = try cwd.realPathFileAlloc(io, root, a);
    const sandbox: Sandbox = .{
        .root = real,
        .home = try std.fs.path.join(a, &.{ real, "home" }),
        .bin = try std.fs.path.join(a, &.{ real, "bin" }),
        .tmp = try std.fs.path.join(a, &.{ real, "tmp" }),
    };
    try cwd.createDirPath(io, sandbox.bin);
    try cwd.createDirPath(io, sandbox.tmp);
    for ([_][]const u8{ "bun", "bunx", "npm", "npx", "pnpm", "pnpx" }) |name| {
        const path = try std.fs.path.join(a, &.{ sandbox.bin, name });
        try cwd.writeFile(io, .{ .sub_path = path, .data = stub, .flags = .{ .permissions = .fromMode(0o755) } });
    }
    return sandbox;
}

/// Serves a sandboxed case, or sends its requests, in a reset sandbox.
fn serveSandboxed(a: Allocator, io: std.Io, sandbox: *const Sandbox, case: JsonValue, back: []const u8) !Outcome {
    const cwd = std.Io.Dir.cwd();
    cwd.deleteTree(io, sandbox.home) catch {};
    try cwd.createDirPath(io, sandbox.home);
    const seeded = case.object.get("sandbox").?.object;
    for (seeded.keys(), seeded.values()) |name, value| {
        const target = try std.fs.path.join(a, &.{ sandbox.home, name });
        try cwd.createDirPath(io, std.fs.path.dirname(target).?);
        switch (value) {
            .null => try cwd.createDirPath(io, target),
            .string => |text| try cwd.writeFile(io, .{ .sub_path = target, .data = try expand(a, sandbox, text) }),
            else => try cwd.symLink(io, try expand(a, sandbox, value.object.get("symlink").?.string), target, .{}),
        }
    }
    var env: std.process.Environ.Map = .init(a);
    try env.put("HOME", sandbox.home);
    try env.put("PATH", sandbox.bin);
    try env.put("TMPDIR", sandbox.tmp);
    if (case.object.get("env")) |vars| for (vars.object.keys(), vars.object.values()) |k, v| try env.put(k, try expand(a, sandbox, v.string));
    var argv: std.ArrayList([]const u8) = .empty;
    for (case.object.get("argv").?.array.items) |arg| try argv.append(a, arg.string);
    var input: std.ArrayList(u8) = .empty;
    if (case.object.get("stdin")) |lines| for (lines.array.items) |line| {
        switch (line) {
            .string => |text| try input.appendSlice(a, text),
            else => try input.appendSlice(a, try std.json.Stringify.valueAlloc(a, line, .{})),
        }
        try input.append(a, '\n');
    };
    var stdin: std.Io.Reader = .fixed(input.items);
    // An empty input has no buffer to read lines into, and reads as no input.
    const stdin_reader: ?*std.Io.Reader = if (input.items.len == 0) null else &stdin;
    var stdout: std.Io.Writer.Allocating = .init(a);
    var stderr: std.Io.Writer.Allocating = .init(a);
    const tty = if (case.object.get("tty")) |t| t.bool else false;
    const program = try std.fs.path.join(a, &.{ sandbox.home, if (case.object.get("bin")) |b| b.string else "cli" });

    try std.process.setCurrentPath(io, sandbox.home);
    defer std.process.setCurrentPath(io, back) catch {};
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer if (gpa.deinit() == .leak) @panic("the CLI leaked memory");
    const cli = try fixtures.create(gpa.allocator(), case.object.get("cli").?.string);
    defer cli.destroy();
    const process: incur.Process = .{
        .io = io,
        .env = &env,
        .stdout = &stdout.writer,
        .stderr = &stderr.writer,
        .stdin = stdin_reader,
        .tty = tty,
        .program = program,
        .network = fixtures.network,
    };
    var exit: u8 = 0;
    if (case.object.get("requests")) |requests| {
        try send(a, cli, &process, requests.array.items, &stdout.writer);
    } else exit = try cli.serveWith(argv.items, process);
    return .{
        .exit = exit,
        .stdout = try normalizeSandbox(a, sandbox, stdout.written()),
        .stderr = try normalizeSandbox(a, sandbox, stderr.written()),
        .files = try tree(a, io, sandbox),
    };
}

/// Sends requests to `Cli.fetch` in order and renders each response as `run.ts` does.
fn send(a: Allocator, cli: *incur.Cli, process: *const incur.Process, requests: []const JsonValue, out: *std.Io.Writer) !void {
    var session: ?[]const u8 = null;
    for (requests) |r| {
        var request: incur.http.Request = .{
            .method = if (r.object.get("method")) |m| m.string else "GET",
            .url = try (incur.http.Url.parse("http://localhost/").?).resolve(a, r.object.get("url").?.string),
        };
        if (r.object.get("headers")) |headers| for (headers.object.keys(), headers.object.values()) |k, v| {
            try request.headers.set(a, k, if (std.mem.eql(u8, v.string, "<session>")) session orelse "" else v.string);
        };
        if (r.object.get("body")) |body| request.body = switch (body) {
            .string => |s| s,
            else => try std.json.Stringify.valueAlloc(a, body, .{}),
        };
        // The Fetch API labels a string body without a content type as text.
        if (request.body != null and request.headers.get("content-type") == null) try request.headers.set(a, "content-type", "text/plain;charset=UTF-8");
        const response = try cli.fetch(a, process, &request);
        if (response.headers.get("mcp-session-id")) |id| session = id;
        try out.print("HTTP {d}\n", .{response.status});
        for (try response.headers.sorted(a)) |h|
            try out.print("{s}: {s}\n", .{ h.name, if (std.mem.eql(u8, h.name, "mcp-session-id")) "<session>" else h.value });
        try out.print("\n{s}\n", .{response.body});
    }
}

/// An entry of the sandbox tree.
const Entry = struct { path: []const u8, line: []const u8 };

/// Lists the sandbox tree sorted by path, one `path<TAB>entry` line each, with normalized
/// contents and sorted skills metadata.
fn tree(a: Allocator, io: std.Io, sandbox: *const Sandbox) ![]const u8 {
    var entries: std.ArrayList(Entry) = .empty;
    try visit(a, io, sandbox, "", &entries);
    std.mem.sort(Entry, entries.items, {}, struct {
        fn lessThan(_: void, x: Entry, y: Entry) bool {
            return std.mem.lessThan(u8, x.path, y.path);
        }
    }.lessThan);
    var out: std.ArrayList(u8) = .empty;
    for (entries.items) |e| try out.print(a, "{s}\t{s}\n", .{ e.path, e.line });
    return out.items;
}

/// Adds the entries under a sandbox directory.
fn visit(a: Allocator, io: std.Io, sandbox: *const Sandbox, relative: []const u8, entries: *std.ArrayList(Entry)) !void {
    const path = try std.fs.path.join(a, &.{ sandbox.home, relative });
    var dir = try std.Io.Dir.cwd().openDir(io, path, .{ .iterate = true });
    defer dir.close(io);
    var it = dir.iterate();
    while (try it.next(io)) |child| {
        const name = if (relative.len == 0) try a.dupe(u8, child.name) else try std.fmt.allocPrint(a, "{s}/{s}", .{ relative, child.name });
        switch (child.kind) {
            .sym_link => {
                var buffer: [std.fs.max_path_bytes]u8 = undefined;
                const target = buffer[0..try dir.readLink(io, child.name, &buffer)];
                try entries.append(a, .{ .path = name, .line = try std.fmt.allocPrint(a, "symlink {s}", .{try normalizeSandbox(a, sandbox, target)}) });
            },
            .directory => {
                try entries.append(a, .{ .path = name, .line = "dir" });
                try visit(a, io, sandbox, name, entries);
            },
            else => {
                const text = try dir.readFileAlloc(io, child.name, a, .unlimited);
                try entries.append(a, .{ .path = name, .line = try escape(a, try metadata(a, try normalizeSandbox(a, sandbox, text))) });
            },
        }
    }
}

/// Sorts the `skills` and `paths` arrays of a skills metadata file and rewrites it as compact
/// JSON with a trailing newline, as `run.ts` does. Other contents are returned unchanged.
fn metadata(a: Allocator, text: []const u8) ![]const u8 {
    var message: []const u8 = undefined;
    const value = incur.json.parse(a, text, &message) catch return text;
    const hash = value.get("hash") orelse return text;
    const skills = value.get("skills") orelse return text;
    if (hash != .string or skills != .array) return text;
    var out: incur.ObjectBuilder = .{};
    for (value.object) |entry| {
        const sorted = std.mem.eql(u8, entry.key, "skills") or (std.mem.eql(u8, entry.key, "paths") and entry.value == .array);
        try out.put(a, entry.key, if (sorted) .{ .array = try sortStrings(a, entry.value.array) } else entry.value);
    }
    return std.fmt.allocPrint(a, "{s}\n", .{try incur.json.stringify(a, out.finish())});
}

/// Sorts an array of strings as `Array.prototype.sort` does.
fn sortStrings(a: Allocator, items: []const incur.Value) ![]const incur.Value {
    const out = try a.dupe(incur.Value, items);
    std.mem.sort(incur.Value, out, {}, struct {
        fn lessThan(_: void, x: incur.Value, y: incur.Value) bool {
            return std.mem.lessThan(u8, x.string, y.string);
        }
    }.lessThan);
    return out;
}

/// Escapes newlines and tabs so an entry fits on one line.
fn escape(a: Allocator, text: []const u8) ![]const u8 {
    return std.mem.replaceOwned(u8, a, try std.mem.replaceOwned(u8, a, try std.mem.replaceOwned(u8, a, text, "\\", "\\\\"), "\n", "\\n"), "\t", "\\t");
}

/// Renders the reference `files` object like `tree`.
fn referenceTree(a: Allocator, files: JsonValue) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    for (files.object.keys(), files.object.values()) |path, value| {
        const line = switch (value) {
            .null => "dir",
            .string => |text| try escape(a, text),
            else => try std.fmt.allocPrint(a, "symlink {s}", .{value.object.get("symlink").?.string}),
        };
        try out.print(a, "{s}\t{s}\n", .{ path, line });
    }
    return out.items;
}

/// Runs every case and fails when any differs from the reference.
fn matchesTypescript(init: std.process.Init) !void {
    var arena_state = std.heap.ArenaAllocator.init(init.gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const io = init.io;
    const root = try std.Io.Dir.cwd().realPathFileAlloc(io, "../..", a);
    const dir = try std.fs.path.join(a, &.{ root, "langs/differential" });

    const cases_text = try std.Io.Dir.cwd().readFileAlloc(io, try std.fs.path.join(a, &.{ dir, "cases.json" }), a, .unlimited);
    const cases = (try std.json.parseFromSliceLeaky(JsonValue, a, cases_text, .{})).array.items;

    // `INCUR_DIFFERENTIAL_REFERENCE` names a saved `run.ts` output to reuse instead.
    const reference_text = if (init.environ_map.get("INCUR_DIFFERENTIAL_REFERENCE")) |path|
        try std.Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited)
    else reference: {
        const reference = try std.process.run(a, io, .{
            .argv = &.{ "node", "--no-warnings", "--import", "tsx", "langs/differential/run.ts" },
            .cwd = .{ .path = root },
        });
        if (!reference.term.success()) {
            std.debug.print("reference run failed: {s}\n", .{reference.stderr});
            return error.ReferenceFailed;
        }
        break :reference reference.stdout;
    };
    const expected = (try std.json.parseFromSliceLeaky(JsonValue, a, reference_text, .{})).array.items;
    if (expected.len != cases.len) return error.CaseCountMismatch;

    const self = try std.process.executablePathAlloc(io, a);
    const dump = if (init.environ_map.get("INCUR_DIFFERENTIAL_DUMP")) |path|
        try std.fs.path.resolve(a, &.{ try std.process.currentPathAlloc(io, a), path })
    else
        null;
    // Config fixtures use paths relative to the differential directory.
    try std.process.setCurrentPath(io, dir);
    const links = try std.fmt.allocPrint(a, "/tmp/incur-zig-differential-{d}", .{std.os.linux.getpid()});
    try std.Io.Dir.cwd().createDirPath(io, links);
    defer std.Io.Dir.cwd().deleteTree(io, links) catch {};
    const sandbox = try createSandbox(a, io);
    defer std.Io.Dir.cwd().deleteTree(io, sandbox.root) catch {};

    // Coverage runs the in-process cases under kcov and, separately, the `bin` cases with each
    // child under kcov, because a traced process cannot start another tracer.
    const only = init.environ_map.get("INCUR_DIFFERENTIAL_CASES");
    const filter = init.environ_map.get("INCUR_DIFFERENTIAL_FILTER");
    var failures: std.ArrayList([]const u8) = .empty;
    var compared: usize = 0;
    for (cases, expected, 0..) |case, want, index| {
        const sandboxed = case.object.get("sandbox") != null;
        const bin = case.object.get("bin") != null and !sandboxed;
        if (only) |kind| if (bin != std.mem.eql(u8, kind, "bin")) continue;
        if (filter) |f| if (std.mem.find(u8, try std.json.Stringify.valueAlloc(a, case, .{}), f) == null) continue;
        compared += 1;
        const got = if (bin)
            try spawn(a, init, links, self, case, index)
        else if (sandboxed)
            try serveSandboxed(a, io, &sandbox, case, dir)
        else
            try serveInProcess(a, io, case);
        const actual: Outcome = .{ .exit = got.exit, .stdout = try normalizeDurations(a, got.stdout), .stderr = try normalizeDurations(a, got.stderr), .files = got.files };
        const want_files = if (want.object.get("files")) |f| try referenceTree(a, f) else null;
        const reference_case: Outcome = .{
            .exit = @intCast(want.object.get("exit").?.integer),
            .stdout = try normalizeDurations(a, want.object.get("stdout").?.string),
            .stderr = try normalizeDurations(a, want.object.get("stderr").?.string),
            .files = want_files,
        };
        const files_match = if (reference_case.files) |w| std.mem.eql(u8, w, actual.files orelse "") else true;
        if (actual.exit == reference_case.exit and std.mem.eql(u8, actual.stdout, reference_case.stdout) and std.mem.eql(u8, actual.stderr, reference_case.stderr) and files_match) continue;
        var description: std.Io.Writer.Allocating = .init(a);
        try std.json.Stringify.value(case, .{}, &description.writer);
        try failures.append(a, try std.fmt.allocPrint(a, "case {d}: {s}\n--- expected (exit {d})\n{s}{s}{s}\n--- actual (exit {d})\n{s}{s}{s}", .{
            index,                 description.written(),
            reference_case.exit,   reference_case.stdout,
            reference_case.stderr, if (files_match) "" else reference_case.files.?,
            actual.exit,           actual.stdout,
            actual.stderr,         if (files_match) "" else actual.files orelse "",
        }));
    }
    if (dump) |path| {
        try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = try std.mem.join(a, "\n\n=====\n\n", failures.items) });
    }
    if (failures.items.len == 0) {
        std.debug.print("differential: {d} of {d} cases compared, all match the TypeScript reference\n", .{ compared, cases.len });
        return;
    }
    const shown = failures.items[0..@min(15, failures.items.len)];
    std.debug.print("{d} of {d} cases differ:\n\n{s}\n", .{ failures.items.len, compared, try std.mem.join(a, "\n\n", shown) });
    return error.CasesDiffer;
}
