---
'incur': patch
---

Fixed `--update` failing with `spawn npm ENOENT` on Windows, where npm and pnpm are script shims that `execFile` cannot launch.
