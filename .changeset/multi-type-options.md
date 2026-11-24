---
'incur': patch
---

Matched the TypeScript reference in the Rust, Python, and Zig ports for OpenAPI and MCP-source options whose JSON Schema `type` lists several non-null types, such as `['string', 'array']`. Rust now validates the option as a union instead of reading it as its first non-null type, and coerces it to a number or boolean when any listed type is one. Python's help now shows `<value>` instead of `<union>`. Python and Zig now report a missing required option of this kind as an `invalid_union`, and Python reports the issues of the one listed type that failed only bounds or format checks, as Zod does.

A type list with a `default`, such as `{ type: ['string', 'integer'], default: 'auto' }`, now stays uncoerced in Rust and Python, as `coerceIfNeeded` skips defaulted members. When an optional option of this kind is omitted, every port now applies its default.
