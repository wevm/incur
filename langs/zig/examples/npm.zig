//! A port of the TypeScript example `examples/npm/cli.ts`: `zig build npm -- <args>`.

const std = @import("std");
const incur = @import("incur");

const Context = incur.Context(.{});
const Outcome = incur.Outcome;

const Install = struct {
    package: ?[]const u8 = null,
    save_dev: ?bool = null,
    save_exact: ?bool = null,
    global: ?bool = null,

    pub const incur = .{
        .output = struct {
            added: f64,
            removed: f64,
            changed: f64,
            packages: f64,

            pub const incur = .{ .fields = .{
                .added = .{ .description = "Number of packages added" },
                .removed = .{ .description = "Number of packages removed" },
                .changed = .{ .description = "Number of packages changed" },
                .packages = .{ .description = "Total packages in node_modules" },
            } };
        },
        .examples = &.{
            .{ .command = "express", .description = "Install a package" },
            .{ .command = "vitest --saveDev true", .description = "Install as dev dependency" },
            .{ .command = "tsx --global true", .description = "Install globally" },
        },
        .fields = .{
            .package = .{ .arg = true, .description = "Package name to install" },
            .save_dev = .{ .alias = 'D', .description = "Save as dev dependency" },
            .save_exact = .{ .alias = 'E', .description = "Save exact version" },
            .global = .{ .alias = 'g', .description = "Install globally" },
        },
    };
};

const Info = struct {
    package: []const u8,

    pub const incur = .{
        .output = struct {
            name: []const u8,
            version: []const u8,
            description: []const u8,
            license: []const u8,
            homepage: []const u8,

            pub const incur = .{ .fields = .{ .version = .{ .description = "Latest version" } } };
        },
        .examples = &.{.{ .command = "express", .description = "View info for express" }},
        .fields = .{ .package = .{ .arg = true, .description = "Package name" } },
    };
};

const Init = struct {
    yes: ?bool = null,
    scope: ?[]const u8 = null,

    pub const incur = .{
        .output = struct {
            created: []const u8,

            pub const incur = .{ .fields = .{ .created = .{ .description = "Path to created package.json" } } };
        },
        .examples = &.{.{ .command = "--yes true", .description = "Create with defaults" }},
        .fields = .{
            .yes = .{ .alias = 'y', .description = "Skip prompts and use defaults" },
            .scope = .{ .description = "Package scope" },
        },
    };
};

const Publish = struct {
    npm_token: ?[]const u8 = null,
    npm_registry: []const u8 = "https://registry.npmjs.org",
    tag: []const u8 = "latest",
    access: enum { public, restricted } = .public,
    dry_run: ?bool = null,
    otp: ?[]const u8 = null,

    pub const incur = .{
        .output = struct { name: []const u8, version: []const u8, tag: []const u8 },
        .examples = &.{
            .{ .description = "Publish with latest tag" },
            .{ .command = "--tag beta", .description = "Publish as beta" },
            .{ .command = "--dryRun true", .description = "Dry run" },
        },
        .fields = .{
            .npm_token = .{ .env = true, .description = "Authentication token" },
            .npm_registry = .{ .env = true, .description = "Registry URL" },
            .tag = .{ .description = "Distribution tag" },
            .access = .{ .description = "Package access level" },
            .dry_run = .{ .description = "Report what would be published" },
            .otp = .{ .description = "One-time password for 2FA" },
        },
    };
};

const Run = struct {
    script: []const u8,

    pub const incur = .{
        .output = struct { script: []const u8, exitCode: f64 },
        .examples = &.{
            .{ .command = "test", .description = "Run tests" },
            .{ .command = "build", .description = "Run build" },
        },
        .fields = .{ .script = .{ .arg = true, .description = "Script name to run" } },
    };
};

const Uninstall = struct {
    package: []const u8,
    global: ?bool = null,

    pub const incur = .{
        .output = struct {
            removed: f64,
            packages: f64,

            pub const incur = .{ .fields = .{ .packages = .{ .description = "Remaining packages" } } };
        },
        .examples = &.{.{ .command = "express", .description = "Remove a package" }},
        .fields = .{
            .package = .{ .arg = true, .description = "Package name to remove" },
            .global = .{ .alias = 'g', .description = "Remove global package" },
        },
    };
};

const Outdated = struct {
    global: ?bool = null,
    long: ?bool = null,

    pub const incur = .{
        .output = struct { packages: []const struct { name: []const u8, current: []const u8, wanted: []const u8, latest: []const u8 } },
        .examples = &.{
            .{ .description = "Check for outdated packages" },
            .{ .command = "--global true", .description = "Check global packages" },
        },
        .fields = .{
            .global = .{ .alias = 'g', .description = "Check global packages" },
            .long = .{ .alias = 'l', .description = "Show extended information" },
        },
    };
};

const Npm = union(enum) {
    install: Install,
    info: Info,
    init: Init,
    publish: Publish,
    run: Run,
    uninstall: Uninstall,
    outdated: Outdated,

    pub const incur = .{
        .name = "npm",
        .version = "10.9.2",
        .description = "The package manager for JavaScript.",
        .fields = .{
            .install = .{ .description = "Install a package" },
            .info = .{ .description = "View registry info for a package" },
            .init = .{ .description = "Create a package.json file" },
            .publish = .{ .description = "Publish a package to the registry" },
            .run = .{ .description = "Run a script defined in package.json" },
            .uninstall = .{ .description = "Remove a package" },
            .outdated = .{ .description = "Check for outdated packages" },
        },
    };
};

fn run(c: *Context, command: Npm) !Outcome {
    return switch (command) {
        .install => |install| if (install.package == null)
            c.ok(.{ .added = 120, .removed = 0, .changed = 0, .packages = 450 })
        else
            c.ok(.{ .added = 1, .removed = 0, .changed = 0, .packages = 451 }),
        .info => |info| c.ok(.{
            .name = info.package,
            .version = "4.21.2",
            .description = "Fast, unopinionated, minimalist web framework",
            .license = "MIT",
            .homepage = "https://expressjs.com/",
        }),
        .init => c.ok(.{ .created = "./package.json" }),
        .publish => |publish| c.ok(.{ .name = "my-package", .version = "1.0.0", .tag = publish.tag }),
        .run => |script| c.ok(.{ .script = script.script, .exitCode = 0 }),
        .uninstall => c.ok(.{ .removed = 1, .packages = 449 }),
        .outdated => c.ok(.{ .packages = .{
            .{ .name = "express", .current = "4.18.0", .wanted = "4.21.2", .latest = "4.21.2" },
            .{ .name = "typescript", .current = "5.3.0", .wanted = "5.7.3", .latest = "5.7.3" },
        } }),
    };
}

pub fn main(init: std.process.Init) !void {
    // Sync suggestions are a CLI option, so the CLI is created before serving.
    const cli = try incur.cli(Npm, init.gpa, .{ .sync = .{
        .suggestions = &.{ "install react as a dependency", "check for outdated packages", "audit my repo" },
    } });
    defer cli.destroy();
    try cli.handle(Npm, run);
    try cli.serve(init);
}
