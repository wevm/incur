//! Converts JSON Schema documents, such as OpenAPI parameters and MCP tool input schemas, to
//! incur schemas, as Zod's `z.fromJSONSchema` does. Each converted node also records the JSON
//! Schema Zod would emit for it, so `--schema`, help, and MCP listings match TypeScript.
//!
//! Supported: `type` (including arrays of types), `enum`, `const`, `anyOf` and `oneOf`, string
//! bounds, `pattern`, and the `date-time`, `date`, and `time` formats, number bounds, object
//! `properties`, `required`, and `additionalProperties`, array `items` and bounds,
//! `description`, `default`, and unrecognized keys, which are kept as metadata. Other formats
//! accept any string, and other keywords are ignored.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const Type = schema.Type;
const Io = schema.Io;

/// The Zod wrapper around a converted node.
const Wrapper = enum { none, optional, default };

/// A converted node: its validation semantics and how Zod builds its JSON Schema.
pub const Schema = struct {
    /// Validation semantics, without `json`.
    ty: Type,
    /// The outermost Zod wrapper.
    wrapper: Wrapper = .none,
    /// The wrapped node.
    inner: ?*const Schema = null,
    /// The keys this node adds to its JSON Schema, for output and input. A wrapper's keys come
    /// before the wrapped node's, and win.
    layer: [2][]const Value.Entry,
    /// The description Zod reports for this exact node.
    description: ?[]const u8 = null,

    /// Returns the incur schema, with the JSON Schema Zod emits.
    pub fn toType(s: *const Schema, a: Allocator) Allocator.Error!Type {
        var ty = s.ty;
        const emitted = try a.create(schema.Emitted);
        emitted.* = .{ .output = try s.emit(a, .output), .input = try s.emit(a, .input) };
        ty.json = emitted;
        return ty;
    }

    fn emit(s: *const Schema, a: Allocator, io: Io) Allocator.Error!Value {
        var out: json.ObjectBuilder = .{};
        try out.entries.appendSlice(a, s.layer[@backingInt(io)]);
        if (s.inner) |inner| for ((try inner.emit(a, io)).object) |entry| {
            if (out.finish().get(entry.key) == null) try out.entries.append(a, entry);
        };
        return out.finish();
    }

    /// Returns the node made optional, as `.optional()` does.
    pub fn optional(s: *const Schema, a: Allocator) Allocator.Error!Schema {
        var ty = s.ty;
        ty.optional = true;
        ty.optional_outer = ty.default != null;
        return .{ .ty = ty, .wrapper = .optional, .inner = try dupe(a, s), .layer = .{ &.{}, &.{} } };
    }

    /// Returns the node with a description, as `.describe()` does.
    pub fn describe(s: *const Schema, a: Allocator, description: []const u8) Allocator.Error!Schema {
        var out = s.*;
        out.ty.description = description;
        out.description = description;
        for (&out.layer) |*layer| layer.* = try put(a, layer.*, "description", .{ .string = description });
        return out;
    }

    /// Converts numbers and booleans, plain or optional, to coercing schemas, as incur's
    /// `coerceIfNeeded` does for values that arrive as strings. A union with a number or boolean
    /// option becomes a coerced number or boolean.
    pub fn coerceIfNeeded(s: *const Schema, a: Allocator) Allocator.Error!Schema {
        const is_optional = s.wrapper == .optional;
        const inner = if (is_optional) s.inner.? else s;
        const target: ?schema.Kind = if (inner.wrapper != .none) null else switch (inner.ty.kind) {
            .integer, .number => .{ .number = .{} },
            .boolean => .boolean,
            .@"union" => |options| target: {
                for (options) |o| if (plain(&o) and (o.kind == .number or o.kind == .integer)) break :target .{ .number = .{} };
                for (options) |o| if (plain(&o) and o.kind == .boolean) break :target .boolean;
                break :target null;
            },
            else => null,
        };
        const kind = target orelse return s.*;
        var out = try base(a, .{ .kind = kind, .coerce = true });
        if (is_optional) out = try out.optional(a);
        return if (s.description orelse inner.description) |d| out.describe(a, d) else out;
    }
};

/// Whether a union option is a plain number or boolean, without a default or optional wrapper.
fn plain(ty: *const Type) bool {
    return ty.default == null and !ty.optional;
}

fn dupe(a: Allocator, s: *const Schema) Allocator.Error!*const Schema {
    const out = try a.create(Schema);
    out.* = s.*;
    return out;
}

/// Sets a key in an entry list, in place when present.
fn put(a: Allocator, entries: []const Value.Entry, key: []const u8, value: Value) Allocator.Error![]const Value.Entry {
    var out: json.ObjectBuilder = .{};
    try out.entries.appendSlice(a, entries);
    try out.put(a, key, value);
    return out.entries.items;
}

/// Returns a node without wrappers whose JSON Schema is the derived one.
fn base(a: Allocator, ty: Type) Allocator.Error!Schema {
    var layer: [2][]const Value.Entry = undefined;
    for (&layer, [_]Io{ .output, .input }) |*slot, io| {
        slot.* = (try schema.jsonSchemaIo(a, &ty, io)).object;
    }
    return .{ .ty = ty, .layer = layer };
}

/// Keys the conversion handles, which are not kept as metadata.
const recognized = [_][]const u8{
    "$schema",           "$ref",             "$defs",                "definitions",       "$id",                   "id",               "$comment",      "$anchor",     "$vocabulary",
    "$dynamicRef",       "$dynamicAnchor",   "type",                 "enum",              "const",                 "anyOf",            "oneOf",         "allOf",       "not",
    "properties",        "required",         "additionalProperties", "patternProperties", "propertyNames",         "minProperties",    "maxProperties", "items",       "prefixItems",
    "additionalItems",   "minItems",         "maxItems",             "uniqueItems",       "contains",              "minContains",      "maxContains",   "minLength",   "maxLength",
    "pattern",           "format",           "minimum",              "maximum",           "exclusiveMinimum",      "exclusiveMaximum", "multipleOf",    "description", "default",
    "contentEncoding",   "contentMediaType", "contentSchema",        "unevaluatedItems",  "unevaluatedProperties", "if",               "then",          "else",        "dependentSchemas",
    "dependentRequired", "nullable",         "readOnly",
};

/// Keywords kept as metadata although the conversion recognizes them.
const kept = [_][]const u8{ "$id", "id", "$comment", "$anchor", "$vocabulary", "$dynamicRef", "$dynamicAnchor", "contentEncoding", "contentMediaType", "contentSchema" };

fn contains(list: []const []const u8, key: []const u8) bool {
    for (list) |item| if (std.mem.eql(u8, item, key)) return true;
    return false;
}

/// The regular expression of Zod's ISO date.
const date_source = "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";

/// The regular expression of Zod's ISO time.
const time_source = "(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?";

/// The string formats this port checks.
const formats = [_]struct { []const u8, schema.Format }{
    .{ "date-time", .{ .name = "datetime", .json_name = "date-time", .pattern = "^" ++ date_source ++ "T(?:" ++ time_source ++ "(?:Z))$", .message = "Invalid ISO datetime" } },
    .{ "date", .{ .name = "date", .json_name = "date", .pattern = "^" ++ date_source ++ "$", .message = "Invalid ISO date" } },
    .{ "time", .{ .name = "time", .json_name = null, .pattern = "^" ++ time_source ++ "$", .message = "Invalid ISO time" } },
};

/// Converts a JSON Schema to a node, as `z.fromJSONSchema` does.
pub fn convert(a: Allocator, value: Value) Allocator.Error!Schema {
    // `true` and other non-object schemas accept anything.
    if (value != .object) return base(a, .{ .kind = .unknown });
    var s = try convertBase(a, value);
    for ([_][]const u8{ "anyOf", "oneOf" }) |key| if (value.get(key)) |options| if (options == .array) {
        s = try unionOf(a, options.array);
    };
    var meta: std.ArrayList(Value.Entry) = .empty;
    for (value.object) |entry| {
        if (!contains(&recognized, entry.key) or contains(&kept, entry.key)) try meta.append(a, entry);
    }
    if (meta.items.len == 0) return s;
    for (meta.items) |m| if (std.mem.eql(u8, m.key, "deprecated") and m.value == .bool) {
        s.ty.deprecated = m.value.bool;
    };
    for (&s.layer) |*layer| {
        for (meta.items) |m| layer.* = try put(a, layer.*, m.key, m.value);
    }
    return s;
}

fn unionOf(a: Allocator, options: []const Value) Allocator.Error!Schema {
    const types = try a.alloc(Type, options.len);
    for (options, types) |option, *slot| slot.* = try (try convert(a, option)).toType(a);
    return base(a, .{ .kind = .{ .@"union" = types } });
}

fn number(value: ?Value) ?f64 {
    const v = value orelse return null;
    return v.toFloat();
}

fn convertBase(a: Allocator, value: Value) Allocator.Error!Schema {
    var s = try convertType(a, value);
    // Enums, constants, and type lists return before Zod applies the description and default.
    const t = value.get("type");
    if (value.get("enum") != null or value.get("const") != null or (t != null and t.? == .array)) return s;
    if (value.get("description")) |d| if (d == .string and d.string.len > 0) {
        s = try s.describe(a, d.string);
    };
    if (value.get("default")) |d| {
        var ty = s.ty;
        ty.default = d;
        const layer: []const Value.Entry = try a.dupe(Value.Entry, &.{.{ .key = "default", .value = d }});
        s = .{ .ty = ty, .wrapper = .default, .inner = try dupe(a, &s), .layer = .{ layer, layer } };
    }
    return s;
}

fn convertType(a: Allocator, value: Value) Allocator.Error!Schema {
    if (value.get("enum")) |e| if (e == .array) {
        const values = e.array;
        if (values.len == 1) return base(a, .{ .kind = .{ .literal = values[0] } });
        var all_strings = values.len > 0;
        for (values) |v| all_strings = all_strings and v == .string;
        if (all_strings) {
            const names = try a.alloc([]const u8, values.len);
            for (values, names) |v, *slot| slot.* = v.string;
            return base(a, .{ .kind = .{ .@"enum" = names } });
        }
        const types = try a.alloc(Type, values.len);
        for (values, types) |v, *slot| slot.* = try (try base(a, .{ .kind = .{ .literal = v } })).toType(a);
        return base(a, .{ .kind = .{ .@"union" = types } });
    };
    if (value.get("const")) |c| return base(a, .{ .kind = .{ .literal = c } });
    const t = value.get("type") orelse return base(a, .{ .kind = .unknown });
    if (t == .array) {
        if (t.array.len == 1) return convertBase(a, try withType(a, value, t.array[0]));
        const types = try a.alloc(Type, t.array.len);
        for (t.array, types) |item, *slot| slot.* = try (try convertBase(a, try withType(a, value, item))).toType(a);
        return base(a, .{ .kind = .{ .@"union" = types } });
    }
    const name = if (t == .string) t.string else "";
    if (std.mem.eql(u8, name, "string")) {
        var kind: schema.StringKind = .{ .min = number(value.get("minLength")), .max = number(value.get("maxLength")) };
        if (value.get("format")) |f| if (f == .string) for (formats) |entry| {
            if (std.mem.eql(u8, entry[0], f.string)) kind.format = entry[1];
        };
        if (value.get("pattern")) |p| if (p == .string) {
            kind.patterns = try a.dupe([]const u8, &.{p.string});
        };
        return base(a, .{ .kind = .{ .string = kind } });
    }
    if (std.mem.eql(u8, name, "integer") or std.mem.eql(u8, name, "number")) {
        const bounds: schema.Bounds = .{ .min = number(value.get("minimum")), .max = number(value.get("maximum")) };
        return base(a, .{ .kind = if (name[0] == 'i') .{ .integer = bounds } else .{ .number = bounds } });
    }
    if (std.mem.eql(u8, name, "boolean")) return base(a, .{ .kind = .boolean });
    if (std.mem.eql(u8, name, "null")) return base(a, .{ .kind = .null });
    if (std.mem.eql(u8, name, "object")) {
        var fields: std.ArrayList(schema.Field) = .empty;
        const required = if (value.get("required")) |r| (if (r == .array) r.array else &.{}) else &.{};
        if (value.get("properties")) |props| if (props == .object) for (props.object) |entry| {
            var field = try convert(a, entry.value);
            var listed = false;
            for (required) |r| listed = listed or (r == .string and std.mem.eql(u8, r.string, entry.key));
            if (!listed) field = try field.optional(a);
            try fields.append(a, .{ .name = entry.key, .ty = try field.toType(a) });
        };
        const additional = value.get("additionalProperties");
        const strict = additional != null and additional.? == .bool and !additional.?.bool;
        var s = try base(a, .{ .kind = .{ .object = fields.items }, .passthrough = !strict });
        // A strict object rejects unknown keys on both sides; another schema describes them.
        if (strict) s.layer[1] = try put(a, s.layer[1], "additionalProperties", .{ .bool = false });
        if (additional) |extra| if (extra == .object) for (&s.layer, [_]Io{ .output, .input }) |*layer, io| {
            const converted = try (try convert(a, extra)).toType(a);
            layer.* = try put(a, layer.*, "additionalProperties", try schema.jsonSchemaIo(a, &converted, io));
        };
        return s;
    }
    if (std.mem.eql(u8, name, "array")) {
        const items = try a.create(Type);
        items.* = if (value.get("items")) |i| try (try convert(a, i)).toType(a) else .{ .kind = .unknown };
        const bounds: schema.Bounds = .{ .min = number(value.get("minItems")), .max = number(value.get("maxItems")) };
        return base(a, .{ .kind = .{ .array = .{ .items = items, .bounds = bounds } } });
    }
    return base(a, .{ .kind = .unknown });
}

/// Returns a schema with `type` replaced.
fn withType(a: Allocator, value: Value, t: Value) Allocator.Error!Value {
    return .{ .object = try put(a, value.object, "type", t) };
}
