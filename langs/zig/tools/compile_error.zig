//! Checks that a fixture fails to compile with the error its first line names:
//! `compile_error <zig> <fixture> <incur root>`, where the fixture starts with
//! `// error: <expected text>`.

const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    const zig, const fixture, const root = .{ args[1], args[2], args[3] };
    const source = try std.Io.Dir.cwd().readFileAlloc(init.io, fixture, a, .unlimited);
    const prefix = "// error: ";
    if (!std.mem.startsWith(u8, source, prefix)) return error.MissingExpectedError;
    const expected = source[prefix.len..std.mem.findScalar(u8, source, '\n').?];
    const result = try std.process.run(a, init.io, .{ .argv = &.{
        zig,                                                 "build-obj",                                       "-fno-emit-bin", "--dep", "incur",
        try std.mem.concat(a, u8, &.{ "-Mroot=", fixture }), try std.mem.concat(a, u8, &.{ "-Mincur=", root }),
    } });
    if (result.term.success()) {
        std.debug.print("{s} compiled, but should fail with: {s}\n", .{ fixture, expected });
        return error.UnexpectedSuccess;
    }
    if (std.mem.find(u8, result.stderr, expected) == null) {
        std.debug.print("{s} failed without the expected error\nexpected: {s}\nstderr:\n{s}\n", .{ fixture, expected, result.stderr });
        return error.WrongError;
    }
}
