---
'incur': patch
---

Fixed `mcp add` registering Amp: `--no-global` now writes `.amp/settings.json` in the working directory instead of the global settings, invalid Amp settings fail before any agent is configured instead of reporting success, an existing entry keeps its other fields such as `env` and `disabled`, and `--json` or `--format` prints only the result.
