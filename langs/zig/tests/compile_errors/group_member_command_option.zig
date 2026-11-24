// error: incur option 'middleware' on group_member_command_option.Ops.db describes a command, but group_member_command_option.Db is a command group
const std = @import("std");
const incur = @import("incur");
fn trace(c: *incur.MiddlewareContext, next: incur.Next) !void {
    try next.run(c);
}
const Db = union(enum) { migrate };
const Ops = union(enum) {
    db: Db,
    pub const incur = .{ .name = "ops", .fields = .{ .db = .{ .middleware = &.{trace} } } };
};
fn main(init: std.process.Init) !void {
    _ = try incur.parse(Ops, init);
}
comptime {
    _ = &main;
}
