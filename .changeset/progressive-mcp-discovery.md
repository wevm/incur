---
'incur': major
---

Changed MCP servers to expose progressive tool discovery by default.

```diff
- mcp: { tools: {} }
+ mcp: { tools: { discovery: 'direct' } }
```
