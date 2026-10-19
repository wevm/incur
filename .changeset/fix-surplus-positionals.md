---
'incur': patch
---

Reject unexpected positional arguments instead of silently discarding them. A final array argument still collects remaining positionals, and `--` treats following tokens as positional values.
A `true`/`false` token after a command boolean flag is taken as the flag's value only when no positional slot remains; global boolean flags still take `--flag=false` or `--no-flag`.
