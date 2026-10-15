---
'incur': patch
---

Fixed `update: false` to also disable the built-in `--update` flag. Root help no longer lists `--update`, and `--update` is parsed like any other flag: it is rejected as unknown unless a command option or global option named `update` is declared.
