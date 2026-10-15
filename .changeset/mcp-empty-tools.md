---
'incur': patch
---

Fixed MCP servers (`--mcp` and `/mcp`) for CLIs that expose no tools, such as a CLI with only a root command: the `tools` capability is now always advertised and `tools/list` returns an empty list instead of a `-32601` (method not found) error that was written before the `initialize` response.
