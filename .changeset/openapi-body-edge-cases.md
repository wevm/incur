---
'incur': patch
---

Fixed two cases in OpenAPI-generated body options. A `true` alternative in `anyOf`/`oneOf` now leaves the other variants' fields optional, and a defaulted field that an `allOf` member refines keeps its default.
