---
'incur': minor
---

**Breaking:** Unexpected positional arguments now fail with `Unexpected argument: <value>` before the command runs, instead of being silently dropped. This covers commands without `args`, callable group roots, and HTTP path segments past a command's args (which now respond with an `UNKNOWN` error). A final array argument still collects the remaining positionals.

A `true` or `false` after a command's boolean flag (`--dry-run false`) is now the flag's value when no positional slot is left for it, instead of being ignored with the flag set to `true`. When the command still has a positional slot, the token fills it as before; `--flag=false` and `--no-flag` are unambiguous. Global boolean flags do not read a spaced value, so `--global-flag true` after a command now fails as an unexpected argument.

Added `--` to end command option parsing: every following token is positional, even when it looks like a flag. Built-in flags such as `--json` are still read anywhere in argv.
