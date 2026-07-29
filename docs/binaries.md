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

Pass `--tag` when the assets will use a release tag other than `v<version>`:

```sh
pnpm exec incur build ./src/bin.ts \
  --installer \
  --repository wevm/frog \
  --tag frog@1.2.3
```

To generate installers:

- Use a stable semantic version.
- Build all default targets.

The command adds `install.sh` and `install.ps1` to `dist/binaries/`. Each
installer contains the exact release tag. A latest-release URL selects only the
installer. The installer downloads its executable and `SHA256SUMS` from the
tagged release.

After the release action appends the assets and the `incur.app` service is
enabled, users can install the latest stable release through the short URLs:

```sh
curl -fsSL https://incur.app/wevm/frog | bash
```

```powershell
irm https://incur.app/wevm/frog/install.ps1 | iex
```

For a repository whose release uses the conventional `v<version>` tag, append
an unprefixed stable semantic version to install that exact release:

```sh
curl -fsSL https://incur.app/example/my-cli@1.2.3 | bash
```

```powershell
irm https://incur.app/example/my-cli@1.2.3/install.ps1 | iex
```

The exact-version route accepts only `x.y.z`. Do not include the tag's `v`
prefix. It maps directly to `v<version>` and does not search releases by package
version. Prerelease versions, build metadata, and ranges are not supported.

`incur.app` returns a temporary redirect to the named repository's fixed
`install.sh` or `install.ps1` asset. A bare repository selects GitHub's latest
release; `@1.2.3` selects the exact `v1.2.3` release. The service does not proxy
or inspect the script.

When a repository uses another tag format, use that exact GitHub tag directly.
For example, the `frog@1.2.3` tag uses:

```sh
curl -fsSL https://github.com/wevm/frog/releases/download/frog@1.2.3/install.sh | bash
```

```powershell
irm https://github.com/wevm/frog/releases/download/frog@1.2.3/install.ps1 | iex
```

The redirect is open to any syntactically valid GitHub repository path. Incur
does not verify that the repository uses Incur, certify its publisher, or
endorse its contents.

Use the direct GitHub URLs if the shortcut is unavailable:

```sh
curl -fsSL https://github.com/wevm/frog/releases/latest/download/install.sh | bash
```

```powershell
irm https://github.com/wevm/frog/releases/latest/download/install.ps1 | iex
```

The equivalent direct exact-tag URLs are:

```sh
curl -fsSL https://github.com/example/my-cli/releases/download/v1.2.3/install.sh | bash
```

```powershell
irm https://github.com/example/my-cli/releases/download/v1.2.3/install.ps1 | iex
```

An exact-version alias pins the tag name, not immutable bytes. A repository
owner can replace a tag, its assets, and its checksum file together. Enable
[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
to prevent changes after publication. Without this setting, the checksum
verifies only the current release asset. It does not prove that the asset never
changed.

Both latest and exact-version URLs select an installer script. That script is
not covered by `SHA256SUMS` before execution. The generated installer uses its
embedded exact tag and verifies the binary archive that it downloads afterward.

Download and inspect the shell installer before execution when the repository
or release is not already trusted:

```sh
(
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://incur.app/wevm/frog -o "$installer" &&
    less "$installer" &&
    bash "$installer"
)
```

Use the equivalent PowerShell flow on Windows:

```powershell
$installer = Join-Path ([IO.Path]::GetTempPath()) "frog-install-$([guid]::NewGuid()).ps1"
try {
  irm https://incur.app/wevm/frog/install.ps1 -OutFile $installer -ErrorAction Stop
  Get-Content $installer
  & $installer
} finally {
  Remove-Item $installer -ErrorAction SilentlyContinue
}
```

Do not use a piped installer command as a CI success check. A pipeline can hide
the downloader's failure status, and it executes network content before review.

GitHub documents the stable
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
      - id: release
        uses: wevm/incur/release@v1
```

The action uses these defaults:

- The entry point is `./src/bin.ts`.
- The CLI name comes from the root `package.json`.
- The version is the stable version in the root `package.json`.
- The release is the latest published GitHub release.

Before the action runs project code, it reads the package version from the
triggering commit and resolves the latest published release. It verifies that
the release tag identifies that package version, then checks out the tagged
commit, installs dependencies, and builds the executables.

The job gives `contents: write` to all steps. Composite action steps share the
job permissions. Use only trusted source and lockfiles.

`persist-credentials: false` prevents checkout from storing credentials in the
worktree. This setting does not restrict permissions for later steps.

Run the action from a trusted push or manual workflow. The action rejects pull
request merge refs.

The action:

1. Requires a public repository and a stable package version.
2. Resolves the latest mutable published release for that package version.
3. Detects npm, pnpm, or Bun.
4. Installs the project dependencies.
5. Uses the pinned Bun version to compile all eight unsigned targets on Linux.
6. Verifies all eight `.gz` release assets against `SHA256SUMS`.
7. Checks the syntax of both installer scripts.
8. Tests the matching Linux glibc executable on the runner.
9. Tests the matching Linux musl executable in Alpine.
10. Uploads the `.gz` release assets, `SHA256SUMS`, `install.sh`, and `install.ps1`.
11. Stops if an upload would replace an existing release asset.

The action tests only Linux executables for the runner architecture. It does not
test other architectures, macOS, or Windows. It does not sign executables.

With `changesets/action@v1`, keep the default `createGithubReleases: true`. Run
Incur after Changesets reports a publication. Incur appends binary assets to the
release that Changesets published, including workspace releases tagged
`<package>@<version>`.

A published release is visible before its binaries are ready. A failed build can
leave the release incomplete. Immutable releases cannot accept new assets.

Use these inputs only when you must override a default:

- Use `entry` for a different entry point.
- Use `name` for a different executable and asset name.
- Use `release_tag` to select an existing release instead of the latest published release.
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
- GitHub Release publication, retagging, or package version management.
- Signing identities, notarization credentials, secret storage, or a signing
  service.
- Automatic upload from `incur build`.

Other distribution providers can use the same release asset format. They must
keep the same update checks.
