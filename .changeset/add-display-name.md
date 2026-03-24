---
"incur": patch
---

Added `displayName` to the run and middleware context. Resolves the actual binary name from `process.argv[1]` so user-facing messages reflect the alias used to invoke the CLI.
