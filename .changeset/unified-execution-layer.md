---
"incur": minor
---

Unified command execution across CLI, HTTP, and MCP transports. Added a shared internal `execute()` function that all three transports now use, eliminating behavioral drift. Middleware, group middleware, env schema parsing, vars initialization, and `retryable`/`cta` propagation now behaved consistently across all transports.
