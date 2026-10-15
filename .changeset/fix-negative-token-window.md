---
'incur': patch
---

Rejected negative `--token-limit` and `--token-offset` values with a `ParseError`. Previously they ran the command and printed a window taken from the end of the output with a negative token range.
