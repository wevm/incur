---
'incur': patch
---

Fixed root help listing a built-in under `Integrations:` when a registered command or alias of the same name shadows it, and dropped the section when every built-in is hidden. Added `hideBuiltins` to `Help.formatRoot` and `Help.formatCommand` options.
