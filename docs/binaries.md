# Standalone binaries

Incur can compile a TypeScript or JavaScript CLI into standalone executables for
macOS, Linux, and Windows. The resulting executables contain the Bun runtime, so
users do not need Node.js, Bun, Incur, or a package installation at runtime.

Bun is required only on the machine that builds the binaries. Pin the Bun
version in release automation so every target is built with the same compiler.

## Build

Run `incur build` from the CLI project's root:

```sh
pnpm exec incur build ./src/bin.ts
```

Incur resolves the binary name and version from the nearest `package.json`. Use
explicit values when the package metadata is absent or does not describe the
binary being built:

```sh
pnpm exec incur build ./src/bin.ts \
  --name frog \
  --version 1.2.3 \
  --output ./dist/binaries
```

The default output directory is `dist/binaries`. With `--name frog`, a default
build contains a raw executable and compressed release asset for every supported
target, plus a checksum file:

```text
dist/binaries/
  frog-darwin-arm64
  frog-darwin-arm64.gz
  frog-darwin-x64
  frog-darwin-x64.gz
  frog-linux-arm64-glibc
  frog-linux-arm64-glibc.gz
  frog-linux-arm64-musl
  frog-linux-arm64-musl.gz
  frog-linux-x64-glibc-baseline
  frog-linux-x64-glibc-baseline.gz
  frog-linux-x64-musl-baseline
  frog-linux-x64-musl-baseline.gz
  frog-windows-arm64.exe
  frog-windows-arm64.exe.gz
  frog-windows-x64-baseline.exe
  frog-windows-x64-baseline.exe.gz
  SHA256SUMS
```

The compressed files are the GitHub Release assets. `SHA256SUMS` records their
SHA-256 digests for offline and release-pipeline verification. The raw
executables are local build products and do not need to be uploaded.

Build an explicit subset by repeating `--target`:

```sh
pnpm exec incur build ./src/bin.ts \
  --target darwin-arm64 \
  --target linux-x64-glibc-baseline
```

If any requested target fails, the command fails the whole build. It does not
report a partial target set as a successful release.

## Initial installers

Generate Unix and Windows installers with the full target matrix:

```sh
pnpm exec incur build ./src/bin.ts --installer
```

Incur infers the public GitHub repository from the nearest `package.json`
`repository` field. Pass it explicitly when that metadata is absent or points
somewhere else:

```sh
pnpm exec incur build ./src/bin.ts \
  --installer \
  --repository wevm/frog
```

Installer generation requires a stable semantic version and the full default
target matrix. It adds `install.sh` and `install.ps1` to
`dist/binaries/`. Each script embeds the exact `v<version>` release tag, so a
mutable latest-release URL only selects the script; the script downloads its
binary and `SHA256SUMS` from that exact tagged release.

Once the workflow has uploaded the assets and the draft release is published,
users can install the latest stable release:

```sh
curl -fsSL https://github.com/wevm/frog/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/wevm/frog/releases/latest/download/install.ps1 | iex
```

Use an exact tag URL to avoid selecting a newer release:

```sh
curl -fsSL https://github.com/wevm/frog/releases/download/v1.2.3/install.sh | sh
```

Tags, assets, and their checksum file can otherwise be replaced together.
Enable [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
to lock the tag and assets after publication. Without that setting, checksum
verification confirms the currently published asset, not its historical
immutability.

A project-owned URL can provide shorter commands. Configure
`https://frog.dev/install.sh` to redirect to
`https://github.com/wevm/frog/releases/latest/download/install.sh`; the
downloaded script still pins all subsequent requests to its embedded release.
GitHub documents the stable
[`/releases/latest/download/<asset>` URL](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).

The Unix installer supports macOS and glibc or musl Linux on ARM64 and x64. The
PowerShell installer supports Windows on ARM64 and x64. Both:

- Select the canonical asset for the current operating system and architecture.
- Require SHA-256 verification against the release's `SHA256SUMS`.
- Decompress into a temporary directory and require the candidate to report the
  embedded version.
- Stage the candidate in the destination directory before atomically replacing
  an existing installation.
- Install to `$HOME/.local/bin` by default without editing shell profiles.

Set `FROG_INSTALL_DIR` for a CLI-specific destination or `INSTALL_DIR` for the
generic override. The generated variable name is derived from the binary name.
If the directory is not already on `PATH`, the installer prints the required
change. Users can download and inspect either script before running it.

## Targets

The default build contains eight targets:

| Target                     | Platform | Architecture | Runtime               | Release asset                        |
| -------------------------- | -------- | ------------ | --------------------- | ------------------------------------ |
| `darwin-arm64`             | macOS    | ARM64        | Darwin                | `<name>-darwin-arm64.gz`             |
| `darwin-x64`               | macOS    | x64          | Darwin, baseline CPU  | `<name>-darwin-x64.gz`               |
| `linux-arm64-glibc`        | Linux    | ARM64        | glibc                 | `<name>-linux-arm64-glibc.gz`        |
| `linux-x64-glibc-baseline` | Linux    | x64          | glibc, baseline CPU   | `<name>-linux-x64-glibc-baseline.gz` |
| `linux-arm64-musl`         | Linux    | ARM64        | musl                  | `<name>-linux-arm64-musl.gz`         |
| `linux-x64-musl-baseline`  | Linux    | x64          | musl, baseline CPU    | `<name>-linux-x64-musl-baseline.gz`  |
| `windows-arm64`            | Windows  | ARM64        | Windows               | `<name>-windows-arm64.exe.gz`        |
| `windows-x64-baseline`     | Windows  | x64          | Windows, baseline CPU | `<name>-windows-x64-baseline.exe.gz` |

The x64 builds use Bun's baseline targets for compatibility with CPUs that do
not support AVX2. ARM64 has no baseline variant. Target identity, including the
Linux libc, is embedded while building; the updater never guesses it from the
user's machine.

Each executable includes a Bun runtime, so raw files can be tens of megabytes
or larger. Compression substantially reduces release assets, but exact sizes
vary with the Bun version and bundled application. Treat unexpectedly large
changes as a release-review signal rather than enforcing a fixed size.

See [Bun's executable target documentation](https://bun.sh/docs/bundler/executables)
for the underlying compiler compatibility.

## GitHub binary updates

Use `Binary.github` as the CLI's update provider:

```ts
import { Binary, Cli } from 'incur'

const cli = Cli.create('frog', {
  update: Binary.github({ repository: 'wevm/frog' }),
})
```

`Binary.github` activates only when Incur's embedded binary metadata is present.
Running the same entrypoint from an npm, pnpm, or Bun package continues to use
the package-manager updater. `incur build` embeds the resolved version, and
`Cli.create` uses it by default inside the compiled artifact. An explicit
`version` still overrides the embedded value.

The provider supports public GitHub repositories and stable releases:

- It considers published, non-draft releases whose tags are stable semantic
  versions.
- It ignores drafts, prereleases, malformed versions, equal versions, and
  downgrades.
- It selects the highest newer release that has an asset matching the embedded
  target.
- It resolves that exact release and asset rather than using a mutable
  `latest/download` URL.
- It requires the GitHub Release asset's `sha256` digest and verifies the
  downloaded bytes before decompression or installation.

Automatic update checks reuse Incur's detached daily cache and remain silent in
agent, JSON, MCP, help, and completion output. When a newer version is cached,
human TTY output suggests:

```text
Update available for frog:
  frog --update  # upgrade from 1.2.3 to 1.3.0
```

`NO_UPDATE_NOTIFIER`, `CI`, and `npm_config_update_notifier=false` suppress
automatic checks. They do not weaken verification for an explicit
`frog --update`.

### Replacement and recovery

Before replacing anything, the updater downloads the asset into memory and
verifies its digest. It stages the decompressed candidate beside the installed
executable and confirms that it reports the expected version.

On macOS and Linux, the verified candidate is made executable and installed
with a same-filesystem atomic replacement. On Windows, the running `.exe`
cannot replace itself, so Incur starts a detached handoff that applies the
verified candidate after the original process exits. The command reports the
update as staged, rather than completed, until that handoff can run.

Download, permission, decompression, digest, and version-validation failures
leave the installed executable usable. If a Windows replacement fails after
moving the old executable, the handoff attempts to restore it from the
same-directory backup. Detached handoff failures preserve recovery details in
`<executable>.incur-error-<uuid>.txt` beside the candidate and any remaining
backup. Follow that marker, resolve the filesystem error, and run `--update`
again. Never work around an update failure by disabling digest verification.

## Release action

Copy this workflow into the CLI project's
`.github/workflows/binary-release.yml`:

```yaml
name: Binary Release

on:
  workflow_dispatch:

concurrency:
  group: binary-release

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: wevm/incur/release@v1
```

The action defaults to `./src/bin.ts`, reads the name and stable version from the
root `package.json`, and selects the matching `v<version>` draft release. It
resolves that tag to a commit before installing dependencies or running caller
code, then builds from the validated commit.

The job grants `contents: write` so the action can upload assets. Composite
actions cannot isolate job permissions, so treat the tagged source and locked
dependencies as trusted. Checkout does not persist the GitHub credentials in
the worktree, but install, build, and upload still share one job.

The action:

1. Requires a public repository, an existing `v<package version>` tag, and a
   draft release for that exact tag.
2. Detects npm, pnpm, or Bun, installs dependencies, and cross-compiles all eight
   unsigned targets with one pinned Bun version on the Linux runner.
3. Verifies the release assets and their checksums.
4. Smoke-tests the matching-architecture Linux glibc asset natively and the
   matching musl asset in Alpine.
5. Uploads compressed binaries, `SHA256SUMS`, `install.sh`, and `install.ps1`
   without replacing existing assets.

The action cannot natively execute the opposite-architecture Linux, macOS, or
Windows binaries from its runner. Native macOS and Windows tests, plus platform
signing, are outside its scope.

The release must remain a draft until every asset is uploaded. The action does
not create or publish a release, create or move a tag, or replace existing
assets. Create the version tag and matching draft first, run the action, review
its assets, then publish the draft separately.

Use `entry`, `name`, or `release_tag` to override the inferred values for
nonstandard layouts, renamed executables, or backfills. Set `package_manager`
when inference would be ambiguous. `pnpm_version` provides the fallback for
lockfile-only pnpm projects, and `bun_version` selects the compiler.

The action cannot set workflow-level concurrency. If release dispatches may
overlap, keep a caller concurrency group such as the one above.

### Unsigned builds

`incur build` and the release action produce unsigned executables. Publicly
distributed unsigned macOS and Windows builds can trigger Gatekeeper,
SmartScreen, or enterprise policy warnings. Projects requiring signed binaries
need a separate platform-specific release process.

## Scope

Binary support does not provide:

- GitHub authentication for private repositories.
- Prerelease or named update channels.
- Homebrew, Scoop, Winget, or other package-manager formulas.
- GitHub Release creation, publication, retagging, or versioning.
- Signing identities, notarization credentials, secret storage, or a signing
  service.
- Automatic upload from `incur build`.

Alternate distribution providers can use the same stable asset contract without
weakening the update path.
