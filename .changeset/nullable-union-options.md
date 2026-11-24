---
'incur': patch
---

Treated `T | null` union options, such as `z.fromJSONSchema` makes of OpenAPI 3.1 and MCP `type: ['array', 'null']`, as their inner type when parsing argv and environment variables and in help. Repeated flags of a nullable array option now collect into an array instead of failing validation.
