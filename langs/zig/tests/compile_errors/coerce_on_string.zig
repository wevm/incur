// error: incur coerce on coerce_on_string.Options.name needs a number or boolean field
const incur = @import("incur");
const Options = struct {
    name: []const u8 = "",
    pub const incur = .{ .fields = .{ .name = .{ .coerce = true } } };
};
comptime {
    _ = incur.schema(Options);
}
