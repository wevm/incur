---
'incur': minor
---

Added `sync.body`, printed verbatim after the synced skills, for setup `skills add` cannot perform itself.

```ts
const cli = Cli.create('my-cli', {
  sync: {
    body: 'Authorize the app at https://github.com/apps/my-cli/installations/new',
  },
})
```
