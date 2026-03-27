---
"incur": minor
---

Add custom global options support via `globals` and `globalAlias` on `Cli.create()`. Global options are parsed before command resolution, available in middleware via `c.globals`, and rendered in `--help`, `--llms`, `--schema`, and shell completions.
