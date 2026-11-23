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
typed struct instances and the `std.Io` the CLI is served with. This example compiles and runs as
part of `zig build test`.

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
    // Handlers do I/O through `c.io`, such as waiting before a retry.
    if (c.options.retries == 0) try c.io.sleep(.fromMilliseconds(1), .awake);
    return c.ok(.{ .added = package, .dev = c.options.save_dev, .tag = c.options.tag, .size = std.math.maxInt(u64) });
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

    try std.testing.expectEqual(0, try cli.serveWith(&.{ "i", "zod", "-D", "--tag", "next", "--retries", "0" }, process));
    try std.testing.expectEqualStrings("added: zod\ndev: true\ntag: next\nsize: 18446744073709551615\n", stdout.written());

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

Integer fields accept safe integers, as `z.number().int()` does, and their JSON Schema is the same.
A value that does not fit the field's type, such as `200` for an `i8` or `-1` for a `u16`, fails
validation with a `too_big` or `too_small` issue instead of overflowing. Count fields of an
integer type reject fractional config values the same way.

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
  optionals, integers, floats, strings, `incur.Value`), `c.stream(iterator)` or
  `c.streamSlice(chunks)` for streams, or `c.fail(.{ .code, .message, .hint, .retryable,
  .exit_code, .cta })`. Any other Zig error is reported as an `UNKNOWN` error carrying the error
  name.
- `c.stream(iterator)` takes a pointer to an iterator with a
  `next(self, io: std.Io, a: Allocator) !?incur.Chunk` method. `next` may do I/O and wait; human
  and TOON output writes and flushes each chunk as it arrives.
- `cli.serve(init)` runs with the process arguments, environment, standard streams, and
  `init.io`, and exits with the command's exit code. `cli.serveWith(argv, process)` takes an
  explicit `incur.Process` (`io`, `env`, `stdout`, `stderr`, `tty`) and returns the exit code.

## Concurrency

The `std.Io` in `Process.io` reaches every piece of user code: `c.io` in handlers and middleware,
the `io` argument of stream iterators and banner renderers, and `load.io` in config loaders. Use
it for files, the network, and clocks, and use `c.io.async` or `c.io.concurrent` for concurrent
work inside a command:

```txt
var first = c.io.async(fetch, .{ c.io, c.allocator, a });
defer if (first.cancel(c.io)) |_| {} else |_| {};
var second = c.io.async(fetch, .{ c.io, c.allocator, b });
defer if (second.cancel(c.io)) |_| {} else |_| {};
return c.ok(.{ .a = try first.await(c.io), .b = try second.await(c.io) });
```

Canceling the task that serves the CLI cancels the command: `error.Canceled` from `std.Io`
propagates out of `serveWith` (`incur.ServeError`) instead of being reported as an incur error.
`error.OutOfMemory` propagates the same way.

Every allocation goes through the allocator passed to `Cli.create`; each invocation uses an
arena that is freed before `serveWith` returns, and handlers allocate from `c.allocator`. The
arena is thread-safe when the CLI's allocator is, so concurrent tasks may share it.

## Values

`incur.Value` is a JSON value. Integers are exact: `.integer` holds an `i128`, and `.big_integer`
holds the digits of larger integers, so `18446744073709551615` prints unchanged in JSON, JSONL,
YAML, TOON, Markdown, filters, and token counts. `.float` values format as JavaScript's
`String(number)` does (`1e+21`, `0.1`). Strings follow JavaScript strings: a JSON escape of an
unpaired surrogate is kept, JSON output escapes it again (`"\ud800"`), and other output writes it
as U+FFFD, as Node does. Fields of type `incur.Value` take defaults, such as
`extra: incur.Value = .{ .integer = 7 }`.

## Differences from TypeScript

- `--mcp`, `mcp add`, and `skills add` report an `UNSUPPORTED` error.
- A config file that cannot be read for a reason other than not existing reports the Zig error
  name (such as `IsDir`) instead of Node's message.
- Integers in data keep their exact value; TypeScript rounds integers beyond 2^53 to the nearest
  double, so `9007199254740993` prints as `9007199254740992` there.
- Integer fields also reject values that do not fit their Zig type, which TypeScript has no type
  for.

## Development

```sh
zig build test       # API, README, compile-error, and differential tests
zig build coverage   # requires kcov; fails unless every line of src/ is covered
zig fmt --check .
```

`src/unicode.zig` holds the case mappings JavaScript's `toLowerCase` and case-insensitive regular
expressions use. Regenerate it after a Node upgrade:

```sh
node tools/unicode_tables.mjs > src/unicode.zig && zig fmt src/unicode.zig
```

The differential test runs the TypeScript reference through Node (`pnpm install` at the repo
root first). Set `INCUR_DIFFERENTIAL_DUMP=<path>` to write every case's result.
