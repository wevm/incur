---
'incur': patch
---

Fixed `sync.cwd` doing two jobs. It now only sets where `include` globs resolve, and `skills add` and `skills list` both default it to the CLI's package root. `skills add --no-global` always installs into the working directory, so `cwd: import.meta.dirname` no longer puts project skills inside the CLI's own package. `SyncSkills.sync()` and `SyncSkills.list()` take a new `root` option for the glob directory; their `cwd` option keeps working as before.
