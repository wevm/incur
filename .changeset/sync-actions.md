---
'incur': minor
---

Added `sync.actions`, listing setup steps `skills add` cannot perform itself as a numbered checklist after the synced skills, and in the structured output.

```ts
const cli = Cli.create('my-cli', {
  sync: {
    actions: ['Authorize the app at https://github.com/apps/my-cli/installations/new'],
  },
})
```
