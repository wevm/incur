---
'incur': minor
---

Added `openapiConfig.groupsFromTags` to describe namespace-mode command groups from the OpenAPI document's tags, using a tag's `x-cli-description` or else its description's first sentence.

```ts
Cli.create('my-cli').command('api', {
  fetch: app.fetch,
  openapi: spec,
  openapiConfig: { groupsFromTags: true, mode: 'namespace' },
})
```
