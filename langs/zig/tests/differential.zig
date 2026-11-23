//! Differential test: replays every case in `langs/differential/cases.json` against the
//! TypeScript reference implementation and this port, and requires identical stdout, stderr, and
//! exit codes. Durations are the only normalized values.
//!
//! Cases with a `bin` run this executable again through a link with that name and only the
//! case's environment, so the process entry point `Cli.serve` reads its real arguments,
//! environment, and binary name. With `INCUR_KCOV=<dir>`, those runs happen under kcov.
//!
//! Requires Node.js and the repository's `pnpm install`. Run from `langs/zig`.

const std = @import("std");
const incur = @import("incur");
const fixtures = @import("fixtures.zig");

const Allocator = std.mem.Allocator;

pub fn main(init: std.process.Init) !void {
    if (init.environ_map.get("INCUR_FIXTURE")) |name| {
        const cli = (try fixtures.create(init.gpa, name)) orelse return error.UnknownFixture;
        defer cli.destroy();
        return cli.serve(init);
    }
    try matchesTypescript(init);
}

const Outcome = struct { exit: u8, stdout: []const u8, stderr: []const u8 };

/// Replaces durations such as `12ms` with `<n>ms`.
fn normalize(a: Allocator, text: []const u8) ![]const u8 {
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

/// Serves a case in a child process started through a link named `bin`.
fn spawn(a: Allocator, init: std.process.Init, links: []const u8, self: []const u8, case: std.json.Value, index: usize) !Outcome {
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
fn serveInProcess(a: Allocator, io: std.Io, case: std.json.Value) !Outcome {
    var gpa: std.heap.DebugAllocator(.{}) = .init;
    defer if (gpa.deinit() == .leak) @panic("the CLI leaked memory");
    const cli = (try fixtures.create(gpa.allocator(), case.object.get("cli").?.string)).?;
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

/// Runs every case and fails when any differs from the reference.
fn matchesTypescript(init: std.process.Init) !void {
    var arena_state = std.heap.ArenaAllocator.init(init.gpa);
    defer arena_state.deinit();
    const a = arena_state.allocator();
    const io = init.io;
    const root = try std.Io.Dir.cwd().realPathFileAlloc(io, "../..", a);
    const dir = try std.fs.path.join(a, &.{ root, "langs/differential" });

    const cases_text = try std.Io.Dir.cwd().readFileAlloc(io, try std.fs.path.join(a, &.{ dir, "cases.json" }), a, .unlimited);
    const cases = (try std.json.parseFromSliceLeaky(std.json.Value, a, cases_text, .{})).array.items;

    const reference = try std.process.run(a, io, .{
        .argv = &.{ "node", "--no-warnings", "--import", "tsx", "langs/differential/run.ts" },
        .cwd = .{ .path = root },
    });
    if (!reference.term.success()) {
        std.debug.print("reference run failed: {s}\n", .{reference.stderr});
        return error.ReferenceFailed;
    }
    const expected = try std.json.parseFromSliceLeaky([]const Outcome, a, reference.stdout, .{});
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

    // Coverage runs the in-process cases under kcov and, separately, the `bin` cases with each
    // child under kcov, because a traced process cannot start another tracer.
    const only = init.environ_map.get("INCUR_DIFFERENTIAL_CASES");
    var failures: std.ArrayList([]const u8) = .empty;
    var compared: usize = 0;
    for (cases, expected, 0..) |case, want, index| {
        const bin = case.object.get("bin") != null;
        if (only) |kind| if (bin != std.mem.eql(u8, kind, "bin")) continue;
        compared += 1;
        const got = if (bin) try spawn(a, init, links, self, case, index) else try serveInProcess(a, io, case);
        const actual: Outcome = .{ .exit = got.exit, .stdout = try normalize(a, got.stdout), .stderr = try normalize(a, got.stderr) };
        const reference_case: Outcome = .{ .exit = want.exit, .stdout = try normalize(a, want.stdout), .stderr = try normalize(a, want.stderr) };
        if (actual.exit == reference_case.exit and std.mem.eql(u8, actual.stdout, reference_case.stdout) and std.mem.eql(u8, actual.stderr, reference_case.stderr)) continue;
        var description: std.Io.Writer.Allocating = .init(a);
        try std.json.Stringify.value(case, .{}, &description.writer);
        try failures.append(a, try std.fmt.allocPrint(a, "case {d}: {s}\n--- expected (exit {d})\n{s}{s}\n--- actual (exit {d})\n{s}{s}", .{
            index,                 description.written(),
            reference_case.exit,   reference_case.stdout,
            reference_case.stderr, actual.exit,
            actual.stdout,         actual.stderr,
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
