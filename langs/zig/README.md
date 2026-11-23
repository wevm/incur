# incur for Zig

A Zig port of [incur](../../README.md), the TypeScript framework for CLIs that serve humans and
agents from one definition. Output, help, `--llms` manifests, shell completions, config files,
and errors match the TypeScript reference byte for byte on the shared differential suite in
[`langs/differential`](../differential).

Requires Zig 0.17.1.

## Install

```sh
zig fetch --save git+https://github.com/wevm/incur#<commit>
```

Then import the module in `build.zig`, assuming the dependency is saved under the name `incur`:

```txt
const incur = b.dependency("incur", .{ .target = target, .optimize = optimize });
exe.root_module.addImport("incur", incur.module("incur"));
```

## Example

Schemas are plain structs. Field types drive parsing, field defaults become option defaults, and
a `pub const incur` declaration next to the fields carries per-field metadata. Handlers receive
typed struct instances. This example compiles and runs as part of `zig build test`.

```zig
const std = @import("std");
const incur = @import("incur");

const InstallArgs = struct {
    package: ?[]const u8 = null,

    pub const incur = .{ .fields = .{ .package = .{ .description = "Package name" } } };
};

const Tag = enum { latest, next };

const InstallOptions = struct {
    save_dev: bool = false,
    retries: i64 = 3,
    tag: Tag = .latest,
    registry: ?[]const u8 = null,

    pub const incur = .{
        .rename_all = .camel_case,
        .fields = .{
            .save_dev = .{ .description = "Save as dev dependency", .alias = 'D' },
            .retries = .{ .description = "Retry count", .min = 0, .max = 10 },
            .tag = .{ .description = "Dist tag" },
            .registry = .{ .description = "Registry URL", .deprecated = true },
        },
    };
};

fn install(c: *incur.Context(.{ .args = InstallArgs, .options = InstallOptions })) !incur.Outcome {
    const package = c.args.package orelse
        return c.fail(.{ .code = "MISSING_PACKAGE", .message = "Name a package to install" });
    return c.ok(.{ .added = package, .dev = c.options.save_dev, .tag = c.options.tag });
}

/// Builds the CLI. A real program calls `try cli.serve(init)` from `main(init: std.process.Init)`.
fn build(gpa: std.mem.Allocator) !*incur.Cli {
    const cli = try incur.Cli.create(gpa, "pkg", .{ .description = "A package manager", .version = "1.0.0" });
    errdefer cli.destroy();
    try cli.command("install", .{ .description = "Install a package", .aliases = &.{"i"}, .run = incur.handler(install) });
    return cli;
}

test "serves typed commands" {
    const gpa = std.testing.allocator;
    const cli = try build(gpa);
    defer cli.destroy();

    var env: std.process.Environ.Map = .init(gpa);
    defer env.deinit();
    var stdout: std.Io.Writer.Allocating = .init(gpa);
    defer stdout.deinit();
    var stderr: std.Io.Writer.Allocating = .init(gpa);
    defer stderr.deinit();
    const process: incur.Process = .{ .io = std.testing.io, .env = &env, .stdout = &stdout.writer, .stderr = &stderr.writer, .tty = false };

    try std.testing.expectEqual(0, try cli.serveWith(&.{ "i", "zod", "-D", "--tag", "next" }, process));
    try std.testing.expectEqualStrings("added: zod\ndev: true\ntag: next\n", stdout.written());

    stdout.clearRetainingCapacity();
    try std.testing.expectEqual(1, try cli.serveWith(&.{"install"}, process));
    try std.testing.expectEqualStrings("code: MISSING_PACKAGE\nmessage: Name a package to install\n", stdout.written());
}
```

## Schemas

| Zig field type           | Parsed as                        |
| ------------------------ | -------------------------------- |
| `[]const u8`             | string                           |
| `bool`                   | boolean flag (`--no-<name>` too) |
| `i64` and other integers | integer                          |
| `f64`, `f32`             | number                           |
| `enum { a, b }`          | one of the tag names             |
| `[]const []const u8`     | repeatable option                |
| `?T`                     | optional `T`                     |
| a struct                 | object (env, output, and config) |
| `incur.Value`            | any JSON value                   |

A field without a default and without `?` is required. Pass a struct as `Context(.{ .args = A,
.options = O, .env = E })` to type a handler, or as `incur.schema(T)` for a command `output`, the
CLI `env`, or `globals` (read them with `c.globalsAs(T)`).

The `pub const incur` declaration accepts:

- `rename_all`: `.camel_case`, `.pascal_case`, `.kebab_case`, or `.screaming_snake_case`.
- `omit_null`: skip null optional fields when the struct is serialized.
- `fields`: per-field options, keyed by the Zig field name:
  - `description`: shown in help, `--llms`, and JSON Schema.
  - `alias`: a one-character short flag, such as `'D'`.
  - `min`, `max`: bounds on numbers, string lengths, and array lengths.
  - `count`: a number option that counts repeated flags (`-vvv`).
  - `deprecated`: marks the option deprecated in help and warns when it is used.
  - `rename`: the external name, overriding `rename_all`.

Unknown option names, unknown fields, and options that do not fit the field type are compile
errors, such as `incur metadata names unknown field 'sav_dev' of main.InstallOptions`.

## API

- `incur.Cli.create(gpa, name, options)` returns a `*Cli`; `cli.destroy()` frees it and every
  mounted group. Options include `description`, `version`, `env`, `vars`, `globals`, `config`
  (`flag`, `files`, `loader`), `banner`, `root` (a root command), `format`, `aliases`, `sync`,
  and `output_policy`.
- `cli.command(name, .{ ... })` registers a `Command` with `description`, `run`, `output`,
  `examples`, `hint`, `usage`, `aliases`, `destructive`, `middleware`, `format`, and
  `output_policy`. `cli.group(child)` mounts another CLI. `cli.use(fn)` adds middleware.
- `incur.handler(fn)` adapts a handler of type `fn (*incur.Context(.{ ... })) !incur.Outcome`.
  Return `c.ok(value)` with any value `incur.encode` converts (structs, tuples, slices, enums,
  optionals, numbers, strings, `incur.Value`), `c.stream(iterator)` or `c.streamSlice(chunks)`
  for streams, or `c.fail(.{ .code, .message, .hint, .retryable, .exit_code, .cta })`. Any other
  Zig error is reported as an `UNKNOWN` error carrying the error name.
- `cli.serve(init)` runs with the process arguments, environment, and standard streams, and
  exits with the command's exit code. `cli.serveWith(argv, process)` takes explicit I/O and
  returns the exit code.

Every allocation goes through the allocator passed to `Cli.create`; each invocation uses an
arena that is freed before `serveWith` returns, and handlers allocate from `c.allocator`.

## Differences from TypeScript

- `--mcp`, `mcp add`, and `skills add` report an `UNSUPPORTED` error.
- A config file that cannot be read for a reason other than not existing reports the Zig error
  name (such as `IsDir`) instead of Node's message.
- Case conversion in suggestions covers ASCII and Latin-1 letters and Latin Extended-A.
- JSON escapes of lone UTF-16 surrogates decode to U+FFFD.

## Development

```sh
zig build test       # API, README, compile-error, and differential tests
zig build coverage   # requires kcov; fails unless every line of src/ is covered
zig fmt --check .
```

The differential test runs the TypeScript reference through Node (`pnpm install` at the repo
root first). Set `INCUR_DIFFERENTIAL_DUMP=<path>` to write every case's result.
