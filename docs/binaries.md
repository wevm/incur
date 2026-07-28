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

## Release pipeline

[The example release workflow](../examples/binary-release.yml) is a template,
not an active workflow in this repository. Copy it into the CLI project's
`.github/workflows/` directory, then customize the entrypoint, binary name, and
representative smoke command at the top.

The example:

1. Requires a public repository, an existing `v<package version>` tag, and a
   draft release for that exact tag.
2. Builds the canonical target matrix with one pinned Bun version.
3. Transfers only `.gz` assets between jobs and restores Unix executable mode
   after decompression.
4. Verifies checksums and smoke-tests all eight targets on native-architecture
   Linux, macOS, and Windows runners, using Alpine containers for musl.
5. Exposes optional macOS and Windows signing hooks backed by caller-managed
   secrets.
6. Repeats native ARM64 and x64 smoke tests on the final macOS and Windows
   assets after the optional signing hooks.
7. Optionally attests the final compressed assets.
8. Uploads assets and `SHA256SUMS` without `--clobber` to the existing,
   version-matched release.

The workflow requires the release to remain a draft until every asset is
uploaded. It deliberately does not create a release, publish a draft, move or
create a tag, or replace existing assets. A common release flow is to create the
version tag and matching draft through an existing release process, run the
binary workflow, review its assets, then publish the draft separately.

The hosted Windows ARM64 runner is a public preview. Replace preview labels with
equivalent self-hosted runners if the release requires a runner covered by a
different support policy. Cross-compilation alone is not a substitute for
native execution before a high-impact release.

GitHub Actions does not retain the executable bit when transferring a raw file
as a workflow artifact. The example transfers compressed assets, decompresses
them on the native runner, and applies `chmod +x` before execution.

### Unsigned development builds

`incur build` produces unsigned executables. They are suitable for local
development and native smoke testing. Publicly distributed unsigned macOS and
Windows builds can trigger Gatekeeper, SmartScreen, or enterprise policy
warnings, so production releases should use the project owner's signing
identity.

Signing modifies executable bytes. Always sign the raw executable first, then
recompress it and regenerate `SHA256SUMS`. The GitHub Release digest will then
cover the final signed asset selected by `Binary.github`.

### macOS signing and notarization

The macOS hook in the example imports a caller-provided Developer ID
Application certificate, signs both binaries with the hardened runtime and
Bun's runtime entitlements, verifies each signature, and submits a ZIP container
to Apple's notary service with `notarytool`.

Review the entitlements against the pinned Bun version before every release.
The example follows [Bun's compiled-executable signing guidance](https://bun.sh/docs/guides/runtime/codesign-macos-executable).
Apple requires `--options runtime` for a Developer ID main executable and
documents the notarization flow in
[Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Apple can issue a ticket for a standalone executable but cannot staple that
ticket to the executable. Gatekeeper retrieves it online. If offline stapling
is required, distribute a supported signed container instead and adapt the
asset contract deliberately.

The example expects these GitHub Actions secrets when macOS signing is enabled:

- `APPLE_CERTIFICATE_P12_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

### Windows signing

The Windows hook imports a caller-provided PFX only for the signing step. It
uses Authenticode with SHA-256, requests an RFC 3161 SHA-256 timestamp, verifies
the resulting signature, then recompresses the executable.

The example expects these secrets when Windows signing is enabled:

- `WINDOWS_CERTIFICATE_PFX_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`
- `WINDOWS_TIMESTAMP_URL`

Review the commands against Microsoft's
[SignTool documentation](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).
Signing keys, certificate procurement, hardware-backed signing services, and
timestamp-service availability remain the caller's responsibility.

### Attestations

The optional attestation step uses `actions/attest` on the final compressed
assets after signing and checksum regeneration. It requires `id-token: write`
`attestations: write`, and `artifact-metadata: write`. GitHub Free, Pro, and
Team plans support artifact attestations for public repositories;
private-repository support has different plan requirements.

See [GitHub's artifact attestation guide](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Scope

Binary support does not provide:

- GitHub authentication for private repositories.
- Prerelease or named update channels.
- Homebrew, Scoop, Winget, or other package-manager formulas.
- An initial-install shell or PowerShell script.
- GitHub Release creation, publication, retagging, or versioning.
- Signing identities, notarization credentials, secret storage, or a signing
  service.
- Automatic upload from `incur build`.
- Runtime target or libc guessing.

Initial installation and alternate distribution providers can be layered on the
same stable asset contract without weakening the update path.
