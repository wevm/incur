// error: unknown incur option 'rename' on unknown_struct_option.Options
const incur = @import("incur");
const Options = struct {
    name: ?[]const u8 = null,
    pub const incur = .{ .rename = .camel_case };
};
comptime {
    _ = incur.schema(Options);
}
