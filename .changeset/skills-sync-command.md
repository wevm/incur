---
'incur': minor
---

Added `sync.command`, which sets the command that generated `SKILL.md` files show in place of the CLI name, such as `bunx @scope/my-cli` (like `mcp.command` for `mcp add`). The command appears in headings, examples, the `command` frontmatter, and "Run `… --help`" descriptions. `requires_bin` becomes its first word, for example `bunx`. Skill names and install directories still derive from the CLI name.
