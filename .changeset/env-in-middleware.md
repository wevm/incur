---
"incur": patch
---

Added `c.env` to middleware context. CLI-level `env` schema defined on `Cli.create()` is now parsed before middleware runs and available as typed `c.env` in both `.use()` and per-command `middleware: [...]` handlers. This enables initializing shared dependencies (API clients, auth tokens) in middleware using validated environment variables instead of reading `process.env` directly.
