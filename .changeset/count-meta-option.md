---
"incur": patch
---

Added support for count options via `.meta({ count: true })` on `z.number().default(0)` schemas. Count flags behave like booleans (no value consumed), but increment on each occurrence, supporting both repeated flags (`--verbose --verbose`) and stacked aliases (`-vvv`).
