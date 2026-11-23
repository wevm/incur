# Language ports

Ports of incur to other languages. The TypeScript package in `src/` is the reference; every port
must produce the same stdout, stderr, and exit code for the same invocation.

| Directory                         | Contents                                                                   |
| --------------------------------- | -------------------------------------------------------------------------- |
| [`differential/`](./differential) | The shared differential suite: reference CLIs, cases, and config fixtures. |
| [`rust/`](./rust)                 | The Rust port: the `incur` crate and its `#[derive(Schema)]` macro.        |
| [`python/`](./python)             | The Python port: the `incur` package, with typed schema classes.           |
| [`zig/`](./zig)                   | The Zig port: the `incur` module, with comptime schema metadata.           |

## Differential suite

- [`differential/fixtures.ts`](./differential/fixtures.ts) defines the reference CLIs. Each port
  mirrors them with the same names, schemas, and handlers.
- [`differential/cases.json`](./differential/cases.json) lists the invocations, one per line:
  `cli` (a fixture key), `argv`, and optional `env`, `tty`, and `bin`. `bin` serves the case as a
  process started under that binary name, which the help title and completion scripts show.
- [`differential/run.ts`](./differential/run.ts) runs every case against the TypeScript CLIs and
  prints `[{ stdout, stderr, exit }]` in case order. Ports run the same cases and compare. Only
  durations such as `12ms` are normalized.
- [`differential/config/`](./differential/config) holds config files the cases load, including
  invalid JSON on purpose. Cases run with this directory's parent as the working directory.

To add coverage, add a fixture behavior to `fixtures.ts` and every port's mirror, then append
cases to `cases.json`. Every port must pass the whole suite.

```sh
pnpm install
node --import tsx langs/differential/run.ts > /tmp/reference.json
```

## Rust

```sh
cd langs/rust
cargo test --workspace                                           # differential, API, and derive tests
cargo llvm-cov --workspace --fail-uncovered-lines 0 --show-missing-lines
```

## Python

```sh
cd langs/python
uv sync
uv run ruff check && uv run ruff format --check && uv run pyright
uv run coverage run -m pytest && uv run coverage report        # fails below 100% branch coverage
```

## Zig

Requires Zig 0.17.1 and, for coverage, kcov.

```sh
cd langs/zig
zig fmt --check .
zig build test                                                  # API, README, compile-error, and differential tests
zig build coverage                                              # fails on any uncovered line in src/
```

`INCUR_DIFFERENTIAL_DUMP=/tmp/failures.txt` writes every differing case to a file, in every port.
