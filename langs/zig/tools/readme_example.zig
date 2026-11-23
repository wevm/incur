//! Extracts the first `zig` code block of a Markdown file: `readme_example <input> <output>`.

const std = @import("std");

pub fn main(init: std.process.Init) !void {
    const a = init.arena.allocator();
    const args = try init.minimal.args.toSlice(a);
    const text = try std.Io.Dir.cwd().readFileAlloc(init.io, args[1], a, .unlimited);
    const open = "```zig\n";
    const start = (std.mem.find(u8, text, open) orelse return error.NoZigExample) + open.len;
    const end = std.mem.findPos(u8, text, start, "```") orelse return error.UnterminatedExample;
    try std.Io.Dir.cwd().writeFile(init.io, .{ .sub_path = args[2], .data = text[start..end] });
}
