// error: incur metadata names unknown field 'nope' of unknown_field.Options
const incur = @import("incur");
const Options = struct {
    name: ?[]const u8 = null,
    pub const incur = .{ .fields = .{ .nope = .{ .description = "x" } } };
};
comptime {
    _ = incur.schema(Options);
}
