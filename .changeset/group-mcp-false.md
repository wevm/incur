---
'incur': patch
---

Fixed command groups created with `Cli.create()` not being able to opt out of MCP. `Cli.create(name, { mcp: false })` now hides the mounted group's root command and all of its subcommands, including nested groups, from MCP tools, matching per-command `mcp: false`. The commands remain available through the CLI and HTTP routes.
