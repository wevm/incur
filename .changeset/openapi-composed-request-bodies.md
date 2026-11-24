---
'incur': patch
---

Fixed OpenAPI-generated commands dropping request bodies composed with `anyOf`, `oneOf`, or `allOf`. Their object fields now become options. A field is required only when every union variant requires it, and a field whose schema differs between members accepts any value for the server to validate.
