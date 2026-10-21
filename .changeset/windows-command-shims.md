---
'incur': patch
---

Fixed Windows command execution for `mcp add` and `--update`. Package-manager commands such as `npx`, `npm`, and `pnpm` are `.cmd`/`.bat` shims on Windows, and `node:child_process.execFile` cannot launch command scripts without a shell, so those commands failed with `spawn npx ENOENT` before any agent configuration was written. They now run through `cross-spawn`, which resolves command shims and preserves argument boundaries.
