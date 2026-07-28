# Standalone binaries

Incur compiles a TypeScript or JavaScript CLI into standalone executables for
macOS, Linux, and Windows. Each executable includes the Bun runtime. Users do
not need Node.js, Bun, Incur, or a package installation to run the executable.

The build computer must have Bun. Pin the Bun version in release automation.
This keeps the compiler version the same for all targets.

## Build

Run `incur build` from the CLI project root:

```sh
pnpm exec incur build ./src/bin.ts
```

Incur reads the executable name and version from the nearest `package.json`. If
the file does not contain these values or describes a different executable, set
the values explicitly:

```sh
pnpm exec incur build ./src/bin.ts \
  --name frog \
  --version 1.2.3 \
  --output ./dist/binaries
```

The default output directory is `dist/binaries`. A default build with
`--name frog` contains these files:

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

The compressed files are the GitHub Release assets. `SHA256SUMS` contains the
SHA-256 checksum for each `.gz` release asset. The raw executables are local
build products. You do not need to upload them.

To build selected targets, repeat `--target`:

```sh
pnpm exec incur build ./src/bin.ts \
  --target darwin-arm64 \
  --target linux-x64-glibc-baseline
```

If one target fails, Incur fails the command.

## Installers

To generate Unix and Windows installers, build all targets:

```sh
pnpm exec incur build ./src/bin.ts --installer
```

Incur reads the public GitHub repository from the nearest `package.json`
`repository` field. Use `--repository` if the field is missing or identifies a
different repository:

```sh
pnpm exec incur build ./src/bin.ts \
  --installer \
  --repository wevm/frog
```

To generate installers:

- Use a stable semantic version.
- Build all default targets.

The command adds `install.sh` and `install.ps1` to `dist/binaries/`. Each
installer contains the exact `v<version>` release tag. A latest-release URL
selects only the installer. The installer downloads its executable and
`SHA256SUMS` from the tagged release.

After the action uploads the assets, publish the draft release. Users can then
install the latest stable release:

```sh
curl -fsSL https://github.com/wevm/frog/releases/latest/download/install.sh | sh
```

```powershell
irm https://github.com/wevm/frog/releases/latest/download/install.ps1 | iex
```

Use an exact tag URL if you do not want a newer release:

```sh
curl -fsSL https://github.com/wevm/frog/releases/download/v1.2.3/install.sh | sh
```

A repository owner can replace a tag, its assets, and its checksum file
together. Enable
[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
to prevent changes after publication. Without this setting, the checksum
verifies only the current release asset. It does not prove that the asset never
changed.

A project URL can make the install command shorter. For example, redirect
`https://frog.dev/install.sh` to
`https://github.com/wevm/frog/releases/latest/download/install.sh`. The
installer still uses its embedded tag for all later downloads. GitHub documents
the stable
[`/releases/latest/download/<asset>` URL](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).

The Unix installer supports macOS and Linux with glibc or musl. It supports
ARM64 and x64. The PowerShell installer supports Windows on ARM64 and x64.

Each installer:

- Selects the correct release asset for the operating system and architecture.
- Verifies the release asset against `SHA256SUMS`.
- Decompresses the release asset in a temporary directory.
- Checks that the new executable reports the embedded version.
- Puts a temporary copy of the new executable in the destination directory.
- Replaces an existing executable atomically.
- Installs to `$HOME/.local/bin` by default.
- Does not change shell profiles.

Set `FROG_INSTALL_DIR` to select a destination for this CLI. Set `INSTALL_DIR`
to override the destination for one installer run. Incur forms the CLI-specific
variable name from the executable name.

If the destination is not on `PATH`, the installer tells you how to add it. You
can download and inspect an installer before you run it.

## Targets

The default build contains eight targets:

| Target                     | Operating system | Architecture | Runtime and CPU       | Release asset                        |
| -------------------------- | ---------------- | ------------ | --------------------- | ------------------------------------ |
| `darwin-arm64`             | macOS            | ARM64        | Darwin                | `<name>-darwin-arm64.gz`             |
| `darwin-x64`               | macOS            | x64          | Darwin, baseline CPU  | `<name>-darwin-x64.gz`               |
| `linux-arm64-glibc`        | Linux            | ARM64        | glibc                 | `<name>-linux-arm64-glibc.gz`        |
| `linux-x64-glibc-baseline` | Linux            | x64          | glibc, baseline CPU   | `<name>-linux-x64-glibc-baseline.gz` |
| `linux-arm64-musl`         | Linux            | ARM64        | musl                  | `<name>-linux-arm64-musl.gz`         |
| `linux-x64-musl-baseline`  | Linux            | x64          | musl, baseline CPU    | `<name>-linux-x64-musl-baseline.gz`  |
| `windows-arm64`            | Windows          | ARM64        | Windows               | `<name>-windows-arm64.exe.gz`        |
| `windows-x64-baseline`     | Windows          | x64          | Windows, baseline CPU | `<name>-windows-x64-baseline.exe.gz` |

The x64 builds use Bun baseline targets. These targets support CPUs that do not
have AVX2. ARM64 does not have a baseline target.

Incur stores target information in each executable. On Linux, this information
includes glibc or musl. The updater reads the information from the executable.
It does not detect the target on the user's computer.

Each executable includes Bun and can be tens of megabytes or larger.
Compression reduces the release asset size. The exact size depends on the Bun
version and the application. Investigate unexpected size changes. Do not
enforce a fixed size.

See [Bun executable targets](https://bun.sh/docs/bundler/executables) for
compiler compatibility.

## Updates from GitHub

Use `Binary.github` as the CLI update provider:

```ts
import { Binary, Cli } from 'incur'

const cli = Cli.create('frog', {
  update: Binary.github({ repository: 'wevm/frog' }),
})
```

`Binary.github` runs only in an executable that contains embedded Incur
metadata. Package installations through npm, pnpm, or Bun continue to use the
package manager for updates.

`incur build` adds the resolved version to the executable. In the executable,
`Cli.create` uses this version by default. An explicit `version` overrides the
embedded version.

The provider supports public GitHub repositories and stable releases:

- Checks published releases with stable semantic version tags.
- Ignores drafts, prereleases, invalid versions, the current version, and older versions.
- Selects the highest semantic version above the current version with an asset for the embedded target.
- Uses the exact release and asset. It does not use `latest/download`, because that URL can change.
- Requires a SHA-256 checksum in the GitHub Release asset `digest` field.
- Verifies the release asset before decompression or installation.

Incur reads the cached result for automatic update checks. It starts a
background refresh if the cache is absent or at least one day old.

Incur does not show automatic notices in agent, JSON, MCP, help, or completion
output. When the cache contains a newer version, an interactive terminal shows
this message:

```text
Update available for frog:
  frog --update  # upgrade from 1.2.3 to 1.3.0
```

`NO_UPDATE_NOTIFIER`, `CI`, and `npm_config_update_notifier=false` stop
automatic checks. These settings do not change verification for an explicit
`frog --update`.

### Replacement and recovery

The updater does these steps before it replaces the installed executable:

1. Downloads the release asset into memory.
2. Verifies the SHA-256 checksum.
3. Decompresses the release asset in memory.
4. Puts the new executable beside the installed executable.
5. Checks that the new executable reports the expected version.

On macOS and Linux, the updater makes the new executable runnable. It replaces
the installed executable atomically on the same file system.

Windows cannot replace a running `.exe`. Incur starts a background update
process. This process replaces the file after the original process exits. The
command reports the update as staged before the process applies the replacement.

If a download, permission change, decompression, checksum verification, or
version check fails, the installed executable stays usable. If a Windows update
fails after it moves the old executable, the background process tries to
restore it. The backup is in the same directory.

If the background process fails, Incur writes recovery details to
`<executable>.incur-error-<uuid>.txt`. It puts the error file beside the new
executable and any remaining backup. Read the error file. Fix the file system
error. Then run `--update` again. Never disable checksum verification.

## Release action

Copy this workflow to `.github/workflows/binary-release.yml`:

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

The action uses these defaults:

- The entry point is `./src/bin.ts`.
- The CLI name comes from the root `package.json`.
- The version is the stable version in the root `package.json`.
- The release tag is `v<version>`.

Before the action runs project code, it resolves the tag to a commit. It checks
out that commit. It then checks the package version, installs dependencies, and
builds the executables.

The job gives `contents: write` to all steps. Composite action steps share the
job permissions. Use only trusted tags and lockfiles.

`persist-credentials: false` prevents checkout from storing credentials in the
worktree. This setting does not restrict permissions for later steps.

The action:

1. Requires a public repository, an existing `v<package version>` tag, and a matching non-prerelease draft release.
2. Detects npm, pnpm, or Bun.
3. Installs the project dependencies.
4. Uses the pinned Bun version to compile all eight unsigned targets on Linux.
5. Verifies all eight `.gz` release assets against `SHA256SUMS`.
6. Checks the syntax of both installer scripts.
7. Tests the matching Linux glibc executable on the runner.
8. Tests the matching Linux musl executable in Alpine.
9. Uploads the `.gz` release assets, `SHA256SUMS`, `install.sh`, and `install.ps1`.
10. Stops if an upload would replace an existing release asset.

The action tests only Linux executables for the runner architecture. It does not
test other architectures, macOS, or Windows. It does not sign executables.

Keep the release as a draft until the action uploads all release assets. Use this
release procedure:

1. Create the version tag and its matching draft release.
2. Run the action.
3. Review the release assets.
4. Publish the draft release.

The action does not create or publish a release. It does not create or move a
tag. It does not replace existing assets.

Use these inputs only when you must override a default:

- Use `entry` for a different entry point.
- Use `name` for a different executable and asset name.
- Use `release_tag` to select a different version tag.
- Use `package_manager` if Incur cannot detect the package manager.
- Use `pnpm_version` if `package.json` does not specify the pnpm version.
- Use `bun_version` to select the compiler version.
- Use `smoke_command` to pass one safe argument to each tested Linux executable.

A composite action cannot set workflow concurrency. If release jobs can overlap,
set concurrency in the caller workflow. This example runs one binary release at
a time.

### Unsigned executables

`incur build` and the release action create unsigned executables. Unsigned macOS
executables can trigger Gatekeeper warnings. Unsigned Windows executables can
trigger a SmartScreen warning or an enterprise-policy block. Use a separate
release process for each operating system that requires signed executables.

## Unsupported features

Standalone executable support does not include:

- Private-repository authentication for `Binary.github` or the release action.
- Prerelease or named update channels.
- Packages for Homebrew, Scoop, Winget, or other package managers.
- GitHub Release creation, publication, retagging, or versioning.
- Signing identities, notarization credentials, secret storage, or a signing
  service.
- Automatic upload from `incur build`.

Other distribution providers can use the same release asset format. They must
keep the same update checks.
