---
'incur': patch
---

Fixed streaming command terminal records so HTTP NDJSON responses preserve returned `c.ok()` CTA metadata, represent returned or yielded `c.error()` values as terminal errors, include terminal duration metadata, and unwind generators on response cancellation.

Also preserves `IncurError.retryable` metadata in streaming machine-format errors.
