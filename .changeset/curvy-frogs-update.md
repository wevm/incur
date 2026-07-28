---
'incur': patch
---

Added cross-platform binary distribution, and update notices

```ts
import { Binary, Cli } from 'incur'

const cli = Cli.create('my-cli', {
  update: Binary.github({ repository: 'example/my-cli' }),
})
```
