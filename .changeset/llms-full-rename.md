---
"incur": minor
---

**Breaking:** Renamed `--llms` to `--llms-full`. Added a new `--llms` flag that outputs a compact command index (table of command signatures + descriptions) instead of the full manifest. This reduced token usage by ~95% for agents that already know the CLI and just need a quick reminder of available commands.
