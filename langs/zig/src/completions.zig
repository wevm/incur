//! Dynamic shell completions for bash, fish, nushell, and zsh.

const std = @import("std");
const js = @import("js.zig");
const json = @import("json.zig");
const schema = @import("schema.zig");

const Allocator = std.mem.Allocator;
const Type = schema.Type;
const Field = schema.Field;

/// A supported shell.
pub const Shell = enum {
    /// Bash.
    bash,
    /// Fish.
    fish,
    /// Nushell.
    nushell,
    /// Zsh.
    zsh,
};

/// A completion candidate.
pub const Candidate = struct {
    /// Description shown beside the value.
    description: ?[]const u8 = null,
    /// Whether the shell must not append a space, as for command groups.
    no_space: bool = false,
    /// The completion value.
    value: []const u8,
};

/// A command tree node that completions walk.
pub const Node = struct {
    /// Subcommands, or null for a command.
    commands: ?[]const Child = null,
    /// Description.
    description: ?[]const u8 = null,
    /// Options of the command this node runs.
    options: ?*const Type = null,

    /// A named subcommand.
    pub const Child = struct {
        /// The name.
        name: []const u8,
        /// The node.
        node: Node,
        /// Whether the name is an alias, which completions do not list.
        alias: bool,
    };
};

/// Generates the shell hook that calls back into the binary at every tab press.
pub fn register(a: Allocator, shell: Shell, name: []const u8) Allocator.Error![]const u8 {
    const id = try a.dupe(u8, name);
    for (id) |*ch| if (!std.ascii.isAlphanumeric(ch.*) and ch.* != '_') {
        ch.* = '_';
    };
    return switch (shell) {
        .bash => std.fmt.allocPrint(a,
            \\_incur_complete_{[id]s}() {{
            \\    local IFS=$'\013'
            \\    local _COMPLETE_INDEX=${{COMP_CWORD}}
            \\    local _completions
            \\    _completions=( $(
            \\        export COMPLETE="bash"
            \\        export _COMPLETE_INDEX="$_COMPLETE_INDEX"
            \\        "{[name]s}" -- "${{COMP_WORDS[@]}}"
            \\    ) )
            \\    if [[ $? != 0 ]]; then
            \\        unset COMPREPLY
            \\        return
            \\    fi
            \\    local _nospace=false
            \\    COMPREPLY=()
            \\    for _c in "${{_completions[@]}}"; do
            \\        if [[ "$_c" == *$'\001' ]]; then
            \\            _nospace=true
            \\            COMPREPLY+=("${{_c%$'\001'}}")
            \\        else
            \\            COMPREPLY+=("$_c")
            \\        fi
            \\    done
            \\    if [[ $_nospace == true ]]; then
            \\        compopt -o nospace
            \\    fi
            \\}}
            \\complete -o default -o bashdefault -o nosort -F _incur_complete_{[id]s} {[name]s}
        , .{ .id = id, .name = name }),
        .zsh => std.fmt.allocPrint(a,
            \\#compdef {[name]s}
            \\_incur_complete_{[id]s}() {{
            \\    local completions=("${{(@f)$(
            \\        export _COMPLETE_INDEX=$(( CURRENT - 1 ))
            \\        export COMPLETE="zsh"
            \\        "{[name]s}" -- "${{words[@]}}" 2>/dev/null
            \\    )}}")
            \\    if [[ -n $completions ]]; then
            \\        _describe 'values' completions -S ''
            \\    fi
            \\}}
            \\compdef _incur_complete_{[id]s} {[name]s}
        , .{ .id = id, .name = name }),
        .fish => std.fmt.allocPrint(a,
            \\complete --keep-order --exclusive --command {[name]s} \
            \\    --arguments "(COMPLETE=fish {[name]s} -- (commandline --current-process --tokenize --cut-at-cursor) (commandline --current-token))"
        , .{ .name = name }),
        .nushell => std.fmt.allocPrint(a,
            \\# External completer for {[name]s}
            \\# Add to $env.config.completions.external.completer or use in a dispatch completer.
            \\let _incur_complete_{[id]s} = {{|spans|
            \\    COMPLETE=nushell {[name]s} -- ...$spans | from json
            \\}}
        , .{ .id = id, .name = name }),
    };
}

/// Resolves a flag token to its option field.
fn optionField(a: Allocator, token: []const u8, options: *const Type) Allocator.Error!?*const Field {
    const fields = options.fields();
    if (std.mem.startsWith(u8, token, "--")) {
        const raw = token[2..];
        for (fields) |*f| if (std.mem.eql(u8, try js.toKebab(a, f.name), raw)) return f;
        for (fields) |*f| if (std.mem.eql(u8, f.name, raw)) return f;
        return null;
    }
    if (token.len == 2 and token[0] == '-') {
        for (fields) |*f| if (f.alias == token[1]) return f;
    }
    return null;
}

/// Whether a candidate with this value exists.
fn listed(candidates: []const Candidate, value: []const u8) bool {
    for (candidates) |c| if (std.mem.eql(u8, c.value, value)) return true;
    return false;
}

/// Suggests the option flags of a schema that match the current word.
fn flags(a: Allocator, candidates: *std.ArrayList(Candidate), options: *const Type, current: []const u8) Allocator.Error!void {
    for (options.fields()) |f| {
        const flag = try std.fmt.allocPrint(a, "--{s}", .{try js.toKebab(a, f.name)});
        if (std.mem.startsWith(u8, flag, current) and !listed(candidates.items, flag))
            try candidates.append(a, .{ .description = f.ty.description, .value = flag });
    }
    for (options.fields()) |f| if (f.alias) |alias| {
        const flag = try std.fmt.allocPrint(a, "-{c}", .{alias});
        if (std.mem.startsWith(u8, flag, current) and !listed(candidates.items, flag))
            try candidates.append(a, .{ .description = f.ty.description, .value = flag });
    };
}

/// Suggests enum values for an option expecting a value. Returns true when the option takes a
/// value, so no other candidates apply.
fn values(a: Allocator, candidates: *std.ArrayList(Candidate), prev: []const u8, options: *const Type, current: []const u8) Allocator.Error!bool {
    const f = try optionField(a, prev, options) orelse return false;
    if (f.ty.kind == .@"enum") {
        for (f.ty.kind.@"enum") |v| if (std.mem.startsWith(u8, v, current)) try candidates.append(a, .{ .value = v });
        return true;
    }
    return !f.ty.isFlag();
}

/// Computes completion candidates for the word at `index`.
pub fn complete(a: Allocator, root: *const Node, argv: []const []const u8, index: usize, globals: ?*const Type) Allocator.Error![]const Candidate {
    const current = if (index < argv.len) argv[index] else "";
    var scope = root;
    for (argv[0..@min(index, argv.len)]) |token| {
        if (std.mem.startsWith(u8, token, "-")) continue;
        // Tokens after a command are its arguments.
        const children = scope.commands orelse break;
        for (children) |*child| if (std.mem.eql(u8, child.name, token)) {
            scope = &child.node;
            break;
        };
    }
    const leaf = scope.options;

    var candidates: std.ArrayList(Candidate) = .empty;
    if (std.mem.startsWith(u8, current, "-")) {
        if (leaf) |options| try flags(a, &candidates, options, current);
        if (globals) |g| try flags(a, &candidates, g, current);
        return candidates.items;
    }

    if (index > 0 and index - 1 < argv.len and std.mem.startsWith(u8, argv[index - 1], "-")) {
        for ([_]?*const Type{ leaf, globals }) |maybe| if (maybe) |options| {
            if (try values(a, &candidates, argv[index - 1], options, current)) return candidates.items;
        };
    }

    if (scope.commands) |children| for (children) |child| {
        if (!child.alias and std.mem.startsWith(u8, child.name, current))
            try candidates.append(a, .{ .description = child.node.description, .no_space = child.node.commands != null, .value = child.name });
    };
    return candidates.items;
}

/// Formats candidates for a shell.
pub fn format(a: Allocator, shell: Shell, candidates: []const Candidate) Allocator.Error![]const u8 {
    var parts: std.ArrayList([]const u8) = .empty;
    switch (shell) {
        .bash => {
            for (candidates) |c| try parts.append(a, if (c.no_space) try std.mem.concat(a, u8, &.{ c.value, "\x01" }) else c.value);
            return std.mem.join(a, "\x0b", parts.items);
        },
        .zsh => {
            for (candidates) |c| {
                const escaped = try std.mem.replaceOwned(u8, a, c.value, ":", "\\:");
                try parts.append(a, if (nonEmpty(c.description)) |d| try std.fmt.allocPrint(a, "{s}:{s}", .{ escaped, d }) else escaped);
            }
            return std.mem.join(a, "\n", parts.items);
        },
        .fish => {
            for (candidates) |c| try parts.append(a, if (nonEmpty(c.description)) |d| try std.fmt.allocPrint(a, "{s}\t{s}", .{ c.value, d }) else c.value);
            return std.mem.join(a, "\n", parts.items);
        },
        .nushell => {
            const records = try a.alloc(json.Value, candidates.len);
            for (candidates, records) |c, *slot| {
                var record: json.ObjectBuilder = .{};
                try record.put(a, "value", .{ .string = c.value });
                if (nonEmpty(c.description)) |d| try record.put(a, "description", .{ .string = d });
                slot.* = record.finish();
            }
            return json.stringify(a, .{ .array = records });
        },
    }
}

/// Returns the text unless it is null or empty.
fn nonEmpty(text: ?[]const u8) ?[]const u8 {
    const t = text orelse return null;
    return if (t.len == 0) null else t;
}
