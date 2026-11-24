---
'incur': patch
---

Fixed registered commands and aliases named `completions`, `mcp`, `skills`, or `skill` being shadowed by the built-in of the same name: the registered command now runs. Root command positionals still yield to built-ins.
