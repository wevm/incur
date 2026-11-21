---
'incur': minor
---

Fixed `--mcp` tool calls ignoring the globals passed to the server and the config file. Globals passed when starting the server (`my-cli --mcp --display xvfb`) are validated at startup and apply to every tool call that does not pass its own value. With `config` enabled, the config file is loaded once at startup, honoring `--config <path>` and `--no-config`, and each command's section applies to its tool calls with the CLI's precedence: tool arguments, then config, then zod defaults. Tool input schemas advertise these values as defaults. An invalid server global, an unreadable config file, or an invalid config section stops the server at startup. `Mcp.serve` accepts a `defaults` option (`Mcp.Defaults`) for CLIs that serve their command map directly.
