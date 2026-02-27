---
"incur": patch
---

Replaced `npx skills add` subprocess with native skill installation. Skills are now installed directly via filesystem operations (copy to canonical `.agents/skills/` + symlink for non-universal agents), removing the runtime dependency on npm/npx and the `vercel-labs/skills` package. Removed `runner` option from `sync.Options`. Added per-agent install paths to `skills add --verbose` output.
