//! Skill sync and MCP registration with coding agents: `skills add`, `skills list`, `mcp add`,
//! and the stale-skills notice.
//!
//! `skills add` writes the generated skill files and the included `SKILL.md` files to a
//! temporary directory, copies each skill to `.agents/skills/<name>` under `HOME` (or the working
//! directory with `--no-global`), and links it into the skills directory of every detected agent
//! that does not read `.agents/skills`. The installed skills, their paths, and a hash of the
//! commands are recorded in `$XDG_DATA_HOME/incur/<name>.json` for listing, cleanup, and the
//! stale-skills notice.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const yaml = @import("yaml.zig");
const errors = @import("errors.zig");
const command = @import("command.zig");
const skill = @import("skill.zig");
const pm = @import("pm.zig");
const update = @import("update.zig");
const cli_ = @import("cli.zig");

const Allocator = std.mem.Allocator;
const Value = json.Value;
const ServeError = command.ServeError;
const Process = cli_.Process;
const Dir = std.Io.Dir;

/// A result or an error message.
pub fn Result(comptime T: type) type {
    return union(enum) { ok: T, err: []const u8 };
}

/// Returns an environment variable unless it is unset or empty.
fn env(process: *const Process, name: []const u8) ?[]const u8 {
    const value = process.env.get(name) orelse return null;
    return if (value.len > 0) value else null;
}

/// Returns the home directory.
fn home(process: *const Process) []const u8 {
    return process.env.get("HOME") orelse "";
}

/// Returns the working directory.
fn currentPath(a: Allocator, io: std.Io) ServeError![]const u8 {
    return try command.optional(std.process.currentPathAlloc(io, a)) orelse ".";
}

/// Whether a path exists, following symlinks.
fn exists(io: std.Io, path: []const u8) ServeError!bool {
    return try command.optional(Dir.cwd().statFile(io, path, .{})) != null;
}

/// Returns the skills metadata file of a CLI.
fn metaPath(a: Allocator, process: *const Process, name: []const u8) ServeError![]const u8 {
    const root = env(process, "XDG_DATA_HOME") orelse try std.fs.path.join(a, &.{ home(process), ".local", "share" });
    return std.fs.path.join(a, &.{ root, "incur", try std.fmt.allocPrint(a, "{s}.json", .{name}) });
}

/// Returns the string items of an array property, or an empty list.
fn stringItems(a: Allocator, value: ?Value) ServeError![]const []const u8 {
    const v = value orelse return &.{};
    if (v != .array) return &.{};
    var out: std.ArrayList([]const u8) = .empty;
    for (v.array) |item| if (item == .string) try out.append(a, item.string);
    return out.items;
}

/// Returns the names of previously synced skills that are still installed: the recorded paths
/// that hold a `SKILL.md`, or for older metadata without paths, the recorded skills found under
/// `~/.agents/skills` or `<cwd>/.agents/skills`.
fn installedSkills(a: Allocator, process: *const Process, name: []const u8) ServeError![]const []const u8 {
    const io = process.io;
    const meta = try update.readJson(a, io, try metaPath(a, process, name)) orelse return &.{};
    const skills = try stringItems(a, meta.get("skills"));
    if (skills.len == 0) return &.{};
    var out: std.ArrayList([]const u8) = .empty;
    const paths = try stringItems(a, meta.get("paths"));
    if (paths.len > 0) {
        for (paths) |path| if (try exists(io, try std.fs.path.join(a, &.{ path, "SKILL.md" }))) try out.append(a, std.fs.path.basename(path));
        return out.items;
    }
    const bases = [_][]const u8{ try std.fs.path.join(a, &.{ home(process), ".agents", "skills" }), try std.fs.path.join(a, &.{ try currentPath(a, io), ".agents", "skills" }) };
    for (skills) |s| for (bases) |base| {
        if (!try exists(io, try std.fs.path.join(a, &.{ base, s, "SKILL.md" }))) continue;
        try out.append(a, s);
        break;
    };
    return out.items;
}

fn contains(items: []const []const u8, item: []const u8) bool {
    for (items) |entry| if (std.mem.eql(u8, entry, item)) return true;
    return false;
}

/// The skill files of a CLI's commands at a depth, with the CLI description as the top-level
/// group description.
fn files(a: Allocator, cli: *cli_.Cli, depth: f64) ServeError![]const skill.File {
    const infos = try cli_.skillInfos(a, cli);
    var groups: std.ArrayList(skill.Group) = .empty;
    if (errors.nonEmpty(cli.options.description)) |d| try groups.append(a, .{ .name = cli.name, .description = d });
    try groups.appendSlice(a, infos.groups);
    const sync = cli.options.sync.?;
    return skill.splitAs(a, cli.name, sync.command orelse cli.name, infos.commands, groups.items, depth);
}

/// A `SKILL.md` an `include` pattern matched.
const Included = struct { name: []const u8, description: ?[]const u8, content: []const u8 };

/// Reads the `SKILL.md` files the `include` patterns match: `<pattern>/SKILL.md` where the last
/// segment of the pattern may be `*`, or `SKILL.md` itself for `_root`. A skill is named after
/// its directory, or for `_root`, after its frontmatter name or the CLI.
fn included(a: Allocator, process: *const Process, cli_name: []const u8, patterns: []const []const u8, cwd: []const u8) ServeError![]const Included {
    const io = process.io;
    var out: std.ArrayList(Included) = .empty;
    for (patterns) |pattern| {
        var matches: std.ArrayList([]const u8) = .empty;
        if (std.mem.eql(u8, pattern, "_root")) {
            try matches.append(a, "SKILL.md");
        } else if (std.mem.endsWith(u8, pattern, "/*") or std.mem.eql(u8, pattern, "*")) {
            const parent = pattern[0 .. pattern.len - @min(pattern.len, 2)];
            var dir = try command.optional(Dir.cwd().openDir(io, try std.fs.path.join(a, &.{ cwd, parent }), .{ .iterate = true })) orelse continue;
            defer dir.close(io);
            var it = dir.iterate();
            while (try command.optional(it.next(io))) |next| {
                const entry = next orelse break;
                if (entry.name[0] == '.') continue;
                try matches.append(a, try std.fs.path.join(a, &.{ parent, try a.dupe(u8, entry.name), "SKILL.md" }));
            }
            std.mem.sort([]const u8, matches.items, {}, lessThan);
        } else try matches.append(a, try std.fs.path.join(a, &.{ pattern, "SKILL.md" }));
        for (matches.items) |match| {
            const content = try readOptional(a, io, try std.fs.path.join(a, &.{ cwd, match })) orelse continue;
            // Unparseable frontmatter skips the file.
            const meta = try command.optional(yaml.parseFrontmatter(a, content)) orelse continue;
            const name = if (std.mem.eql(u8, pattern, "_root")) string(meta, "name") orelse cli_name else std.fs.path.basename(std.fs.path.dirname(match).?);
            try out.append(a, .{ .name = name, .description = string(meta, "description"), .content = content });
        }
    }
    return out.items;
}

fn lessThan(_: void, x: []const u8, y: []const u8) bool {
    return std.mem.order(u8, x, y) == .lt;
}

/// Returns a string property of parsed frontmatter.
fn string(meta: ?Value, key: []const u8) ?[]const u8 {
    const value = (meta orelse return null).get(key) orelse return null;
    return if (value == .string) value.string else null;
}

/// A skill and whether it is installed.
pub const Listed = struct {
    /// The skill name.
    name: []const u8,
    /// The frontmatter description.
    description: ?[]const u8 = null,
    /// Whether a previous `skills add` installed it and it is still on disk.
    installed: bool,
};

fn byName(comptime T: type) fn (void, T, T) bool {
    return struct {
        fn f(_: void, x: T, y: T) bool {
            return js.localeCompare(x.name, y.name) == .lt;
        }
    }.f;
}

/// Lists the skills `skills add` would install, with their install status.
pub fn list(a: Allocator, cli: *cli_.Cli, process: *const Process) ServeError![]const Listed {
    const sync = cli.options.sync.?;
    const root = sync.cwd orelse try packageRoot(a, process);
    const installed = try installedSkills(a, process, cli.name);
    var out: std.ArrayList(Listed) = .empty;
    for (try files(a, cli, sync.depth)) |file| try out.append(a, .{ .name = file.name, .description = file.description, .installed = contains(installed, file.name) });
    for (try included(a, process, cli.name, sync.include, root)) |inc| {
        for (out.items) |item| {
            if (std.mem.eql(u8, item.name, inc.name)) break;
        } else try out.append(a, .{ .name = inc.name, .description = inc.description, .installed = contains(installed, inc.name) });
    }
    std.mem.sort(Listed, out.items, {}, byName(Listed));
    return out.items;
}

/// An installed skill.
pub const Synced = struct {
    /// The skill name.
    name: []const u8,
    /// The frontmatter description.
    description: ?[]const u8 = null,
};

/// Where a skill was linked for an agent.
pub const AgentInstall = struct {
    /// The agent's display name.
    agent: []const u8,
    /// The link path.
    path: []const u8,
    /// How it was installed: `symlink`.
    mode: []const u8,
};

/// The result of `add`.
pub const Added = struct {
    /// The synced skills, sorted by name.
    skills: []const Synced,
    /// The canonical install paths.
    paths: []const []const u8,
    /// The links created for agents that do not read `.agents/skills`.
    agents: []const AgentInstall,
};

/// Generates and installs skills.
pub fn add(a: Allocator, cli: *cli_.Cli, process: *const Process, depth: f64, global: bool) ServeError!Result(Added) {
    const io = process.io;
    const sync = cli.options.sync.?;
    const root = sync.cwd orelse try packageRoot(a, process);
    const cwd = try currentPath(a, io);
    var random: [8]u8 = undefined;
    io.random(&random);
    const tmp = try std.fs.path.join(a, &.{ process.env.get("TMPDIR") orelse "/tmp", try std.fmt.allocPrint(a, "incur-skills-{s}-{x}", .{ cli.name, &random }) });
    defer Dir.cwd().deleteTree(io, tmp) catch {};
    var skills: std.ArrayList(Synced) = .empty;
    for (try files(a, cli, depth)) |file| {
        try writeFile(io, try std.fs.path.join(a, &.{ tmp, file.dir, "SKILL.md" }), try std.fmt.allocPrint(a, "{s}\n", .{file.content})) orelse
            return .{ .err = try std.fmt.allocPrint(a, "Cannot write skills to {s}", .{tmp}) };
        try skills.append(a, .{ .name = file.name, .description = file.description });
    }
    for (try included(a, process, cli.name, sync.include, root)) |inc| {
        try writeFile(io, try std.fs.path.join(a, &.{ tmp, inc.name, "SKILL.md" }), inc.content) orelse continue;
        for (skills.items) |s| {
            if (std.mem.eql(u8, s.name, inc.name)) break;
        } else try skills.append(a, .{ .name = inc.name, .description = inc.description });
    }
    const installed = try install(a, process, tmp, global, cwd);
    var names: std.ArrayList([]const u8) = .empty;
    for (installed.paths) |path| if (!contains(names.items, std.fs.path.basename(path))) try names.append(a, std.fs.path.basename(path));
    const meta_path = try metaPath(a, process, cli.name);
    if (try update.readJson(a, io, meta_path)) |previous| for (try stringItems(a, previous.get("skills"))) |old| {
        if (!contains(names.items, old)) try remove(a, process, old, global, cwd);
    };
    var all: std.ArrayList([]const u8) = .empty;
    try all.appendSlice(a, installed.paths);
    for (installed.agents) |agent| try all.append(a, agent.path);
    var meta: json.ObjectBuilder = .{};
    try meta.put(a, "hash", .{ .string = try skill.hash(a, (try cli_.skillInfos(a, cli)).commands) });
    try meta.put(a, "skills", try strings(a, names.items));
    try meta.put(a, "paths", try strings(a, all.items));
    try meta.put(a, "at", .{ .string = try isoNow(a, io) });
    try writeFile(io, meta_path, try std.fmt.allocPrint(a, "{s}\n", .{try json.stringify(a, meta.finish())})) orelse
        return .{ .err = try std.fmt.allocPrint(a, "Cannot write {s}", .{meta_path}) };
    std.mem.sort(Synced, skills.items, {}, byName(Synced));
    return .{ .ok = .{ .skills = skills.items, .paths = installed.paths, .agents = installed.agents } };
}

fn strings(a: Allocator, items: []const []const u8) ServeError!Value {
    const values = try a.alloc(Value, items.len);
    for (items, values) |item, *slot| slot.* = .{ .string = item };
    return .{ .array = values };
}

/// Writes a file, creating its directory, or returns null when that fails.
fn writeFile(io: std.Io, path: []const u8, data: []const u8) ServeError!?void {
    try command.optional(Dir.cwd().createDirPath(io, std.fs.path.dirname(path).?)) orelse return null;
    return command.optional(Dir.cwd().writeFile(io, .{ .sub_path = path, .data = data }));
}

/// Returns the current time as an ISO 8601 string, as `Date.prototype.toISOString` does.
fn isoNow(a: Allocator, io: std.Io) ServeError![]const u8 {
    const ms: u64 = @intCast(@max(0, @divFloor(std.Io.Clock.real.now(io).nanoseconds, std.time.ns_per_ms)));
    const seconds: std.time.epoch.EpochSeconds = .{ .secs = ms / 1000 };
    const day = seconds.getEpochDay().calculateYearDay();
    const month = day.calculateMonthDay();
    const time = seconds.getDaySeconds();
    return std.fmt.allocPrint(a, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        day.year,               month.month.numeric(),     month.day_index + 1,
        time.getHoursIntoDay(), time.getMinutesIntoHour(), time.getSecondsIntoMinute(),
        ms % 1000,
    });
}

/// Walks up from the program's real directory to the nearest `package.json`, or returns the
/// working directory.
fn packageRoot(a: Allocator, process: *const Process) ServeError![]const u8 {
    const io = process.io;
    if (process.program) |program| if (try pm.realPath(a, io, program)) |real| {
        var dir = std.fs.path.dirname(real).?;
        while (std.fs.path.dirname(dir)) |parent| : (dir = parent) {
            if (try exists(io, try std.fs.path.join(a, &.{ dir, "package.json" }))) return dir;
        }
    };
    return currentPath(a, io);
}

/// A coding agent's skills directories.
const Agent = struct {
    name: []const u8,
    /// The global skills directory.
    global: []const u8,
    /// The project skills directory, relative to the working directory.
    project: []const u8,
    /// Whether the agent reads `.agents/skills`, so needs no link.
    universal: bool,
    /// The path whose existence shows the agent is installed.
    detect: []const u8,
};

/// Returns the agents installed on the system.
fn detectAgents(a: Allocator, process: *const Process) ServeError![]const Agent {
    const h = home(process);
    const config = env(process, "XDG_CONFIG_HOME") orelse try std.fs.path.join(a, &.{ h, ".config" });
    const claude = nonBlank(process.env.get("CLAUDE_CONFIG_DIR")) orelse try std.fs.path.join(a, &.{ h, ".claude" });
    const codex = nonBlank(process.env.get("CODEX_HOME")) orelse try std.fs.path.join(a, &.{ h, ".codex" });
    // Name, base and skills path segments, project directory, universal, and detected path segments.
    const Def = struct { []const u8, []const u8, []const []const u8, []const u8, bool, []const u8, []const []const u8 };
    const defs = [_]Def{
        .{ "Amp", config, &.{ "agents", "skills" }, ".agents/skills", true, config, &.{"amp"} },
        .{ "Cline", h, &.{ ".agents", "skills" }, ".agents/skills", true, h, &.{".cline"} },
        .{ "Codex", codex, &.{"skills"}, ".agents/skills", true, codex, &.{} },
        .{ "Cursor", h, &.{ ".cursor", "skills" }, ".agents/skills", true, h, &.{".cursor"} },
        .{ "Gemini CLI", h, &.{ ".gemini", "skills" }, ".agents/skills", true, h, &.{".gemini"} },
        .{ "GitHub Copilot", h, &.{ ".copilot", "skills" }, ".agents/skills", true, h, &.{".copilot"} },
        .{ "Kimi CLI", config, &.{ "agents", "skills" }, ".agents/skills", true, h, &.{".kimi"} },
        .{ "OpenCode", config, &.{ "opencode", "skills" }, ".agents/skills", true, config, &.{"opencode"} },
        .{ "Claude Code", claude, &.{"skills"}, ".claude/skills", false, claude, &.{} },
        .{ "Windsurf", h, &.{ ".codeium", "windsurf", "skills" }, ".windsurf/skills", false, h, &.{ ".codeium", "windsurf" } },
        .{ "Continue", h, &.{ ".continue", "skills" }, ".continue/skills", false, h, &.{".continue"} },
        .{ "Roo", h, &.{ ".roo", "skills" }, ".roo/skills", false, h, &.{".roo"} },
        .{ "Kilo", h, &.{ ".kilocode", "skills" }, ".kilocode/skills", false, h, &.{".kilocode"} },
        .{ "Goose", config, &.{ "goose", "skills" }, ".goose/skills", false, config, &.{"goose"} },
        .{ "Augment", h, &.{ ".augment", "skills" }, ".augment/skills", false, h, &.{".augment"} },
        .{ "Trae", h, &.{ ".trae", "skills" }, ".trae/skills", false, h, &.{".trae"} },
        .{ "Junie", h, &.{ ".junie", "skills" }, ".junie/skills", false, h, &.{".junie"} },
        .{ "Crush", config, &.{ "crush", "skills" }, ".crush/skills", false, config, &.{"crush"} },
        .{ "Kiro CLI", h, &.{ ".kiro", "skills" }, ".kiro/skills", false, h, &.{".kiro"} },
        .{ "Qwen Code", h, &.{ ".qwen", "skills" }, ".qwen/skills", false, h, &.{".qwen"} },
        .{ "OpenHands", h, &.{ ".openhands", "skills" }, ".openhands/skills", false, h, &.{".openhands"} },
    };
    var out: std.ArrayList(Agent) = .empty;
    for (defs) |d| {
        const detect = try std.fs.path.join(a, try std.mem.concat(a, []const u8, &.{ &.{d[5]}, d[6] }));
        if (!try exists(process.io, detect)) continue;
        try out.append(a, .{
            .name = d[0],
            .global = try std.fs.path.join(a, try std.mem.concat(a, []const u8, &.{ &.{d[1]}, d[2] })),
            .project = d[3],
            .universal = d[4],
            .detect = detect,
        });
    }
    return out.items;
}

/// Returns trimmed text unless it is null or blank.
fn nonBlank(value: ?[]const u8) ?[]const u8 {
    const trimmed = js.trim(value orelse return null);
    return if (trimmed.len > 0) trimmed else null;
}

/// A skill directory in the staging directory.
const Discovered = struct { name: []const u8, dir: []const u8, root: bool = false };

/// Finds the skill directories (those with a `SKILL.md`) under the staging directory, and its
/// own `SKILL.md`, named after their `name:` line or their directory.
fn discover(a: Allocator, io: std.Io, root: []const u8) ServeError![]const Discovered {
    var out: std.ArrayList(Discovered) = .empty;
    try visit(a, io, root, &out);
    const root_skill = try std.fs.path.join(a, &.{ root, "SKILL.md" });
    if (try readOptional(a, io, root_skill)) |content| {
        const name = try sanitize(a, nameLine(content) orelse "skill");
        for (out.items) |d| {
            if (std.mem.eql(u8, d.name, name)) break;
        } else try out.append(a, .{ .name = name, .dir = root, .root = true });
    }
    return out.items;
}

fn visit(a: Allocator, io: std.Io, dir_path: []const u8, out: *std.ArrayList(Discovered)) ServeError!void {
    var dir = try command.optional(Dir.cwd().openDir(io, dir_path, .{ .iterate = true })) orelse return;
    defer dir.close(io);
    var names: std.ArrayList([]const u8) = .empty;
    var it = dir.iterate();
    while (try command.optional(it.next(io))) |next| {
        const entry = next orelse break;
        if (entry.kind == .directory) try names.append(a, try a.dupe(u8, entry.name));
    }
    std.mem.sort([]const u8, names.items, {}, lessThan);
    for (names.items) |name| {
        const sub = try std.fs.path.join(a, &.{ dir_path, name });
        if (try readOptional(a, io, try std.fs.path.join(a, &.{ sub, "SKILL.md" }))) |content|
            try out.append(a, .{ .name = try sanitize(a, nameLine(content) orelse name), .dir = sub });
        try visit(a, io, sub, out);
    }
}

/// Reads a file, or returns null when it cannot be read.
fn readOptional(a: Allocator, io: std.Io, path: []const u8) ServeError!?[]const u8 {
    return command.optional(Dir.cwd().readFileAlloc(io, path, a, .unlimited));
}

/// Returns the text after `name:` at the start of a line and any whitespace, up to the end of
/// its line, as `/^name:\s*(.+)$/m` captures it.
fn nameLine(content: []const u8) ?[]const u8 {
    var start: usize = 0;
    while (start < content.len) {
        const end = std.mem.findAnyPos(u8, content, start, "\r\n") orelse content.len;
        if (std.mem.startsWith(u8, content[start..end], "name:")) {
            const value = std.mem.trimStart(u8, content[start + 5 ..], " \t\r\n");
            const line = value[0 .. std.mem.findAny(u8, value, "\r\n") orelse value.len];
            if (line.len > 0) return line;
        }
        start = end + 1;
    }
    return null;
}

/// Makes a skill name safe as a directory name: trimmed, with `/` and `\` replaced by `-` and
/// `..` removed.
fn sanitize(a: Allocator, name: []const u8) ServeError![]const u8 {
    const dashed = try a.dupe(u8, js.trim(name));
    std.mem.replaceScalar(u8, dashed, '/', '-');
    std.mem.replaceScalar(u8, dashed, '\\', '-');
    return std.mem.replaceOwned(u8, a, dashed, "..", "");
}

/// The result of installing skills.
const Installed = struct { paths: []const []const u8, agents: []const AgentInstall };

/// Copies each staged skill to `.agents/skills` and links it for detected agents.
fn install(a: Allocator, process: *const Process, source: []const u8, global: bool, cwd: []const u8) ServeError!Installed {
    const io = process.io;
    const base = try std.fs.path.join(a, &.{ if (global) home(process) else cwd, ".agents", "skills" });
    const agents = try detectAgents(a, process);
    var paths: std.ArrayList([]const u8) = .empty;
    var links: std.ArrayList(AgentInstall) = .empty;
    for (try discover(a, io, source)) |s| {
        const canonical = try std.fs.path.join(a, &.{ base, s.name });
        _ = try command.optional(Dir.cwd().deleteTree(io, canonical));
        try command.optional(Dir.cwd().createDirPath(io, canonical)) orelse continue;
        try command.optional(Dir.cwd().copyFile(try std.fs.path.join(a, &.{ s.dir, "SKILL.md" }), Dir.cwd(), try std.fs.path.join(a, &.{ canonical, "SKILL.md" }), io, .{})) orelse continue;
        try paths.append(a, canonical);
        for (agents) |agent| {
            if (agent.universal) continue;
            const skills_dir = if (global) agent.global else try std.fs.path.join(a, &.{ cwd, agent.project });
            const link = try std.fs.path.join(a, &.{ skills_dir, s.name });
            // An agent directory that resolves to the canonical one needs no link.
            const target = try resolveParent(a, io, canonical);
            if (std.mem.eql(u8, try resolveParent(a, io, link), target)) continue;
            _ = try command.optional(Dir.cwd().deleteTree(io, link));
            try command.optional(Dir.cwd().createDirPath(io, skills_dir)) orelse continue;
            const relative = try std.fs.path.relativeAlloc(a, "/", null, try resolveParent(a, io, skills_dir), target);
            try command.optional(Dir.cwd().symLink(io, relative, link, .{ .is_directory = true })) orelse continue;
            try links.append(a, .{ .agent = agent.name, .path = link, .mode = "symlink" });
        }
    }
    return .{ .paths = paths.items, .agents = links.items };
}

/// Removes a skill from `.agents/skills` and the skills directories of detected agents.
fn remove(a: Allocator, process: *const Process, name: []const u8, global: bool, cwd: []const u8) ServeError!void {
    const io = process.io;
    _ = try command.optional(Dir.cwd().deleteTree(io, try std.fs.path.join(a, &.{ if (global) home(process) else cwd, ".agents", "skills", name })));
    for (try detectAgents(a, process)) |agent| {
        if (agent.universal) continue;
        const skills_dir = if (global) agent.global else try std.fs.path.join(a, &.{ cwd, agent.project });
        _ = try command.optional(Dir.cwd().deleteTree(io, try std.fs.path.join(a, &.{ skills_dir, name })));
    }
}

/// Resolves a path through symlinks: the path itself, or its parent joined with its name, or the
/// path unchanged.
fn resolveParent(a: Allocator, io: std.Io, path: []const u8) ServeError![]const u8 {
    if (try pm.realPath(a, io, path)) |real| return real;
    const parent = std.fs.path.dirname(path) orelse return path;
    const real = try pm.realPath(a, io, parent) orelse return path;
    return std.fs.path.join(a, &.{ real, std.fs.path.basename(path) });
}

/// The result of `register`.
pub const Registered = struct {
    /// The command agents run.
    command: []const u8,
    /// The agents the server was registered with.
    agents: []const []const u8,
};

/// Registers the CLI as an MCP server: with `add-mcp` through the package runner for every agent
/// but Amp, and in Amp's `settings.json` directly.
pub fn register(a: Allocator, cli: *cli_.Cli, process: *const Process, name: []const u8, command_override: ?[]const u8, global: bool, targets: []const []const u8) ServeError!Result(Registered) {
    const runner = try pm.runner(a, process);
    const cmd = command_override orelse switch (try defaultCommand(a, process, cli.name, runner, cli.options.package, cli.options.version)) {
        .ok => |c| c,
        .err => |message| return .{ .err = message },
    };
    // Amp is registered directly (`add-mcp` does not support it). Its settings are checked first,
    // so invalid settings fail before any agent is configured, and read again when written.
    const amp_path = if (global)
        try std.fs.path.join(a, &.{ home(process), ".config", "amp", "settings.json" })
    else
        try std.fs.path.join(a, &.{ try currentPath(a, process.io), ".amp", "settings.json" });
    const amp = targets.len == 0 or contains(targets, "amp");
    if (amp and try readAmp(a, process.io, amp_path) == null) return .{ .err = try invalidAmp(a, amp_path) };
    var agents: std.ArrayList([]const u8) = .empty;
    const amp_only = targets.len == 1 and std.mem.eql(u8, targets[0], "amp");
    if (!amp_only) {
        var argv: std.ArrayList([]const u8) = .empty;
        try argv.appendSlice(a, &.{ runner, "add-mcp", cmd, "--name", name, "-y" });
        if (global) try argv.append(a, "-g");
        for (targets) |agent| if (!std.mem.eql(u8, agent, "amp")) try argv.appendSlice(a, &.{ "-a", agent });
        const stdout = switch (try pm.exec(a, process, argv.items)) {
            .ok => |out| out,
            .err => |message| return .{ .err = message },
        };
        // Lines such as `│ ✓ Claude Code: ~/.claude.json │` name the configured agents.
        var lines = std.mem.splitScalar(u8, stdout, '\n');
        while (lines.next()) |line| {
            const mark = std.mem.findLast(u8, line, "\u{2713}") orelse std.mem.findLast(u8, line, "\u{2714}") orelse continue;
            var agent: std.ArrayList(u8) = .empty;
            var it: js.Utf8 = .init(line[mark + 3 ..]);
            while (it.next()) |cp| {
                if (cp == ':') break;
                if (cp == 0x2502 or cp == 0x2503 or cp == '|') continue;
                var buffer: [4]u8 = undefined;
                try agent.appendSlice(a, buffer[0 .. std.unicode.utf8Encode(cp, &buffer) catch unreachable]);
            }
            const trimmed = js.trim(agent.items);
            if (trimmed.len > 0) try agents.append(a, trimmed);
        }
    }
    if (amp) {
        const config = try readAmp(a, process.io, amp_path) orelse return .{ .err = try invalidAmp(a, amp_path) };
        if (try registerAmp(a, process.io, amp_path, config, name, cmd)) try agents.append(a, "Amp");
    }
    return .{ .ok = .{ .command = cmd, .agents = agents.items } };
}

/// Reads Amp's settings: an empty object when the file is missing, the JSON object it holds, or
/// null when it holds anything else.
fn readAmp(a: Allocator, io: std.Io, path: []const u8) ServeError!?Value {
    if (!try exists(io, path)) return .{ .object = &.{} };
    const text = try readOptional(a, io, path) orelse return null;
    var message: []const u8 = undefined;
    const config = try command.optional(json.parse(a, text, &message)) orelse return null;
    return if (config == .object) config else null;
}

/// The error for Amp settings that do not hold a JSON object.
fn invalidAmp(a: Allocator, path: []const u8) Allocator.Error![]const u8 {
    return std.fmt.allocPrint(a, "Invalid Amp settings at {s}: expected a JSON object", .{path});
}

/// Adds the server to Amp's settings, keeping the other fields of an existing entry, or returns
/// false when the command is empty.
fn registerAmp(a: Allocator, io: std.Io, path: []const u8, config: Value, name: []const u8, cmd: []const u8) ServeError!bool {
    const tokens = try splitCommand(a, cmd);
    if (tokens.len == 0) return false;
    var servers: json.ObjectBuilder = .{};
    if (config.get("amp.mcpServers")) |existing| if (existing == .object) try servers.entries.appendSlice(a, existing.object);
    var server: json.ObjectBuilder = .{};
    if (servers.finish().get(name)) |existing| if (existing == .object) try server.entries.appendSlice(a, existing.object);
    try server.put(a, "command", .{ .string = tokens[0] });
    try server.put(a, "args", try strings(a, tokens[1..]));
    try servers.put(a, name, server.finish());
    var out: json.ObjectBuilder = .{};
    try out.entries.appendSlice(a, config.object);
    try out.put(a, "amp.mcpServers", servers.finish());
    _ = try writeFile(io, path, try std.fmt.allocPrint(a, "{s}\n", .{try json.stringifyPretty(a, out.finish())}));
    return true;
}

/// Splits a command line on spaces, keeping quoted text together.
fn splitCommand(a: Allocator, input: []const u8) ServeError![]const []const u8 {
    var tokens: std.ArrayList([]const u8) = .empty;
    var current: std.ArrayList(u8) = .empty;
    var quote: ?u8 = null;
    for (input) |ch| {
        if (quote) |q| {
            if (ch == q) quote = null else try current.append(a, ch);
        } else if (ch == '"' or ch == '\'') {
            quote = ch;
        } else if (ch == ' ') {
            if (current.items.len > 0) try tokens.append(a, try current.toOwnedSlice(a));
        } else try current.append(a, ch);
    }
    if (current.items.len > 0) try tokens.append(a, current.items);
    return tokens.items;
}

/// Returns the default MCP command: `<name> --mcp` when the program is expected on `PATH` or the
/// name cannot be run by a package runner, else `<runner> <specifier> --mcp`.
fn defaultCommand(a: Allocator, process: *const Process, name: []const u8, runner: []const u8, package: ?[]const u8, version: ?[]const u8) ServeError!Result([]const u8) {
    const specifier = if (package) |p| switch (try packageSpecifier(a, p, version)) {
        .ok => |s| s,
        .err => |message| return .{ .err = message },
    } else name;
    if (try bareCommand(a, process, name, package) or (package == null and !isPackageName(name)))
        return .{ .ok = try std.fmt.allocPrint(a, "{s} --mcp", .{name}) };
    return .{ .ok = try std.fmt.allocPrint(a, "{s} {s} --mcp", .{ runner, specifier }) };
}

/// Whether the program is expected on `PATH`: a dependency's entry outside `node_modules/.bin`
/// that the project does not depend on, or a program file named after the CLI.
fn bareCommand(a: Allocator, process: *const Process, name: []const u8, package: ?[]const u8) ServeError!bool {
    const bin = process.program orelse return false;
    if (std.mem.findLast(u8, bin, "/node_modules/")) |index| {
        const entry = bin[index + "/node_modules/".len ..];
        if (index > 0 and entry.len > 0)
            return !std.mem.startsWith(u8, entry, ".bin/") and !try dependsOn(a, process.io, bin[0..index], package orelse name);
    }
    const file = std.fs.path.basename(bin);
    for ([_][]const u8{ "", ".cmd", ".ps1" }) |suffix| {
        if (std.mem.eql(u8, file, try std.fmt.allocPrint(a, "{s}{s}", .{ name, suffix }))) return true;
    }
    return false;
}

/// Whether the project at `root` lists the package as a dependency of any kind.
fn dependsOn(a: Allocator, io: std.Io, root: []const u8, name: []const u8) ServeError!bool {
    const metadata = try update.readJson(a, io, try std.fs.path.join(a, &.{ root, "package.json" })) orelse return false;
    for ([_][]const u8{ "dependencies", "devDependencies", "optionalDependencies", "peerDependencies" }) |field| {
        if ((metadata.get(field) orelse continue).get(name) != null) return true;
    }
    return false;
}

/// Whether a name is a safe npm package name, such as `my-cli` or `@scope/my-cli`.
pub fn isPackageName(name: []const u8) bool {
    var rest = name;
    if (std.mem.startsWith(u8, rest, "@")) {
        const slash = std.mem.findScalar(u8, rest, '/') orelse return false;
        if (!safePart(rest[1..slash])) return false;
        rest = rest[slash + 1 ..];
    }
    return safePart(rest);
}

fn safePart(part: []const u8) bool {
    if (part.len == 0 or !(std.ascii.isLower(part[0]) or std.ascii.isDigit(part[0]))) return false;
    for (part) |ch| if (!std.ascii.isLower(ch) and !std.ascii.isDigit(ch) and std.mem.findScalar(u8, "._-", ch) == null) return false;
    return true;
}

/// Returns `package` or `package@version` after validating both.
fn packageSpecifier(a: Allocator, package: []const u8, version: ?[]const u8) ServeError!Result([]const u8) {
    if (!isPackageName(package)) return .{ .err = try std.fmt.allocPrint(a, "Invalid npm package name: {s}", .{package}) };
    const v = version orelse return .{ .ok = package };
    if (!isExactVersion(v)) return .{ .err = try std.fmt.allocPrint(a, "Invalid exact package version: {s}", .{v}) };
    return .{ .ok = try std.fmt.allocPrint(a, "{s}@{s}", .{ package, v }) };
}

/// Whether text is an exact version: `1.2.3` with optional prerelease and build identifiers.
fn isExactVersion(text: []const u8) bool {
    const plus = std.mem.findScalar(u8, text, '+');
    if (plus) |p| if (!identifiers(text[p + 1 ..])) return false;
    const main = text[0 .. plus orelse text.len];
    const dash = std.mem.findScalar(u8, main, '-');
    if (dash) |d| if (!identifiers(main[d + 1 ..])) return false;
    var parts = std.mem.splitScalar(u8, main[0 .. dash orelse main.len], '.');
    for (0..3) |_| {
        const part = parts.next() orelse return false;
        if (part.len == 0) return false;
        for (part) |ch| if (!std.ascii.isDigit(ch)) return false;
    }
    return parts.next() == null;
}

/// Whether text is alphanumeric runs separated by single `.` or `-`.
fn identifiers(text: []const u8) bool {
    var ids = std.mem.splitAny(u8, text, ".-");
    while (ids.next()) |id| {
        if (id.len == 0) return false;
        for (id) |ch| if (!std.ascii.isAlphanumeric(ch)) return false;
    }
    return true;
}

/// Returns the stale-skills suggestion when installed skills were generated from different
/// commands, or null.
pub fn staleNotice(a: Allocator, cli: *cli_.Cli, process: *const Process, display_name: []const u8) ServeError!?errors.FormattedCtaBlock {
    const meta = try update.readJson(a, process.io, try metaPath(a, process, cli.name)) orelse return null;
    const stored = meta.get("hash") orelse return null;
    if (stored != .string or stored.string.len == 0) return null;
    if ((try installedSkills(a, process, cli.name)).len == 0) return null;
    if (std.mem.eql(u8, try skill.hash(a, (try cli_.skillInfos(a, cli)).commands), stored.string)) return null;
    const package = cli.options.package;
    const launched = env(process, "npm_config_user_agent") != null or env(process, "npm_execpath") != null;
    const cmd = cmd: {
        if (launched and (package != null or isPackageName(cli.name))) {
            const specifier = if (package) |p| switch (try packageSpecifier(a, p, cli.options.version)) {
                .ok => |s| s,
                // An invalid package falls back to the display name.
                .err => break :cmd try std.fmt.allocPrint(a, "{s} skills add", .{display_name}),
            } else cli.name;
            break :cmd try std.fmt.allocPrint(a, "{s} {s} skills add", .{ try pm.runner(a, process), specifier });
        }
        break :cmd try std.fmt.allocPrint(a, "{s} skills add", .{display_name});
    };
    return .{
        .description = "Skills are out of date:",
        .commands = try a.dupe(errors.FormattedCta, &.{.{ .command = cmd, .description = "sync outdated skills" }}),
    };
}
