---
'incur': patch
---

Fixed `--token-offset` past the end of the output printing a reversed range in the truncation footer (e.g. `showing tokens 100000–13 of 13`). The start is now clamped to the total token count.
