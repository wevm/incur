---
'incur': minor
---

Added `globals` support to MCP tools and the generated OpenAPI document. Global options are now merged into every MCP tool's input schema (stdio `--mcp` and HTTP `/mcp`) and into each OpenAPI operation's query parameters or request body. MCP tool calls split them back out, apply the globals schema's defaults and validation once, and pass them to commands and middleware as `globals`. `Mcp.serve` accepts a `globals` schema for CLIs that serve their command map directly, and types `c.globals` in its middlewares from it. A global wins over a command option of the same name, as on the CLI.
