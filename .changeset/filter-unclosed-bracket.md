---
'incur': patch
---

Fixed `Filter.parse` looping forever on an unclosed `[` (e.g. `--filter-output 'a['`). It now throws a `ParseError`, and `--filter-output` reports it before the command runs.
