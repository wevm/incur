---
'incur': patch
---

Fixed `skills add` deleting the skill it had just installed, and replacing it with a self-referential symlink, when an agent's skills directory is a symlink to the canonical one.
