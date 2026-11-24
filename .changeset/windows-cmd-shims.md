---
'incur': patch
---

Fixed `mcp add` and `--update` failing on Windows with `spawn npx ENOENT` or `spawn npm ENOENT`. Package-manager commands installed as `.cmd` scripts (`npm`, `npx`, `pnpm`, `pnpx`) now run through `cmd.exe` with each argument quoted so it reaches the script intact.
