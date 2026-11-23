// error: incur min and max on min_on_bool.Options.loud need a number, string, or array field
const incur = @import("incur");
const Options = struct {
    loud: bool = false,
    pub const incur = .{ .fields = .{ .loud = .{ .min = 1 } } };
};
comptime {
    _ = incur.schema(Options);
}
