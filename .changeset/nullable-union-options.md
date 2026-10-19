---
'incur': patch
---

Treat OpenAPI 3.1 nullable types (`type: ['array', 'null']`) as their underlying type when parsing argv.

`z.fromJSONSchema` converts a nullable JSON Schema type into a `ZodUnion` rather than a `ZodNullable`, so
the parser's `unwrap` — which only followed `innerType` — saw a union and fell back to scalar handling. A
nullable array option therefore never collected repeated flags, and nullable number and boolean options
were never coerced from their argv strings, so every one of them failed validation. Help now also renders
the underlying type (e.g. `<array>`) instead of `<value>` for these options.
