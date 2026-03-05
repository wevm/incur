---
"incur": patch
---

Added optional exitCode to c.error() and IncurError, allowing CLI authors to control the process exit code. Defaults to 1 when omitted (backward compatible).
