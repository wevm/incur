# Phased implementation plan: GitHub release installer Worker

> Provide short convenience aliases for shell and PowerShell installers
> published in GitHub Releases.

## Outcome

A stateless Cloudflare Worker redirects a validated public repository path to
that repository's latest or exact stable `install.sh` or `install.ps1` release
asset. The Worker never fetches, proxies, generates, validates, or caches
installer code.

## Current baseline

- Plan baseline: `origin/main` at `7a4c5a7`, with `incur` version `0.4.25`.
- Incur already generates `install.sh` and `install.ps1` with an embedded exact
  release tag.
- Both generated installers download the platform asset and `SHA256SUMS` from
  their embedded exact tag, verify the binary archive, validate `--version`,
  and replace the executable atomically.
- The installer script selected through the mutable latest-release URL is not
  itself checksum-verified before piped execution.
- Current PowerShell tests inspect the generated script and release workflow;
  no Windows CI job executes the generated installer.
- The release action appends both installers to a selected published release.
  Its tag identifies the package version but does not have to use `v<version>`.
- Existing documentation uses direct GitHub latest-release URLs for both
  installer formats.
- The current `wevm/incur` latest release is `incur@0.4.25` and has no assets,
  so it cannot serve as the end-to-end smoke-test fixture.
- The repository has no Worker workspace, Wrangler configuration, Worker test
  project, deployment job, or `incur.app` DNS configuration.

## User stories

- **U1**: Install with
  `curl -fsSL https://incur.app/<org>/<repo> | bash`.
- **U2**: Use a public repository whose latest or selected stable release
  contains Incur-generated installers, without registration or onboarding.
- **U3**: Prove that request input cannot redirect outside the GitHub repository
  selected by the canonical request path.
- **U4**: Test, deploy, observe, smoke-test, and roll back the Worker without
  runtime credentials.
- **U5**: Reach the existing Windows installer with
  `irm https://incur.app/<org>/<repo>/install.ps1 | iex`.
- **U6**: Pin an exact stable release with
  `curl -fsSL https://incur.app/<org>/<repo>@<version> | bash` or its
  `install.ps1` equivalent.

## Fixed architecture

- **Shell routes**: `GET|HEAD https://incur.app/<org>/<repo>` and
  `GET|HEAD https://incur.app/<org>/<repo>@<version>`.
- **PowerShell routes**:
  `GET|HEAD https://incur.app/<org>/<repo>/install.ps1` and
  `GET|HEAD https://incur.app/<org>/<repo>@<version>/install.ps1`.
- **Success response**: `307 Temporary Redirect` to either GitHub's
  `/releases/latest/download/<asset>` path or the selected
  `/releases/download/v<version>/<asset>` path.
- **Asset selection**: the bare route selects `install.sh`; the exact third
  segment `install.ps1` selects `install.ps1`. Never derive an arbitrary asset
  name from request input.
- **Version selection**: an optional unprefixed `@<version>` repository suffix
  selects the conventional lowercase `v<version>` release tag. This route is a
  direct shorthand, not release discovery. Accept only stable `x.y.z`; require
  a direct GitHub URL for other tag formats.
- **Suffix ambiguity**: do not use `/<org>/<repo>.ps1`; that shape collides with
  valid repository names ending in `.ps1`.
- **Repository grammar**: exactly two non-empty ASCII segments matching
  `[A-Za-z0-9_.-]+`, excluding `.` and `..`. The repository segment may have
  one `@<version>` suffix and may be followed by the literal `install.ps1`, on
  the URL visible to the Worker. Limit the organization to 39 characters and
  repository name before the suffix to 100 characters.
- **Normalization boundary**: keep Cloudflare's default RFC 3986 incoming URL
  normalization enabled. It decodes unreserved characters and removes dot
  segments before the Worker; Cloudflare also always merges adjacent slashes.
  The resulting canonical path selects the repository.
- **Rejected input**: trailing or extra segments, remaining percent escapes
  including encoded separators and encoded `@`, backslashes, invalid
  characters, nonempty queries, multiple `@` characters, caller-supplied `v`,
  leading zeros, prerelease versions, build metadata, and version ranges. An
  empty trailing `?` may be removed before Worker invocation and selects the
  same canonical path.
- **Method errors**: return `405` with `Allow: GET, HEAD`.
- **Path errors**: return `404` without revealing whether a GitHub repository
  exists.
- **Error precedence**: validate the canonical path first. Return `404` for an
  invalid path regardless of method, and `405` only for an unsupported method
  on a valid route.
- **Response policy**: return no redirect body and set
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, and a no-index policy. Error bodies are
  plain text.
- **Destination construction**: use a fixed HTTPS GitHub origin and validated
  path segments. Never reuse the request host, scheme, query, or headers.
- **GitHub boundary**: make no GitHub API or release-asset request. GitHub owns
  repository and release existence, latest-release selection, and missing-asset
  errors.
- **Trust boundary**: `incur.app` is a transport alias, not an endorsement.
  Repository owners remain responsible for their scripts and releases.
- **Runtime**: use a private, isolated Worker workspace and the standard Fetch
  API. Add no runtime secret, binding, storage, queue, or background task.
- **Configuration**: keep Wrangler JSONC in source control with a current
  compatibility date, `nodejs_compat`, generated Worker types, production
  observability, disabled production `workers.dev`, and the `incur.app` Custom
  Domain.
- **Deployment**: deploy automatically from `main` only after repository and
  Worker verification passes and an explicit repository variable enables the
  job. Store the least-privilege Cloudflare deployment credential in CI
  secrets.

## Prerequisites

- Own `incur.app`, delegate it at the registrar, and activate its zone in the
  target Cloudflare account. The domain currently has no delegated nameservers.
- Confirm that the apex can be dedicated to this Worker.
- Provision a least-privilege CI credential that can deploy the Worker and
  attach the Custom Domain.
- Select a controlled public repository with a complete Incur binary release
  using a `v<version>` tag for production smoke tests. Do not use the current
  assetless `wevm/incur` release.
- Publish and monitor an abuse-reporting channel before enabling the public
  redirect.

## Phase 1: Serve one safe redirect

**User stories**: U1, U3

### Deliverable

A locally testable Worker returns the exact GitHub `install.sh` redirect for one
valid repository path without contacting an upstream service.

### Work

- Add `workers/installer` as an isolated private workspace without changing the
  published `incur` package surface.
- Add the minimal Fetch handler for a valid `GET /<org>/<repo>`.
- Construct the redirect from a constant GitHub base URL and validated
  repository segments.
- Add a Workers-runtime test project and a TypeScript project reference or
  dedicated type-check command. Wire both into the repository's normal
  verification entrypoint so Worker files cannot bypass root checks.
- Add type generation and a Wrangler bundle dry run to verification.

### Acceptance criteria

- [ ] `GET /wevm/frog` returns `307`.
- [ ] `Location` equals
      `https://github.com/wevm/frog/releases/latest/download/install.sh`.
- [ ] The response has no body and sets `Cache-Control: no-store`.
- [ ] The handler performs no `fetch`, binding access, persistence, or
      background work.
- [ ] Worker-runtime tests, formatting, type checks, and the bundle dry run
      pass locally and in CI.

## Phase 2: Close HTTP and input edges

**User stories**: U2, U3, U4, U5, U6

### Deliverable

The generic resolver supports both generated installer formats and exact stable
versions for every supported repository identifier. It fails closed for
ambiguous paths, unsafe input, and unsupported methods.

### Work

- Apply the full two-segment repository grammar before URL construction.
- Parse an optional `@<version>` suffix after validating the repository name,
  then map strict stable SemVer to a fixed lowercase `v<version>` tag.
- Map the exact optional `install.ps1` segment to a fixed asset allowlist; reject
  every other third segment.
- Treat Cloudflare's canonical path as request identity; do not claim that the
  Worker can inspect a raw path that Cloudflare normalized before invocation.
- Add `HEAD` behavior with the same status and headers as `GET`.
- Add uniform `404` and `405` responses with the agreed headers.
- Reject path encodings and URL shapes that could alter the destination.
- Add adversarial Worker-runtime cases for missing repository segments,
  separators that remain after normalization, encoded separators, remaining
  percent escapes, backslashes, Unicode, control or CRLF input, queries, extra
  segments, origin escape, and header injection.
- Add deployed edge cases that pin Cloudflare's behavior for dot segments,
  unreserved percent encodings, and adjacent slashes before Worker invocation.
- Send a deployed backslash case with a client mode that preserves the raw
  request target.

### Acceptance criteria

- [ ] Supported mixed-case identifiers and allowed punctuation preserve their
      exact path representation in `Location`.
- [ ] `GET /wevm/frog/install.ps1` returns a bodyless `307`.
- [ ] Its `Location` equals
      `https://github.com/wevm/frog/releases/latest/download/install.ps1`.
- [ ] `GET /wevm/frog@1.2.3` redirects to
      `https://github.com/wevm/frog/releases/download/v1.2.3/install.sh`.
- [ ] `GET /wevm/frog@1.2.3/install.ps1` redirects to
      `https://github.com/wevm/frog/releases/download/v1.2.3/install.ps1`.
- [ ] The exact-version routes reject `@v1.2.3`, incomplete versions, leading
      zeros, prerelease or build suffixes, ranges, encoded `@`, and multiple
      `@` characters.
- [ ] `GET /wevm/install.ps1` still selects `install.sh` for the repository
      named `install.ps1`; `/wevm/install.ps1/install.ps1` selects its PowerShell
      installer.
- [ ] `/wevm/frog/install.sh`, `/wevm/frog/other`, and
      `/wevm/frog/install.ps1/extra` return `404`.
- [ ] `HEAD` on a valid route returns its redirect headers with no body; `HEAD`
      on an invalid path returns `404` without `Location`.
- [ ] Unsupported methods return `405` and `Allow: GET, HEAD`.
- [ ] Canonical paths with missing repository segments, trailing slashes, extra
      segments, encoded separators, remaining percent escapes, backslashes,
      Unicode, control characters, invalid characters, or nonempty queries
      return `404` without a `Location` header.
- [ ] An unsupported method on an invalid path returns `404`; the same method on
      any valid installer route returns `405`.
- [ ] Unreserved percent encodings, dot segments, and adjacent slashes resolve
      only to the repository selected by Cloudflare's documented canonical
      path, with production behavior covered by non-executing tests.
- [ ] All error responses use plain text, `Cache-Control: no-store`, and
      `X-Content-Type-Options: nosniff`.
- [ ] Tests prove that request data cannot change the destination scheme, host,
      suffix, headers, or query.
- [ ] Valid but nonexistent repositories still receive the deterministic
      GitHub redirect, avoiding an API preflight race.

## Phase 3: Publish on `incur.app`

**User stories**: U1, U4, U5, U6

### Deliverable

The verified Worker runs at the production apex with source-controlled
configuration, gated deployment, observability, smoke checks, and rollback
instructions.

### Work

- Define the Worker entrypoint, compatibility settings, generated types,
  observability sampling, disabled production `workers.dev`, and Custom Domain
  in Wrangler JSONC.
- Verify that the zone uses RFC 3986 incoming URL normalization and record that
  setting in the deployment runbook.
- Add a production deployment job after existing verification on `main`.
- Authenticate deployment with scoped `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` CI secrets.
- Keep Worker deployment independent from npm package publication.
- Add a post-deploy smoke check that inspects the first response without
  following or executing the installer.
- Document how to inspect the active version and roll back to the previous
  deployment.

### Acceptance criteria

- [ ] Wrangler configuration validates against its installed schema.
- [ ] Worker environment types are generated from configuration rather than
      maintained by hand.
- [ ] Pull requests run checks and a bundle dry run but cannot deploy
      production.
- [ ] A `main` deployment starts only after all required checks pass.
- [ ] CI deployment credentials are unavailable to the Worker at runtime.
- [ ] The registrar delegates `incur.app` to the active Cloudflare zone; the
      Custom Domain creates the DNS record and certificate after any conflicting
      CNAME is removed.
- [ ] The active zone's URL normalization setting matches the tested RFC 3986
      path contract.
- [ ] `https://incur.app` resolves with a valid certificate.
- [ ] The production smoke check confirms the exact `307`, `Location`, and
      cache policy for latest and exact-version installer routes, plus
      representative `404` and `405` responses.
- [ ] Workers observability records invocation failures without application
      logs copying request headers or query strings.
- [ ] The rollback procedure is tested against a non-production version before
      enabling automatic production deployment.

## Phase 4: Adopt the shortcut

**User stories**: U1, U2, U4, U5, U6

### Deliverable

The short commands become the documented Unix and Windows installation paths,
with direct GitHub fallbacks and an explicit explanation of their security
boundary.

### Work

- Update the primary standalone-binary documentation and README example.
- Retain the direct GitHub latest-asset URLs for transparency and recovery.
- Document the unprefixed `@<version>` syntax and equivalent direct GitHub
  exact-tag URLs for both installer formats.
- Explain that the short exact-version route targets `v<version>` directly and
  cannot discover releases that use another tag format.
- Explain that the redirect selects only the generated installer, which then
  uses its embedded exact tag for binary and checksum downloads.
- Explain that the downloaded installer script is not covered by that checksum;
  the checksum covers the binary archive that the script subsequently downloads.
- Recommend GitHub immutable releases and distinguish checksum integrity from
  publisher identity and release attestation.
- Document download-inspect-execute alternatives for readers who do not want to
  pipe network content directly into a shell or `Invoke-Expression`.
- State that piped execution can obscure download or installation failures; do
  not use either short command as a CI success check.
- Add a non-executing production smoke check that follows the redirect for the
  controlled repository and validates both complete installer downloads.

### Acceptance criteria

- [ ] Documentation shows
      `curl -fsSL https://incur.app/<org>/<repo> | bash`.
- [ ] Documentation shows
      `irm https://incur.app/<org>/<repo>/install.ps1 | iex`.
- [ ] Documentation shows
      `curl -fsSL https://incur.app/<org>/<repo>@1.2.3 | bash`.
- [ ] Documentation shows
      `irm https://incur.app/<org>/<repo>@1.2.3/install.ps1 | iex`.
- [ ] Documentation includes the direct
      `https://github.com/<org>/<repo>/releases/latest/download/install.sh`
      fallback.
- [ ] Documentation includes the direct
      `https://github.com/<org>/<repo>/releases/latest/download/install.ps1`
      fallback.
- [ ] Documentation includes direct
      `/releases/download/v1.2.3/install.sh` and `install.ps1` fallbacks.
- [ ] Documentation states that `incur.app` does not certify or endorse the
      named repository.
- [ ] Documentation explains mutable latest selection, exact-tag installer
      downloads, checksum scope, and immutable-release protection.
- [ ] Documentation includes copy-ready download-inspect-execute flows for both
      installer formats.
- [ ] Documentation does not claim that either pipeline's exit status proves
      the download or installation succeeded.
- [ ] CI never executes remotely downloaded installer code.
- [ ] The controlled-repository smoke check confirms that each short URL and
      its direct GitHub fallback resolve to the same complete generated
      installer.

## Non-goals

- Repository registration, allowlists, ownership proofs, or endorsements.
- GitHub API validation, private repositories, or authenticated downloads.
- Proxying, rewriting, generating, or caching installer contents.
- Prerelease-channel or additional installer-format routes.
- Arbitrary release-tag aliases or semantic release discovery.
- Binary signing, notarization, or release-attestation verification.
- Changes to Incur's builder, installer template, updater, release format, or
  release action.
- New end-to-end execution coverage for the generated PowerShell installer.
- Serving a website or other application routes from `incur.app`.
- Raw-path WAF policy for rejecting alternate spellings before Cloudflare URL
  normalization.

## Final verification

- Run repository formatting, linting, type checks, and existing tests.
- Run Worker-runtime tests with the production compatibility configuration.
- Validate Wrangler configuration and generate Worker types.
- Build the exact deployment bundle used by CI.
- Inspect the final diff for accidental published-package changes.
- Exercise the production latest, exact-version, invalid, and
  unsupported-method routes.
- Follow the controlled latest and exact-version redirects without executing
  either response.
- Confirm observability and rollback behavior.

## References

- [GitHub latest-release asset links](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [Cloudflare Worker redirects](https://developers.cloudflare.com/workers/examples/redirect/)
- [Cloudflare Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare URL normalization](https://developers.cloudflare.com/rules/normalization/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
