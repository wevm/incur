---
'incur': minor
---

Added `cta` to `IncurError` and `hint` to `c.error()`. A thrown `IncurError` now renders exactly like a returned `c.error()` with the same fields, in every output format, streaming, `cli.fetch`, and MCP, instead of dropping its `cta` and `hint`. A `hint` appears as `error.hint` in structured output (and in the generated OpenAPI error schema) and as a `Hint:` line after the message in human and MCP text. Streaming commands also render the `cta` of a yielded or returned `c.error()`.

```ts
throw new Errors.IncurError({
  code: 'NOT_AUTHENTICATED',
  message: 'GitHub token not found',
  hint: 'Tokens expire after 30 days.',
  cta: { commands: ['auth login'] },
})
```

Added `_meta.error` to MCP tool error results, carrying the error's `code`, `retryable`, and `exitCode` so clients can branch on them without parsing the text.

Fixed MCP tool calls of streaming commands reporting a yielded or returned `c.error()` as a successful chunk array. They now return a tool error, and the `cta` of a returned `c.ok()` is appended like it is for non-streaming commands.
