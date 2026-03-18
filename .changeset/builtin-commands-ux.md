---
"incur": patch
---

Fixed built-in commands (`skills`, `mcp`) showing root command errors when invoked without subcommand. Bare `skills`/`mcp` and `--help` now show their own help with available subcommands. Added built-in commands to shell completions. Fixed skill name sanitization for CLI names containing dots.
