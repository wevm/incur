// error: unknown incur rename_all 'snake_case'
const incur = @import("incur");
const Options = struct {
    dry_run: ?bool = null,
    pub const incur = .{ .rename_all = .snake_case };
};
comptime {
    _ = incur.schema(Options);
}
