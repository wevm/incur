---
'incur': patch
---

Fixed global options being read out of command option values. Globals are now parsed with the resolved command's option arity, so in `cli send -d --network=testnet` the token `--network=testnet` is the value of `-d` instead of setting the global `--network`. Stacked short flags can mix global and command aliases (e.g. `-sn testnet`). Global option errors are now reported like command option errors: an invalid value reports `VALIDATION_ERROR` with `fieldErrors` instead of `UNKNOWN`, and errors respect `--format`/`--json`.
