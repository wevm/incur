//! Turns the README's examples into a program that checks them: `readme_example <input> <output>`.
//!
//! Every `zig` code block with a `pub fn main` becomes an example. The `sh` blocks after it, up
//! to the next example, list invocations: a `$ <program> <args>` line followed by its expected
//! standard output, one `# → ` line per output line. The generated program runs each invocation
//! as a child process that serves the example, and fails on any difference.

const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    const text = try std.Io.Dir.cwd().readFileAlloc(init.io, args[1], a, .unlimited);

    var examples: std.ArrayList([]const u8) = .empty;
    var cases: std.ArrayList(u8) = .empty;
    var lines = std.mem.splitScalar(u8, text, '\n');
    var fence: ?[]const u8 = null;
    var block: std.ArrayList(u8) = .empty;
    var case_open = false;
    while (lines.next()) |line| {
        if (fence) |kind| {
            if (!std.mem.eql(u8, line, "```")) {
                if (std.mem.eql(u8, kind, "zig")) {
                    try block.appendSlice(a, line);
                    try block.append(a, '\n');
                } else if (std.mem.eql(u8, kind, "sh") and examples.items.len > 0) {
                    if (std.mem.startsWith(u8, line, "$ ")) {
                        if (case_open) try cases.appendSlice(a, "\" },\n");
                        try cases.print(a, "    .{{ .example = {d}, .argv = &.{{", .{examples.items.len - 1});
                        var words = std.mem.tokenizeScalar(u8, line[2..], ' ');
                        _ = words.next();
                        while (words.next()) |word| try cases.print(a, " \"{f}\",", .{std.zig.fmtString(word)});
                        try cases.appendSlice(a, " }, .stdout = \"");
                        case_open = true;
                    } else if (std.mem.startsWith(u8, line, "# →") and case_open) {
                        const output = std.mem.trimStart(u8, line["# →".len..], " ");
                        try cases.print(a, "{f}\\n", .{std.zig.fmtString(output)});
                    }
                }
                continue;
            }
            if (std.mem.eql(u8, kind, "zig") and std.mem.find(u8, block.items, "pub fn main(") != null)
                try examples.append(a, try a.dupe(u8, block.items));
            block.clearRetainingCapacity();
            fence = null;
            continue;
        }
        if (std.mem.startsWith(u8, line, "```")) {
            fence = line[3..];
            if (case_open) try cases.appendSlice(a, "\" },\n");
            case_open = false;
        }
    }
    if (examples.items.len == 0) return error.NoZigExample;

    var out: std.ArrayList(u8) = .empty;
    for (examples.items, 0..) |example, i| try out.print(a, "const example_{d} = struct {{\n{s}}};\n\n", .{ i, example });
    try out.appendSlice(a, "const examples = .{");
    for (0..examples.items.len) |i| try out.print(a, " example_{d},", .{i});
    try out.appendSlice(a, " };\n\n");
    try out.print(a, "const cases = [_]Case{{\n{s}}};\n\n", .{cases.items});
    try out.appendSlice(a, runner);
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = args[2], .data = out.items });
}

/// The checking program that follows the examples.
const runner =
    \\const Case = struct { example: usize, argv: []const []const u8, stdout: []const u8 };
    \\
    \\/// With `INCUR_README_EXAMPLE` set, serves that example; otherwise runs every case.
    \\pub fn main(init: @import("std").process.Init) !void {
    \\    const std = @import("std");
    \\    if (init.environ_map.get("INCUR_README_EXAMPLE")) |index| {
    \\        const n = try std.fmt.parseInt(usize, index, 10);
    \\        inline for (examples, 0..) |example, i| if (i == n) return example.main(init);
    \\        return error.UnknownExample;
    \\    }
    \\    const a = init.arena.allocator();
    \\    const self = try std.process.executablePathAlloc(init.io, a);
    \\    var failed = false;
    \\    for (cases) |case| {
    \\        var env: std.process.Environ.Map = .init(a);
    \\        try env.put("INCUR_README_EXAMPLE", try std.fmt.allocPrint(a, "{d}", .{case.example}));
    \\        try env.put("HOME", "/nonexistent");
    \\        const argv = try std.mem.concat(a, []const u8, &.{ &.{self}, case.argv });
    \\        const result = try std.process.run(a, init.io, .{ .argv = argv, .environ_map = &env });
    \\        if (result.term.success() and std.mem.eql(u8, result.stdout, case.stdout)) continue;
    \\        failed = true;
    \\        std.debug.print("README example {d} with {s}:\n--- expected\n{s}--- actual\n{s}{s}\n", .{ case.example, try std.mem.join(a, " ", case.argv), case.stdout, result.stdout, result.stderr });
    \\    }
    \\    if (failed) return error.ReadmeExampleMismatch;
    \\    std.debug.print("readme: {d} invocations of {d} examples match\n", .{ cases.len, examples.len });
    \\}
    \\
;
