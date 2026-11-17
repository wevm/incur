---
'incur': patch
---

OpenAPI-generated commands now build their Zod schemas on first read, and generation no longer clones the document before dereferencing it.
