---
'incur': patch
---

Fixed OpenAPI-generated commands dropping request bodies composed with `anyOf`, `oneOf`, or `allOf`. Object variants now merge into options; a field is required only when every union variant requires it.
