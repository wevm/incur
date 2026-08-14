---
'incur': minor
---

Added filesystem command routing through `Cli.command()` and `cli.fs()`.

```ts
await Cli.create('my-cli').fs().serve()
```

[Read more](https://github.com/wevm/incur#file-based-commands).
