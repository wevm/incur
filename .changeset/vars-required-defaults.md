---
'incur': patch
---

Fixed required `vars` throwing a `ZodError` before middleware could set them. Each run now starts with only the defaults of the `vars` schema, for commands and fetch gateways alike.
