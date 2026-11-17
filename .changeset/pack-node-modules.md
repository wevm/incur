---
'incur': patch
---

Fixed publishing by excluding nested `node_modules` from the package; npm rejected the workspace symlinks under `examples`.
