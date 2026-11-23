// error: incur count on count_on_string.Options.verbose needs a number field
const incur = @import("incur");
const Options = struct {
    verbose: []const u8 = "",
    pub const incur = .{ .fields = .{ .verbose = .{ .count = true } } };
};
comptime {
    _ = incur.schema(Options);
}
