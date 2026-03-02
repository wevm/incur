---
"incur": patch
---

Added `c.error()` to middleware context for structured error short-circuiting. Middleware can now return `c.error({ code, message })` instead of throwing, producing a proper error envelope with optional CTAs.
