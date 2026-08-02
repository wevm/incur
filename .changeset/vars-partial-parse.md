---
'incur': patch
---

Fixed eager `varsSchema.parse({})` throwing ZodError for required vars populated by middleware. Vars are now initialized with `varsSchema.partial().parse({})`, preserving schema defaults while allowing middleware-populated required fields.
