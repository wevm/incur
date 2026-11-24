// error: incur field arg_and_env.Deploy.token cannot be both arg and env
const std = @import("std");
const incur = @import("incur");
const Deploy = struct {
    token: []const u8,
    pub const incur = .{ .name = "deploy", .fields = .{ .token = .{ .arg = true, .env = true } } };
};
fn main(init: std.process.Init) !void {
    _ = try incur.parse(Deploy, init);
}
comptime {
    _ = &main;
}
