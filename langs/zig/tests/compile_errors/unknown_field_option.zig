// error: unknown incur field option 'shortcut' on unknown_field_option.Options.name
const incur = @import("incur");
const Options = struct {
    name: ?[]const u8 = null,
    pub const incur = .{ .fields = .{ .name = .{ .shortcut = 'n' } } };
};
comptime {
    _ = incur.schema(Options);
}
