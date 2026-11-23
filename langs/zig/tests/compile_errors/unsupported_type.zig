// error: incur cannot describe *u8
const incur = @import("incur");
const Options = struct {
    ptr: *u8,
};
comptime {
    _ = incur.schema(Options);
}
