---
"incur": patch
---

Fixed missing value errors for flags in `Fetch.parseArgv`, short secret leaking in `redact()`, silent `jsonl` fallthrough in `Formatter.format`, invalid `--format`/`--token-limit`/`--token-offset` values, lost descriptions when coercing OpenAPI param schemas, and hardcoded `process.env` in `Help.ts` for Deno compatibility.
