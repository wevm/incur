# Plan: Cross-Platform Binaries

> Source PRD: Conversation-approved design for building and updating standalone Incur CLIs through GitHub Releases.

## User stories

- **US1**: As a CLI maintainer, I can build a runnable standalone binary without changing how npm consumers use my CLI.
- **US2**: As a release maintainer, I can produce deterministic assets for supported macOS, Linux, and Windows targets.
- **US3**: As a macOS or Linux binary user, I receive update notices and can securely update the installed executable.
- **US4**: As a Windows binary user, I can securely update the installed executable despite Windows file-locking semantics.
- **US5**: As a release maintainer, I can validate, sign, attest, and publish binary assets without giving Incur control of release credentials.
- **US6**: As an npm, pnpm, or Bun package user, binary support does not change package-manager update behavior.

## Architectural decisions

Durable decisions that apply across all phases:

- **Build interface**: `incur build <entry>` is the public build command. Bun is the compiler and must be available while building, but it does not become a runtime dependency for ordinary Incur users.
- **Runtime provider**: `Binary.github({ repository })` adapts GitHub Releases to Incur's existing update-check and installation callbacks. It activates only when embedded binary metadata is present, preserving package-manager updates for package installations.
- **Target identity**: Every artifact embeds one canonical target identifier at build time. The updater never guesses libc or CPU compatibility from the runtime environment.
- **Default targets**: The supported matrix is `darwin-arm64`, `darwin-x64`, `linux-arm64-glibc`, `linux-x64-glibc-baseline`, `linux-arm64-musl`, `linux-x64-musl-baseline`, `windows-arm64`, and `windows-x64-baseline`.
- **Asset contract**: Release assets use stable names of `<name>-<target>.gz`, with `.exe.gz` for Windows. Each artifact is associated with a SHA-256 digest.
- **Release selection**: The GitHub provider considers published, non-draft, stable semantic versions and selects the highest version newer than the running binary. Prerelease channels are deferred.
- **Integrity**: A binary is never executed or installed until its GitHub Release asset digest has been verified. Missing or mismatched digests are hard failures.
- **Replacement safety**: Unix updates use a same-filesystem atomic replacement. Windows updates use a detached handoff after the running executable exits. Every failure leaves the previously installed executable usable.
- **Distribution boundary**: GitHub Releases are the initial binary source. Private repositories, Homebrew, Scoop, initial-install scripts, and other release providers are outside this plan.
- **Release boundary**: Incur can build, package, validate, and describe signing hooks. Native signing, notarization, secret management, release creation, and asset publication remain the caller's responsibility.

---

## Phase 1: Build One Standalone Binary

**User stories**: US1, US6

### What to build

Add the smallest complete build path for the current host. A maintainer supplies an Incur CLI entrypoint and receives a runnable standalone executable, its compressed release asset, checksum metadata, and embedded version and target identity. Existing source and package executions continue using their current behavior.

### Acceptance criteria

- [ ] `incur build <entry>` resolves the CLI name and version from project metadata, with explicit overrides for ambiguous projects.
- [ ] The command fails with an actionable error when Bun, the entrypoint, the name, or the version cannot be resolved.
- [ ] The output contains a runnable current-host executable, a correctly named compressed asset, and its SHA-256 digest.
- [ ] The executable embeds the canonical current-host target rather than deriving it during an update.
- [ ] Running the executable with `--help`, `--version`, and one representative command produces the same observable CLI behavior as the source entrypoint.
- [ ] Building does not modify the source project, install anything globally, publish assets, or require release credentials.
- [ ] Package installations continue to use npm, pnpm, or Bun update behavior and do not activate the GitHub binary provider.
- [ ] Focused tests cover input discovery, overrides, output naming, metadata embedding, compression, checksum generation, and a real compiled-binary smoke test.

---

## Phase 2: Build the Release Matrix

**User stories**: US2, US6

### What to build

Expand the current-host path into a deterministic release build. One invocation produces the default target matrix or an explicitly selected subset while preserving a single artifact naming and metadata contract for the future updater.

### Acceptance criteria

- [ ] The default invocation builds all eight supported target identifiers.
- [ ] A maintainer can select one or more targets without changing the resulting asset conventions.
- [ ] Public target identifiers map unambiguously to Bun compile targets, including baseline x64 and Linux libc variants.
- [ ] Windows assets include `.exe` before compression; non-Windows assets are marked executable when unpacked.
- [ ] Repeated builds from identical source, version, target, and compiler inputs produce the same asset layout and metadata shape.
- [ ] Each target receives its own embedded target identifier and SHA-256 digest.
- [ ] A failure for any requested target makes the build fail and clearly identifies the target; partial output is not reported as a successful release set.
- [ ] Tests compile representative binaries from every operating-system family, inspect embedded metadata and executable formats, and run native targets where the test host permits.
- [ ] Documentation lists the supported matrix, target-selection syntax, CPU compatibility policy, output layout, and expected artifact sizes.

---

## Phase 3: Update macOS and Linux Binaries

**User stories**: US3, US6

### What to build

Connect compiled Unix artifacts to public GitHub Releases through the binary update provider. Automatic checks use the existing detached cache path, and explicit `--update` downloads, verifies, validates, and atomically installs the asset matching the embedded target.

### Acceptance criteria

- [ ] `Binary.github({ repository })` returns an update provider compatible with the existing CLI update contract.
- [ ] Outside an Incur-built artifact, the adapter does not override inferred package-manager behavior.
- [ ] The checker considers only published, non-draft releases with valid stable semantic versions and returns the highest newer version.
- [ ] An equal version, older release, malformed tag, prerelease, missing target asset, or unsupported target does not produce an update notice.
- [ ] The installer resolves the exact selected release and exact embedded-target asset rather than relying on a mutable latest-download URL.
- [ ] The installer requires and verifies a SHA-256 digest before decompressing or executing downloaded content.
- [ ] The candidate executable is staged beside the installed executable, marked executable, and checked for the expected version before replacement.
- [ ] A successful macOS or Linux update atomically replaces the executable and leaves no temporary or backup files.
- [ ] Network, permission, decompression, digest, version-validation, and replacement failures preserve the existing executable and return an actionable `UPDATE_FAILED` error.
- [ ] Automatic checks remain cached, detached, silent in structured output, and suppressible through the existing update-notifier controls.
- [ ] Tests use controlled release metadata and downloads to cover release ordering, asset selection, redirects, digest failures, interrupted downloads, atomic replacement, rollback, and the next invocation of the updated binary.

---

## Phase 4: Update Windows Binaries Safely

**User stories**: US4, US6

### What to build

Extend the same GitHub provider contract to Windows. Because the running executable cannot replace itself, installation stages the verified candidate and starts a detached apply process that waits for the original invocation to exit before completing the replacement.

### Acceptance criteria

- [ ] Windows release checks select assets using the embedded `windows-arm64` or `windows-x64-baseline` target.
- [ ] The parent process downloads, verifies, decompresses, and validates the candidate before starting the apply handoff.
- [ ] The apply process waits for the originating process to exit before replacing the installed `.exe`.
- [ ] A successful handoff installs the expected version and removes staged and backup files on the next safe opportunity.
- [ ] Failed validation or handoff leaves the old executable usable and reports enough state for a later retry.
- [ ] Internal apply arguments cannot be mistaken for user commands and reject incomplete, malformed, or inconsistent replacement state.
- [ ] Package-manager installations on Windows remain routed through their package manager.
- [ ] Unit tests cover handoff state transitions, stale state, cleanup, retries, and rollback.
- [ ] A native Windows x64 test builds two fixture versions and verifies an end-to-end update followed by a successful invocation of the new executable.
- [ ] Windows ARM64 artifacts receive compile-format validation and native smoke coverage when an appropriate runner is available.

---

## Phase 5: Harden the Release Pipeline

**User stories**: US2, US5

### What to build

Provide a release recipe that builds the canonical matrix, validates artifacts on native hosts, exposes platform-signing boundaries, generates provenance where requested, and uploads only approved assets to an existing GitHub Release.

### Acceptance criteria

- [ ] The documented workflow builds the canonical target matrix and transfers Unix executables without losing permissions.
- [ ] Native jobs smoke-test supported artifacts with `--help`, `--version`, and a representative command before release upload.
- [ ] The macOS path provides hook points for Developer ID signing, required Bun runtime entitlements, signature verification, and notarization.
- [ ] The Windows path provides hook points for Authenticode signing, timestamping, and signature verification.
- [ ] Signing and notarization steps consume caller-managed secrets and are skipped explicitly when not configured; Incur never stores or requests credentials.
- [ ] Optional GitHub artifact attestations can be generated for the final compressed release assets.
- [ ] Only assets that passed build, integrity, native smoke, and configured signing checks are eligible for upload.
- [ ] The workflow uploads to an existing version-matched GitHub Release and does not silently create, retag, or publish a release.
- [ ] Documentation covers unsigned development builds, production signing responsibilities, public-repository requirements, update behavior, recovery from a failed update, and scope exclusions.
- [ ] End-to-end release tests verify artifact names and digests agree with what the runtime provider selects.
