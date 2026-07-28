---
'incur': minor
---

Added cached update notices, root `--update`, cross-platform binaries, verified GitHub updates, generated initial installers, and a reusable release workflow.

```ts
import { Binary, Cli } from 'incur'

const cli = Cli.create('my-cli', {
  update: Binary.github({ repository: 'example/my-cli' }),
})
```
