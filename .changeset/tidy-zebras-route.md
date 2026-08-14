---
'incur': patch
---

Changed zero-argument `cli.fs()` to infer commands from sibling files and folders beside the entrypoint.

```ts
import { Cli } from 'incur'

await Cli.create('my-cli').fs().serve()
```
