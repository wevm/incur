---
'incur': patch
---

Fixed `mcp add` failing on Windows with `spawn npx ENOENT`. Package runners installed as `.cmd` scripts (`npx`, `pnpx`) now run through `cmd.exe` with each argument escaped, so the registered command reaches `add-mcp` intact. Native executables and other platforms are spawned as before.
