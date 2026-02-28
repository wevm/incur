---
'incur': patch
---

Added `agent` boolean to the `run` context. `true` when stdout is not a TTY (piped/agent consumer), `false` when running in a terminal. Use it to tailor command behavior for agents vs humans.
