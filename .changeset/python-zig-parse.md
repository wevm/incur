---
'incur': minor
---

Added declarative CLIs with `parse()` to the Python and Zig ports, matching the Rust `Parser` derive: declare commands as types and groups as unions, then call `parse()` for the typed command or serve a handler for incur-formatted output, `--mcp`, and HTTP.
