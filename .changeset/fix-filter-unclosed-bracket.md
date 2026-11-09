---
'incur': patch
---

Rejected filter expressions with an unclosed `[` (e.g. `a[`) with a `ParseError`. Previously `Filter.parse` looped forever, so `--filter-output` hung the CLI instead of returning an error.
