---
'incur': patch
---

Fixed fetch gateway paths starting with `/`. A root fetch gateway no longer rejects `/v1/orgs` as a typo of an `orgs` command, and a leading `/` no longer turns the path into a protocol-relative URL.
