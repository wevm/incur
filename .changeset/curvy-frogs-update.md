---
'incur': minor
---

Added cached update notices, root `--update`, cross-platform standalone builds, and GitHub Release updates with verified assets and safe self-replacement.

```ts
import { Binary, Cli } from 'incur'

const cli = Cli.create('my-cli', {
  update: Binary.github({ repository: 'example/my-cli' }),
})
```
