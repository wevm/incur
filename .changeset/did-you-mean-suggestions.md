---
"incur": patch
---

Added "Did you mean?" suggestions for mistyped commands using Levenshtein distance. Includes builtin commands (`mcp`, `skills`, `completions`) in suggestion candidates. Suggestion CTA preserves original args/flags. Moved skills staleness warning from stderr into the CTA system.
