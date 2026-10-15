---
'incur': patch
---

Fixed agent output for commands that return an array (or other non-plain object) alongside a CTA, including framework notices such as the stale skills CTA. The data is now wrapped as `{ data, cta }`, matching scalar outputs, instead of being spread into index keys (`{ "0": ..., "1": ..., cta }`). Plain object outputs are unchanged.
