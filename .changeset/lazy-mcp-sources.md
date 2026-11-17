---
'incur': patch
---

Remote MCP command groups now connect on first use, so invocations that never reach the group skip the MCP handshake.
