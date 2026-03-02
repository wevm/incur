---
"incur": minor
---

Added deprecated option support via Zod's `.meta({ deprecated: true })`. Deprecated flags show `[deprecated]` in help output, `**Deprecated.**` in skill docs, `deprecated: true` in JSON Schema, and emit stderr warnings in TTY mode.
