---
'incur': patch
---

Fixed `mcp add` so a missing, blank, or option-shaped value for `--agent`, `--command`, or `-c` fails with `Missing value for flag` instead of being ignored or swallowing the next flag. These options now also accept `--flag=value`.
