---
'incur': patch
---

Fixed TOON, YAML, and Markdown output diverging from JSON output. Command data is now normalized the same way as JSON before rendering, so `undefined` object values are omitted instead of rendered as `null` (or `undefined` in Markdown), BigInt values are rendered as strings instead of numbers, and `Date` values are rendered as ISO strings.
