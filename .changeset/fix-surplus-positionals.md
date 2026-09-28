---
'incur': patch
---

Reject unexpected positional arguments instead of silently discarding them. A final array argument still collects remaining positionals, and `--` treats following tokens as positional values.
