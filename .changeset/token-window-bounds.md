---
'incur': patch
---

Fixed `--token-limit` and `--token-offset` windows: negative values are now rejected with an error before the command runs, and an offset past the end of the output no longer prints a reversed range in the truncation footer (e.g. `showing tokens 100000–13 of 13` is now `13–13 of 13`).
