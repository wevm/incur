---
'incur': patch
---

Fixed `--mcp` tool calls ignoring the global options passed to the server and the config file. Globals such as `my-cli --mcp --profile prod` and each command's config section (honoring `--config <path>` and `--no-config`) now apply to tool calls that do not pass their own values, and show as defaults in the tool input schemas. An invalid server global or config file stops the server at startup.
