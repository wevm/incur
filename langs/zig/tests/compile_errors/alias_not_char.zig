// error: incur alias of alias_not_char.Options.force must be one ASCII letter or digit
const incur = @import("incur");
const Options = struct {
    force: ?bool = null,
    pub const incur = .{ .fields = .{ .force = .{ .alias = "f" } } };
};
comptime {
    _ = incur.schema(Options);
}
