---
'incur': patch
---

Fixed shell completions reading the values of global and built-in flags as command words. `cli --network testnet com<TAB>` now completes `completions`, `cli --network testnet skills <TAB>` suggests the `skills` subcommands, and `cli --format json <TAB>` includes the built-in commands. A partial value at the cursor (e.g. `cli --format j<TAB>`) no longer writes an error into the completion output.
