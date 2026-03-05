---
"incur": minor
---

Added `--token-count`, `--token-limit`, and `--token-offset` global options for token-aware output pagination. Uses LLM tokenization estimation (~96% accuracy via `tokenx`). In `--verbose` mode, truncated output includes `meta.nextOffset` for programmatic pagination.
