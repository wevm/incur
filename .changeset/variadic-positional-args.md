---
'incur': minor
---

Added variadic positional arguments: a final `z.array(...)` args key collects all remaining positionals.

```ts
Cli.create('my-cli').command('lint', {
  args: z.object({ paths: z.array(z.string()).describe('Files to lint') }),
  run: (c) => ({ count: c.args.paths.length }),
})
```
