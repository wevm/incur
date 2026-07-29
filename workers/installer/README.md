# Installer redirect Worker

This private workspace serves the open `incur.app` convenience redirect. It
does not change the published `incur` package.

## Contract

| Request                                         | Response                               |
| ----------------------------------------------- | -------------------------------------- |
| `GET\|HEAD /<org>/<repo>`                       | `307` to GitHub's latest `install.sh`  |
| `GET\|HEAD /<org>/<repo>/install.ps1`           | `307` to GitHub's latest `install.ps1` |
| `GET\|HEAD /<org>/<repo>@<version>`             | `307` to exact-tag `install.sh`        |
| `GET\|HEAD /<org>/<repo>@<version>/install.ps1` | `307` to exact-tag `install.ps1`       |
| Invalid canonical path                          | `404` without `Location`               |
| Other method on a valid path                    | `405` with `Allow: GET, HEAD`          |

`<version>` is an unprefixed stable semantic version such as `1.2.3`. The
Worker maps it directly to the conventional release tag `v1.2.3`; it does not
search releases by package version. Repositories using another tag format need
the direct GitHub URL. The Worker rejects prerelease versions, build metadata,
ranges, leading zeros, and a caller-supplied `v`.

The Worker constructs every destination from a fixed `https://github.com`
origin and fixed asset names. It makes no upstream request and has no runtime
binding, secret, storage, cache, or background task.

The route is not a repository registry. A redirect does not mean that Incur
generated, reviewed, certified, or endorsed the selected installer.

## Local verification

Install workspace dependencies, then run:

```sh
pnpm worker:types
pnpm check:worker
pnpm test:worker
```

Regenerate `worker-configuration.d.ts` after any Wrangler configuration change.
The check command rejects stale types and builds the deployment bundle without
uploading it.

Start a local Worker with:

```sh
pnpm --filter @incur/installer-worker dev
```

## Production prerequisites

Complete these prerequisites before enabling deployment:

- Activate the owned `incur.app` zone in the target Cloudflare account.
- Dedicate the apex to this Worker and remove any conflicting CNAME.
- Keep incoming URL normalization enabled with the RFC 3986 setting.
- Select a controlled repository with complete `install.sh` and `install.ps1`
  assets on its latest `v<version>` release.
- Publish and monitor an abuse-reporting channel for the service.
- Create the protected GitHub environment `incur.app`.

Store `CLOUDFLARE_ACCOUNT_ID` and a scoped `CLOUDFLARE_API_TOKEN` in that
environment. Limit the token to Workers Scripts write access in the target
account.

Set these repository variables only after the prerequisites are complete:

| Variable                           | Value                   |
| ---------------------------------- | ----------------------- |
| `INCUR_INSTALLER_DEPLOY_ENABLED`   | `true`                  |
| `INCUR_INSTALLER_SMOKE_REPOSITORY` | A controlled `org/repo` |

The `main` workflow deploys only in `wevm/incur`, after verification, and while
the enable variable is `true`. The npm publication job remains independent.

Cloudflare creates the Custom Domain's DNS record and certificate during the
first deployment. See the
[Custom Domains guide](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
for current prerequisites.

## Smoke test

The post-deploy smoke test uses `curl --path-as-is` without following first-hop
redirects. It checks the latest and discovered exact-version routes, method
handling, encoded separators, and edge normalization.

After validating each exact `Location`, the test downloads both installer
formats through the latest and exact GitHub URLs. It checks their generated
structure, equality, and shell syntax without executing either installer.

Run it manually with:

```sh
INCUR_INSTALLER_SMOKE_REPOSITORY=org/repo pnpm worker:smoke
```

Set `INCUR_INSTALLER_SMOKE_ORIGIN` only when checking another HTTPS hostname.

A bare empty query delimiter can be removed before the Worker. It therefore
behaves like the same canonical path. Every nonempty query is rejected.

## Observability and rollback

Wrangler enables Workers observability without application logging. Restrict
dashboard access and retention because platform invocation metadata can still
contain request paths and queries.

Inspect deployments and roll back with the pinned Wrangler version:

```sh
pnpm --filter @incur/installer-worker exec wrangler deployments list
pnpm --filter @incur/installer-worker exec wrangler rollback <VERSION_ID>
INCUR_INSTALLER_SMOKE_REPOSITORY=org/repo pnpm worker:smoke
```

The Worker has no runtime denylist. To stop an abusive path immediately, use a
Cloudflare security rule or detach the Custom Domain, then ship a reviewed code
change if the block should remain.
