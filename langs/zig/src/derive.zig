//! Schemas derived from plain Zig types, and conversions between typed values and JSON.
//!
//! Field types drive parsing:
//!
//! | Zig type                  | Schema                                  |
//! | ------------------------- | --------------------------------------- |
//! | `[]const u8`              | string                                  |
//! | `bool`                    | boolean                                 |
//! | `i64` and other integers  | integer (a safe integer)                |
//! | `f64`, `f32`              | number                                  |
//! | `enum { a, b }`           | one of the tag names                    |
//! | `[]const T`               | array of `T`                            |
//! | `?T`                      | optional `T`                            |
//! | a struct                  | object with the struct's fields         |
//! | `incur.Value`             | any value                               |
//!
//! A field default makes the field optional in input and appears in help and JSON Schema; a
//! `null` default on an optional field is the same as no default.
//!
//! Per-field metadata lives in a `pub const incur` declaration inside the struct:
//!
//! ```zig
//! const Options = struct {
//!     save_dev: ?bool = null,
//!     retries: f64 = 3,
//!
//!     pub const incur = .{
//!         .rename_all = .camel_case,
//!         .fields = .{
//!             .save_dev = .{ .description = "Save as dev dependency", .alias = 'D' },
//!             .retries = .{ .description = "Retry count", .min = 0, .max = 10 },
//!         },
//!     };
//! };
//! ```
//!
//! Struct options: `rename_all` (`.camel_case`, `.pascal_case`, `.kebab_case`,
//! `.screaming_snake_case`), `fields`, and `omit_null` (skip null optionals when serializing).
//! Field options: `description`, `alias` (one ASCII letter or digit), `min` and `max` (numbers,
//! string lengths, and array item counts), `count` (a number field counting repeated flags),
//! `deprecated`, and `rename`. Unknown names and misplaced options are compile errors.

const std = @import("std");
const json = @import("json.zig");
const schema = @import("schema.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;

/// Returns the schema of `T`, computed at compile time.
pub fn of(comptime T: type) *const Type {
    return &struct {
        const value = typeOf(T);
    }.value;
}

/// Struct-level metadata keys.
const struct_keys = [_][]const u8{ "rename_all", "fields", "omit_null" };

/// Field-level metadata keys.
const field_keys = [_][]const u8{ "description", "alias", "min", "max", "count", "deprecated", "rename" };

/// Returns the `incur` metadata declaration of a struct, or an empty one.
fn metaOf(comptime T: type) type {
    if (!@hasDecl(T, "incur")) return struct {
        const rename_all = null;
        const omit_null = false;
        const field_meta = .{};
    };
    @setEvalBranchQuota(100_000);
    const meta = T.incur;
    const Meta = @TypeOf(meta);
    if (@typeInfo(Meta) != .@"struct") @compileError(@typeName(T) ++ ".incur must be a struct literal such as .{ .fields = .{} }");
    for (@typeInfo(Meta).@"struct".field_names) |key| {
        if (!contains(&struct_keys, key)) @compileError("unknown incur option '" ++ key ++ "' on " ++ @typeName(T) ++ "; expected rename_all, fields, or omit_null");
    }
    const fields = if (@hasField(Meta, "fields")) meta.fields else .{};
    for (@typeInfo(@TypeOf(fields)).@"struct".field_names) |name| {
        if (!@hasField(T, name)) @compileError("incur metadata names unknown field '" ++ name ++ "' of " ++ @typeName(T));
        const field_meta = @field(fields, name);
        for (@typeInfo(@TypeOf(field_meta)).@"struct".field_names) |key| {
            if (!contains(&field_keys, key)) @compileError("unknown incur field option '" ++ key ++ "' on " ++ @typeName(T) ++ "." ++ name ++
                "; expected description, alias, min, max, count, deprecated, or rename");
        }
    }
    return struct {
        const rename_all = if (@hasField(Meta, "rename_all")) meta.rename_all else null;
        const omit_null: bool = if (@hasField(Meta, "omit_null")) meta.omit_null else false;
        const field_meta = fields;
    };
}

/// Whether `list` contains `name`.
fn contains(comptime list: []const []const u8, comptime name: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item, name)) return true;
    return false;
}

/// Returns the metadata of one field, or an empty literal.
fn fieldMeta(comptime T: type, comptime name: []const u8) type {
    const fields = metaOf(T).field_meta;
    const meta = if (@hasField(@TypeOf(fields), name)) @field(fields, name) else .{};
    const Meta = @TypeOf(meta);
    return struct {
        const description: ?[]const u8 = if (@hasField(Meta, "description")) meta.description else null;
        const alias: ?u8 = if (@hasField(Meta, "alias")) aliasOf(T, name, meta.alias) else null;
        const min: ?f64 = if (@hasField(Meta, "min")) meta.min else null;
        const max: ?f64 = if (@hasField(Meta, "max")) meta.max else null;
        const count: bool = if (@hasField(Meta, "count")) meta.count else false;
        const deprecated: bool = if (@hasField(Meta, "deprecated")) meta.deprecated else false;
        const rename: ?[]const u8 = if (@hasField(Meta, "rename")) meta.rename else null;
    };
}

/// Validates an alias.
fn aliasOf(comptime T: type, comptime name: []const u8, comptime alias: anytype) u8 {
    if (@TypeOf(alias) != comptime_int or alias < 0 or alias > 127 or !std.ascii.isAlphanumeric(alias))
        @compileError("incur alias of " ++ @typeName(T) ++ "." ++ name ++ " must be one ASCII letter or digit, such as 'D'");
    return alias;
}

/// Returns the input name of a field.
fn fieldName(comptime T: type, comptime name: []const u8) []const u8 {
    if (fieldMeta(T, name).rename) |rename| return rename;
    const rule = metaOf(T).rename_all;
    if (@TypeOf(rule) == @TypeOf(null)) return name;
    return comptime applyRename(name, rule);
}

/// Applies a `rename_all` rule to a snake_case name.
fn applyRename(comptime name: []const u8, comptime rule: anytype) []const u8 {
    var out: []const u8 = "";
    var upper = false;
    for (name, 0..) |ch, i| switch (rule) {
        .camel_case, .pascal_case => if (ch == '_') {
            upper = true;
        } else {
            out = out ++ .{if (upper or (i == 0 and rule == .pascal_case)) std.ascii.toUpper(ch) else ch};
            upper = false;
        },
        .kebab_case => out = out ++ .{if (ch == '_') '-' else ch},
        .screaming_snake_case => out = out ++ .{std.ascii.toUpper(ch)},
        else => @compileError("unknown incur rename_all '" ++ @tagName(rule) ++ "'; expected camel_case, pascal_case, kebab_case, or screaming_snake_case"),
    };
    return out;
}

/// Whether `T` is a string slice.
fn isString(comptime T: type) bool {
    return T == []const u8 or T == []u8;
}

/// Returns the schema of a type.
fn typeOf(comptime T: type) Type {
    if (T == Value) return .{ .kind = .unknown };
    if (comptime isString(T)) return .{ .kind = .{ .string = .{} } };
    return switch (@typeInfo(T)) {
        .bool => .{ .kind = .boolean },
        .int => .{ .kind = .{ .integer = .{} } },
        .float => .{ .kind = .{ .number = .{} } },
        .@"enum" => |e| .{ .kind = .{ .@"enum" = comptime names: {
            var names: [e.field_names.len][]const u8 = undefined;
            for (e.field_names, 0..) |name, i| names[i] = name;
            const final = names;
            break :names &final;
        } } },
        .optional => |o| optional: {
            var ty = typeOf(o.child);
            ty.optional = true;
            break :optional ty;
        },
        .pointer => |p| if (p.size == .slice) .{ .kind = .{ .array = .{ .items = of(p.child) } } } else unsupported(T),
        .@"struct" => |s| .{ .kind = .{ .object = comptime fields: {
            @setEvalBranchQuota(100_000);
            _ = metaOf(T);
            var fields: [s.field_names.len]schema.Field = undefined;
            for (s.field_names, s.field_types, s.field_attrs, 0..) |name, F, attrs, i| fields[i] = fieldOf(T, name, F, attrs.defaultValue(F));
            const final = fields;
            break :fields &final;
        } } },
        else => unsupported(T),
    };
}

/// Reports an unsupported field type.
fn unsupported(comptime T: type) noreturn {
    @compileError("incur cannot describe " ++ @typeName(T) ++ "; use []const u8, bool, integers, floats, enums, slices, optionals, structs, or incur.Value");
}

/// Returns the schema field of a struct field.
fn fieldOf(comptime T: type, comptime name: []const u8, comptime F: type, comptime default: ?F) schema.Field {
    const M = fieldMeta(T, name);
    var ty = typeOf(F);
    ty.description = M.description;
    ty.deprecated = M.deprecated;
    if (default) |d| if (defaultValue(F, d)) |v| {
        ty.default = v;
    };
    if (M.count) {
        switch (ty.kind) {
            .integer => |b| ty.kind = .{ .number = b },
            .number => {},
            else => @compileError("incur count on " ++ @typeName(T) ++ "." ++ name ++ " needs a number field"),
        }
        ty.count = true;
        if (ty.default == null) ty.default = .{ .number = 0 };
    }
    if (M.min != null or M.max != null) {
        const bounds: schema.Bounds = .{ .min = M.min, .max = M.max };
        switch (ty.kind) {
            .array => |array| ty.kind = .{ .array = .{ .items = array.items, .bounds = bounds } },
            .integer => ty.kind = .{ .integer = bounds },
            .number => ty.kind = .{ .number = bounds },
            .string => ty.kind = .{ .string = bounds },
            else => @compileError("incur min and max on " ++ @typeName(T) ++ "." ++ name ++ " need a number, string, or array field"),
        }
    }
    return .{ .alias = M.alias, .name = fieldName(T, name), .ty = ty };
}

/// Converts a field default to JSON, or null for a `null` default.
fn defaultValue(comptime T: type, comptime value: T) ?Value {
    if (comptime isString(T)) return .{ .string = value };
    return switch (@typeInfo(T)) {
        .bool => .{ .bool = value },
        .int => .{ .number = @floatFromInt(value) },
        .float => .{ .number = @floatCast(value) },
        .@"enum" => .{ .string = @tagName(value) },
        .optional => |o| if (value) |v| defaultValue(o.child, v) else null,
        .pointer => |p| comptime items: {
            var items: [value.len]Value = undefined;
            for (value, 0..) |item, i| items[i] = defaultValue(p.child, item).?;
            const final = items;
            break :items .{ .array = &final };
        },
        else => @compileError("incur cannot use the default of " ++ @typeName(T) ++ " fields"),
    };
}

/// Converts validated JSON input into a typed value. Validation against `of(T)` guarantees the
/// shape, so this only allocates.
pub fn decode(comptime T: type, a: Allocator, value: ?Value) Allocator.Error!T {
    if (T == Value) return value orelse .null;
    if (comptime isString(T)) return value.?.string;
    switch (@typeInfo(T)) {
        .bool => return value.?.bool,
        .int => return @intFromFloat(value.?.number),
        .float => return @floatCast(value.?.number),
        .@"enum" => return std.meta.stringToEnum(T, value.?.string).?,
        .optional => |o| return if (value == null or value.? == .null) null else try decode(o.child, a, value),
        .pointer => |p| {
            const items = value.?.array;
            const out = try a.alloc(p.child, items.len);
            for (items, out) |item, *slot| slot.* = try decode(p.child, a, item);
            return out;
        },
        .@"struct" => |s| {
            var out: T = undefined;
            inline for (s.field_names, s.field_types) |name, F| @field(out, name) = try decode(F, a, value.?.get(fieldName(T, name)));
            return out;
        },
        else => comptime unsupported(T),
    }
}

/// Converts a typed value to JSON: strings, booleans, numbers, enums (as tag names), slices,
/// arrays, tuples, optionals, structs (with their `incur` field names), and `incur.Value`.
pub fn encode(a: Allocator, value: anytype) Allocator.Error!Value {
    const T = @TypeOf(value);
    if (T == Value) return value;
    switch (@typeInfo(T)) {
        .null => return .null,
        .bool => return .{ .bool = value },
        .int, .comptime_int => return Value.fromNumber(@floatFromInt(value)),
        .float, .comptime_float => return Value.fromNumber(@floatCast(value)),
        .@"enum", .enum_literal => return .{ .string = @tagName(value) },
        .optional => return if (value) |v| encode(a, v) else .null,
        .pointer => |p| {
            if (p.size == .one) return encode(a, value.*);
            if (p.child == u8) return .{ .string = value };
            const out = try a.alloc(Value, value.len);
            for (value, out) |item, *slot| slot.* = try encode(a, item);
            return .{ .array = out };
        },
        .array => |arr| {
            if (arr.child == u8) return .{ .string = try a.dupe(u8, &value) };
            const out = try a.alloc(Value, value.len);
            for (value, out) |item, *slot| slot.* = try encode(a, item);
            return .{ .array = out };
        },
        .@"struct" => |s| {
            if (s.is_tuple) {
                const out = try a.alloc(Value, s.field_names.len);
                inline for (s.field_names, 0..) |name, i| out[i] = try encode(a, @field(value, name));
                return .{ .array = out };
            }
            var out: json.ObjectBuilder = .{};
            inline for (s.field_names, s.field_types) |name, F| {
                const field = @field(value, name);
                const skip = comptime metaOf(T).omit_null and @typeInfo(F) == .optional;
                if (!skip or field != null) try out.put(a, fieldName(T, name), try encode(a, field));
            }
            return out.finish();
        },
        else => comptime unsupported(T),
    }
}
