---
'incur': patch
---

Allowed custom global options named `verbose`, which was still reserved after the built-in `--verbose` flag was renamed to `--full-output`. A global named `fullOutput` now throws at `Cli.create()` time instead, since `--full-output` is consumed by the built-in flag.
