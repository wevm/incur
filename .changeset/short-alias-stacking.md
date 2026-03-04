---
"incur": patch
---

Added short-alias stacking (e.g. `-abc` parsed as `-a -b -c`). The last flag in a stack can consume a value; all preceding flags must be boolean.
