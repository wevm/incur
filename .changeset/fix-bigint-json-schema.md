---
"incur": patch
---

Fixed `z.bigint()`, `z.coerce.bigint()`, `z.date()`, and `z.coerce.date()` schemas failing during skill sync by representing them as `{ type: "string" }` in JSON Schema output.
