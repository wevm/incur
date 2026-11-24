//! Self-updates for `--update` and update notices.
//!
//! Updates resolve through the configured `check` and `install` callbacks, or through the npm
//! package that contains the program: the registry's `latest` dist-tag and a global install with
//! the detected package manager. The latest version is cached under
//! `$XDG_CACHE_HOME/incur/updates/` and refreshed at most once per interval by running the
//! program again, detached, with `--incur-update-check`.

const std = @import("std");
const builtin = @import("builtin");
const js = @import("js.zig");
const json = @import("json.zig");
const http = @import("http.zig");
const command = @import("command.zig");
const pm = @import("pm.zig");
const cli_ = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const ServeError = command.ServeError;
const Process = cli_.Process;

/// The context an update check receives.
pub const Check = struct {
    /// The process: its I/O, environment, and standard streams.
    process: *const Process,
    /// Allocator for the returned version.
    allocator: Allocator,
    /// The CLI name.
    name: []const u8,
    /// The current version.
    current: []const u8,
    /// The registry package, when one is configured or inferred.
    package: ?[]const u8 = null,
    /// The failure slot `fail` writes.
    failure: *command.Failure,

    /// Records an error message and returns `error.Failed`.
    pub fn fail(c: *const Check, message: []const u8) command.Failed {
        return c.failure.fail(.{ .message = message });
    }
};

/// The context an installer receives.
pub const Install = struct {
    /// The process: its I/O, environment, and standard streams.
    process: *const Process,
    /// Allocator.
    allocator: Allocator,
    /// The CLI name.
    name: []const u8,
    /// The current version, when known.
    current: ?[]const u8 = null,
    /// The latest cached version, when known.
    latest: ?[]const u8 = null,
    /// The registry package, when one is configured or inferred.
    package: ?[]const u8 = null,
    /// The failure slot `fail` writes.
    failure: *command.Failure,

    /// Records an error message and returns `error.Failed`.
    pub fn fail(c: *const Install, message: []const u8) command.Failed {
        return c.failure.fail(.{ .message = message });
    }
};

/// Update settings with the CLI version.
pub const Options = struct { update: cli_.Update, version: ?[]const u8 };

/// The default minimum time between checks: one day, in milliseconds.
const default_interval: f64 = 24 * 60 * 60 * 1000;

/// The flag of the detached refresh.
pub const check_flag = "--incur-update-check";

/// A resolved update source.
const Provider = struct {
    check: ?Source,
    install: ?Source,
    /// The package-manager command, shown after a package install.
    command: ?[]const u8,
    current: ?[]const u8,
    deferred: bool,
    /// The cache key and displayed name.
    name: []const u8,
    package: ?[]const u8,
    /// The package-manager invocation.
    invocation: ?[]const []const u8,
};

/// Whether a provider step is the configured callback or the package default.
const Source = enum { custom, package };

/// Resolves the configured callbacks and the package containing the program.
fn provider(a: Allocator, process: *const Process, name: []const u8, options: Options) ServeError!?Provider {
    const u = options.update;
    const executing = try resolvePackage(a, process, name);
    const package_name = u.package orelse if (executing) |e| e.name else null;
    if (package_name) |p| if (!isPackageName(p)) return null;
    const invocation = if (package_name) |p| try pm.globalInstall(a, process, p) else null;
    const check: ?Source = if (u.check != null) .custom else if (package_name != null) .package else null;
    const installer: ?Source = if (u.install != null) .custom else if (invocation != null) .package else null;
    if (check == null and installer == null) return null;
    return .{
        .check = check,
        .install = installer,
        .command = if (invocation != null and u.install == null) try std.mem.join(a, " ", invocation.?) else null,
        .current = options.version orelse if (executing) |e| e.version else null,
        .deferred = u.deferred,
        .name = package_name orelse name,
        .package = package_name,
        .invocation = invocation,
    };
}

/// An npm package.
const Package = struct { name: []const u8, version: []const u8 };

/// Finds the `package.json` above the program that provides the CLI.
fn resolvePackage(a: Allocator, process: *const Process, name: []const u8) ServeError!?Package {
    const program = process.program orelse return null;
    var dir = std.fs.path.dirname(try pm.realPath(a, process.io, program) orelse return null) orelse return null;
    while (true) {
        if (try readJson(a, process.io, try std.fs.path.join(a, &.{ dir, "package.json" }))) |metadata| {
            const pkg_name = metadata.get("name");
            const version = metadata.get("version");
            if (pkg_name != null and pkg_name.? == .string and version != null and version.? == .string and providesCli(metadata, name))
                return .{ .name = pkg_name.?.string, .version = version.?.string };
        }
        dir = std.fs.path.dirname(dir) orelse return null;
    }
}

/// Whether package metadata provides the CLI: by package name, a `bin` entry, or a string `bin`
/// with a matching unscoped name.
fn providesCli(metadata: Value, name: []const u8) bool {
    const pkg_name = metadata.get("name").?.string;
    if (std.mem.eql(u8, pkg_name, name)) return true;
    const bin = metadata.get("bin") orelse return false;
    if (bin == .object) return bin.get(name) != null;
    if (bin != .string) return false;
    const unscoped = pkg_name[if (std.mem.findScalarLast(u8, pkg_name, '/')) |slash| slash + 1 else 0..];
    return std.mem.eql(u8, unscoped, name);
}

/// Reads a JSON file, or returns null when it is missing or invalid.
pub fn readJson(a: Allocator, io: std.Io, path: []const u8) ServeError!?Value {
    const text = try command.optional(std.Io.Dir.cwd().readFileAlloc(io, path, a, .unlimited)) orelse return null;
    var message: []const u8 = undefined;
    return command.optional(json.parse(a, text, &message));
}

/// Whether a package name is safe in an install command.
fn isPackageName(name: []const u8) bool {
    var rest = name;
    if (std.mem.startsWith(u8, rest, "@")) {
        const slash = std.mem.findScalar(u8, rest, '/') orelse return false;
        if (!validPart(rest[1..slash])) return false;
        rest = rest[slash + 1 ..];
    }
    return validPart(rest);
}

fn validPart(part: []const u8) bool {
    if (part.len == 0 or !std.ascii.isAlphanumeric(part[0])) return false;
    for (part) |ch| if (!std.ascii.isAlphanumeric(ch) and std.mem.findScalar(u8, "._~-", ch) == null) return false;
    return true;
}

/// Returns the cache file of a provider.
fn cachePath(a: Allocator, process: *const Process, key: []const u8) ServeError![]const u8 {
    const root = nonEmpty(process.env.get("XDG_CACHE_HOME")) orelse try std.fs.path.join(a, &.{ process.env.get("HOME") orelse "", ".cache" });
    return std.fs.path.join(a, &.{ root, "incur", "updates", try std.fmt.allocPrint(a, "{s}.json", .{try http.encodeComponent(a, key)}) });
}

fn nonEmpty(value: ?[]const u8) ?[]const u8 {
    const v = value orelse return null;
    return if (v.len > 0) v else null;
}

/// Cached update metadata.
const Cache = struct { checked_at: f64, latest: ?[]const u8 };

/// Reads the cache, or returns null when it is missing or malformed.
fn readCache(a: Allocator, io: std.Io, path: []const u8) ServeError!?Cache {
    const value = try readJson(a, io, path) orelse return null;
    const checked_at = (value.get("checkedAt") orelse return null).toFloat() orelse return null;
    const latest = value.get("latest");
    if (latest != null and latest.? != .string) return null;
    return .{ .checked_at = checked_at, .latest = if (latest) |l| l.string else null };
}

/// Writes the cache, creating its directory.
fn writeCache(a: Allocator, io: std.Io, path: []const u8, cache: Cache) !void {
    var out: json.ObjectBuilder = .{};
    try out.put(a, "checkedAt", Value.fromFloat(cache.checked_at));
    if (cache.latest) |l| try out.put(a, "latest", .{ .string = l });
    try std.Io.Dir.cwd().createDirPath(io, std.fs.path.dirname(path).?);
    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = path, .data = try std.fmt.allocPrint(a, "{s}\n", .{try json.stringify(a, out.finish())}) });
}

/// Returns the current time in milliseconds since the epoch.
fn now(io: std.Io) f64 {
    return @floatFromInt(@divFloor(std.Io.Clock.real.now(io).nanoseconds, std.time.ns_per_ms));
}

/// Whether the environment turns update notices off.
fn disabled(env: *const std.process.Environ.Map) bool {
    if (nonEmpty(env.get("NO_UPDATE_NOTIFIER")) != null) return true;
    if (std.mem.eql(u8, env.get("npm_config_update_notifier") orelse "", "false")) return true;
    const ci = nonEmpty(env.get("CI")) orelse return false;
    return !std.mem.eql(u8, ci, "false");
}

/// An available update.
pub const Available = struct { name: []const u8, current: []const u8, latest: []const u8 };

/// Returns the cached available update, or null, and starts a detached refresh when the cache
/// is older than the interval.
pub fn notice(a: Allocator, process: *const Process, name: []const u8, options: Options) ServeError!?Available {
    if (disabled(process.env)) return null;
    const p = try provider(a, process, name, options) orelse return null;
    if (p.check == null) return null;
    const current = p.current orelse return null;
    const file = try cachePath(a, process, p.name);
    const cached = try readCache(a, process.io, file);
    const checked_at = now(process.io);
    const interval = @max(0, options.update.interval orelse default_interval);
    if (cached == null or checked_at - cached.?.checked_at >= interval) try scheduleRefresh(a, process, file, .{ .checked_at = checked_at, .latest = if (cached) |c| c.latest else null });
    const latest = (cached orelse return null).latest orelse return null;
    if (!try isNewer(a, latest, current)) return null;
    return .{ .name = p.name, .current = current, .latest = latest };
}

/// Marks the check in the cache and runs the program again, detached, to refresh it.
fn scheduleRefresh(a: Allocator, process: *const Process, file: []const u8, cache: Cache) ServeError!void {
    const program = process.program orelse return;
    try command.optional(writeCache(a, process.io, file, cache)) orelse return;
    _ = try command.optional(std.process.spawn(process.io, .{
        .argv = &.{ program, check_flag },
        .environ_map = process.env,
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = if (builtin.os.tag == .windows) null else 0,
    }));
}

/// Refreshes the cached latest version.
pub fn refresh(a: Allocator, process: *const Process, name: []const u8, options: Options) anyerror!void {
    const p = try provider(a, process, name, options) orelse return;
    const source = p.check orelse return;
    const current = p.current orelse return;
    const latest = switch (source) {
        .custom => latest: {
            var failure: command.Failure = .{};
            break :latest try options.update.check.?(&.{ .process = process, .allocator = a, .name = name, .current = current, .package = p.package, .failure = &failure });
        },
        .package => try fetchLatest(a, process, p.package.?),
    } orelse return;
    if (try parseVersion(a, latest) == null) return;
    try writeCache(a, process.io, try cachePath(a, process, p.name), .{ .checked_at = now(process.io), .latest = latest });
}

/// Returns the `latest` dist-tag of a package from the npm registry.
fn fetchLatest(a: Allocator, process: *const Process, package: []const u8) anyerror!?[]const u8 {
    const registry = nonEmpty(process.env.get("npm_config_registry")) orelse "https://registry.npmjs.org";
    const base = if (std.mem.endsWith(u8, registry, "/")) registry else try std.fmt.allocPrint(a, "{s}/", .{registry});
    const url = (http.Url.parse(base) orelse return error.FetchFailed).resolve(a, try http.encodeComponent(a, package));
    var headers: http.Headers = .{};
    try headers.set(a, "accept", "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*");
    const response = try http.send(a, process, &.{ .url = try url, .headers = headers });
    if (!response.ok()) return null;
    var message: []const u8 = undefined;
    const metadata = try json.parse(a, response.body, &message);
    const latest = (metadata.get("dist-tags") orelse return null).get("latest") orelse return null;
    return if (latest == .string) latest.string else null;
}

/// The result of an installation.
pub const Installed = struct { name: []const u8, command: ?[]const u8 = null, deferred: bool = false };

/// Installs the latest version.
pub fn install(a: Allocator, process: *const Process, name: []const u8, options: Options) ServeError!union(enum) { ok: Installed, err: []const u8 } {
    const p = try provider(a, process, name, options) orelse return .{ .err = try noInstaller(a, name) };
    const source = p.install orelse return .{ .err = try noInstaller(a, name) };
    const cached = try readCache(a, process.io, try cachePath(a, process, p.name));
    switch (source) {
        .custom => {
            var failure: command.Failure = .{};
            const context: Install = .{ .process = process, .allocator = a, .name = name, .current = p.current, .latest = if (cached) |c| c.latest else null, .package = p.package, .failure = &failure };
            options.update.install.?(&context) catch |err| return .{ .err = (try failure.take(err)).message };
        },
        .package => switch (try pm.exec(a, process, p.invocation.?)) {
            .ok => {},
            .err => |message| return .{ .err = message },
        },
    }
    return .{ .ok = .{ .name = p.name, .command = p.command, .deferred = p.deferred } };
}

fn noInstaller(a: Allocator, name: []const u8) ServeError![]const u8 {
    return std.fmt.allocPrint(a, "No update installer is configured for '{s}'.", .{name});
}

/// A parsed semantic version: numeric parts as digit strings, compared by length and then
/// lexicographically, so any size compares exactly.
const Version = struct { core: [3][]const u8, prerelease: []const Identifier };

/// A prerelease identifier.
const Identifier = union(enum) { number: []const u8, text: []const u8 };

/// Parses a semantic version, or returns null.
fn parseVersion(a: Allocator, text: []const u8) ServeError!?Version {
    const plus = std.mem.findScalar(u8, text, '+');
    if (plus) |p| if (!identifiers(text[p + 1 ..])) return null;
    const main = text[0 .. plus orelse text.len];
    const dash = std.mem.findScalar(u8, main, '-');
    var core: [3][]const u8 = undefined;
    var parts = std.mem.splitScalar(u8, main[0 .. dash orelse main.len], '.');
    for (&core) |*slot| {
        const part = parts.next() orelse return null;
        if (part.len == 0 or !allDigits(part) or (part.len > 1 and part[0] == '0')) return null;
        slot.* = part;
    }
    if (parts.next() != null) return null;
    var prerelease: std.ArrayList(Identifier) = .empty;
    if (dash) |d| {
        if (!identifiers(main[d + 1 ..])) return null;
        var ids = std.mem.splitScalar(u8, main[d + 1 ..], '.');
        while (ids.next()) |id| {
            if (!allDigits(id)) {
                try prerelease.append(a, .{ .text = id });
                continue;
            }
            if (id.len > 1 and id[0] == '0') return null;
            try prerelease.append(a, .{ .number = id });
        }
    }
    return .{ .core = core, .prerelease = prerelease.items };
}

/// Whether text is dot-separated non-empty `[0-9A-Za-z-]` identifiers.
fn identifiers(text: []const u8) bool {
    var ids = std.mem.splitScalar(u8, text, '.');
    while (ids.next()) |id| {
        if (id.len == 0) return false;
        for (id) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '-') return false;
    }
    return true;
}

fn allDigits(text: []const u8) bool {
    for (text) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

fn compareNumbers(x: []const u8, y: []const u8) std.math.Order {
    if (x.len != y.len) return std.math.order(x.len, y.len);
    return std.mem.order(u8, x, y);
}

/// Whether `candidate` is a newer semantic version than `current`.
pub fn isNewer(a: Allocator, candidate: []const u8, current: []const u8) ServeError!bool {
    const c = try parseVersion(a, candidate) orelse return false;
    const v = try parseVersion(a, current) orelse return false;
    for (c.core, v.core) |x, y| switch (compareNumbers(x, y)) {
        .gt => return true,
        .lt => return false,
        .eq => {},
    };
    if (c.prerelease.len == 0) return v.prerelease.len > 0;
    if (v.prerelease.len == 0) return false;
    for (0..@max(c.prerelease.len, v.prerelease.len)) |i| {
        if (i == c.prerelease.len) return false;
        if (i == v.prerelease.len) return true;
        const x = c.prerelease[i];
        const y = v.prerelease[i];
        switch (x) {
            .number => |n| switch (y) {
                .number => |m| switch (compareNumbers(n, m)) {
                    .eq => continue,
                    else => |order| return order == .gt,
                },
                // Numeric identifiers have lower precedence than text.
                .text => return false,
            },
            .text => |t| switch (y) {
                .number => return true,
                .text => |u| switch (std.mem.order(u8, t, u)) {
                    .eq => continue,
                    else => |order| return order == .gt,
                },
            },
        }
    }
    return false;
}
