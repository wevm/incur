---
'incur': patch
---

Fixed streaming handler ignoring CLI-level and command-level default `format`. Previously, `handleStreaming` used only `formatExplicit` to decide between incremental and buffered mode, causing CLI defaults like `{ format: 'json' }` to be ignored in favor of hardcoded `'toon'`.
