// error: incur option 'hint' describes a command, but group_command_option.Ops is a command group
const std = @import("std");
const incur = @import("incur");
const Ops = union(enum) {
    status,
    pub const incur = .{ .name = "ops", .hint = "Groups take no hint" };
};
fn main(init: std.process.Init) !void {
    _ = try incur.parse(Ops, init);
}
comptime {
    _ = &main;
}
