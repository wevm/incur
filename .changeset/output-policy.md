---
'incur': patch
---

Added `outputPolicy` option to commands, groups, and root CLIs. Set `outputPolicy: 'agent-only'` to suppress data output in human/TTY mode while still returning structured data to agents. Defaults to `'all'`. Inherited from parent groups — children can override.
