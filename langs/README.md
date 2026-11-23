# Language ports

Ports of incur to other languages. The TypeScript package in `src/` is the reference; every port
must produce the same stdout, stderr, and exit code for the same invocation.

| Directory                           | Contents                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------- |
| [`_differential/`](./_differential) | The shared differential suite: reference CLIs, cases, and config fixtures. |
| [`rust/`](./rust)                   | The Rust port: the `incur` crate and its `#[derive(Schema)]` macro.        |
| [`python/`](./python)               | The Python port: the `incur` package, with typed schema classes.           |
| [`zig/`](./zig)                     | The Zig port: the `incur` module, with comptime schema metadata.           |

## Differential suite

- [`_differential/fixtures.ts`](./_differential/fixtures.ts) defines the reference CLIs. Each port
  mirrors them with the same names, schemas, and handlers.
- [`_differential/cases.json`](./_differential/cases.json) lists the invocations, one per line:
  `cli` (a fixture key), `argv`, and optional `env`, `tty`, `bin`, `sandbox`, `stdin`, and
  `requests`. `bin` serves the case as a process started under that binary name, which the help
  title and completion scripts show. The last three are described under
  [Sandboxed cases](#sandboxed-cases).
- [`_differential/run.ts`](./_differential/run.ts) runs every case against the TypeScript CLIs and
  prints `[{ stdout, stderr, exit }]` in case order, with `files` added for sandboxed cases. Ports
  run the same cases and compare. Durations such as `12ms` are normalized; sandboxed cases also
  normalize paths and timestamps. `run.ts <file>` runs another cases file.
- [`_differential/config/`](./_differential/config) holds config files the cases load, including
  invalid JSON on purpose. Cases without `sandbox` run with this directory's parent as the
  working directory.

### Sandboxed cases

A case with `sandbox` (an object, often `{}`) runs as if in a fresh process on a clean machine.
These cases cover `--mcp`, `cli.fetch`, fetch-backed, OpenAPI, and MCP-source commands,
`mcp add`/`doctor`, `skills add`/`list`, and updates.

- **Layout.** One root directory per run holds `home/` (the sandbox), `bin/` (stub runners), and
  `tmp/`. Before each case the sandbox is emptied, then seeded from `sandbox`: each key is a
  `/`-separated path relative to the sandbox, and each value is the file contents (a string), a
  directory (`null`), or a symlink (`{"symlink": "<target>"}`).
- **Environment.** The process environment is replaced by `HOME=<sandbox>`, `PATH=<root>/bin`,
  `TMPDIR=<root>/tmp`, and then the case's `env`. `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
  `XDG_CACHE_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` are unset unless `env` sets them, so
  agent, skills, and update paths resolve under `HOME`. The working directory is the sandbox.
  The program path (`process.argv[1]`) is `<sandbox>/<bin>`, with `bin` defaulting to `cli`; a
  `bin` such as `node_modules/updpkg/cli.js` exists only when seeded. No case sets both `tty` and
  `bin`.
- **Placeholders.** `<sandbox>` and `<root>` in seeded contents, symlink targets, and `env`
  values stand for the real absolute paths.
- **Stubs.** `bin/` holds `bun`, `bunx`, `npm`, `npx`, `pnpm`, and `pnpx`, each this script:

  ```sh
  #!/bin/sh
  { printf '%s' "${0##*/}"; for a in "$@"; do printf ' %s' "$a"; done; printf '\n'; } >> "$HOME/stub.log"
  printf '%s' "$STUB_STDERR" >&2
  printf '%s' "$STUB_STDOUT"
  exit "${STUB_EXIT:-0}"
  ```

- **Fresh CLIs.** Each case gets newly constructed fixture CLIs, so a stateful MCP session or a
  resolved remote MCP server never carries over.
- **`stdin`.** Lines written to stdin, each followed by `\n`: strings verbatim, other values as
  compact JSON. The reference writes one line at a time, waits for the response to each request
  (an object with `method` and `id`), and then closes stdin, so ports must answer messages in
  order. `--mcp` exits 0 at end of input.
- **`requests`.** HTTP requests sent in order to `cli.fetch` instead of serving `argv` (always
  `[]`). Each has `url` (resolved against `http://localhost`), optional `method` (default
  `GET`), `headers`, and `body` (a string verbatim, any other value as compact JSON; a body
  without a `content-type` header gets `text/plain;charset=UTF-8`, as the Fetch API sets). A
  header value `<session>` is replaced with the last `mcp-session-id` response header. Each
  response is appended to stdout as `HTTP <status>`, one `name: value` line per header in name
  order (`mcp-session-id` shows `<session>`), a blank line, the body, and a newline. `exit` is 0.
- **`files`.** Every entry under the sandbox after the case, sorted by path, in the seed format.
- **Normalization.** In stdout, stderr, file contents, and symlink targets, the real sandbox and
  root paths become `<sandbox>` and `<root>`, timestamps such as `2026-01-02T03:04:05.678Z`
  become `<time>`, and `"checkedAt":<digits>` becomes `"checkedAt":0`. A skills metadata file
  (a JSON object with a string `hash` and a `skills` array) has `skills` and `paths` sorted and
  is rewritten as compact JSON with a trailing newline, because their order follows directory
  listing order.

To add coverage, add a fixture behavior to `fixtures.ts` and every port's mirror, then append
cases to `cases.json`. Every port must pass the whole suite.

```sh
pnpm install
node --import tsx langs/_differential/run.ts > /tmp/reference.json
```

## Rust

```sh
cd langs/rust
cargo test --workspace                                           # differential, API, and derive tests
cargo clippy --workspace --all-targets --features incur/client   # with the optional ureq HTTP client
cargo test --workspace --no-default-features                     # without tokio: std-only blocking executor
cargo llvm-cov --workspace --fail-uncovered-lines 0 --show-missing-lines
```

## Python

```sh
cd langs/python
uv sync
uv run ruff check && uv run ruff format --check && uv run pyright
uv run coverage erase && uv run coverage run -m pytest && uv run coverage report   # 100% branch coverage
```

## Zig

Requires Zig 0.17.1 and, for coverage, kcov.

```sh
cd langs/zig
zig fmt --check .
zig build test                                                  # API, README, compile-error, and differential tests
zig build coverage                                              # fails on any uncovered line in src/
node tools/unicode_tables.mjs > src/unicode.zig && zig fmt src/unicode.zig   # regenerate case tables
```

`zig build test` also compiles every README program and checks its `# →` output.

## Debugging

- `INCUR_DIFFERENTIAL_DUMP=/tmp/failures.txt` writes every differing case to a file, in every port.
- The Zig harness also reads `INCUR_DIFFERENTIAL_REFERENCE` (a saved `run.ts` output to reuse),
  `INCUR_DIFFERENTIAL_FILTER`, and `INCUR_DIFFERENTIAL_CASES`.

## Releasing

The ports share the npm package's version. `changeset:version` runs `node langs/version.ts`, which
writes `package.json`'s version into every port's manifest, lockfile, and install instructions, and
the Checks job fails when they drift (`node langs/version.ts --check`).

When changesets publishes `incur` to npm, `main.yml` runs `.github/workflows/release-langs.yml`,
which publishes the same version once Main's checks have passed:

- Rust: `incur-macros`, then `incur`, to crates.io (trusted publishing, environment `crates-io`).
- Python: `incur` to PyPI (trusted publishing, environment `pypi`).
- Zig: `incur-zig-<version>.tar.gz` of `langs/zig`, attached to the `incur@<version>` GitHub release.

Run the workflow by hand (Actions → Release Language Ports → Run workflow on `main`) to release the
current version, for example after the one-time setup:

- crates.io: publish the first versions of `incur-macros` and `incur` by hand
  (`cargo publish -p incur-macros && cargo publish -p incur`), then add `wevm/incur` with workflow
  `release-langs.yml` and environment `crates-io` as a trusted publisher on both crates.
- PyPI: add a pending trusted publisher for project `incur` with workflow `release-langs.yml` and
  environment `pypi`.
- GitHub: create the `crates-io` and `pypi` environments (optionally with required reviewers).
