---
'incur': patch
---

Fixed invalid subcommand in a group falling through to root handler instead of returning `COMMAND_NOT_FOUND`. Added CTA with copyable help command to `COMMAND_NOT_FOUND` errors.
