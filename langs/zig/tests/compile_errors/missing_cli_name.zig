// error: incur.cli needs a name: add .name to missing_cli_name.Ops.incur
const std = @import("std");
const incur = @import("incur");
const Ops = union(enum) { status };
fn main(init: std.process.Init) !void {
    _ = try incur.parse(Ops, init);
}
comptime {
    _ = &main;
}
