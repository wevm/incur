---
'incur': patch
---

Added dynamic shell completions for bash, zsh, fish, and nushell. CLIs get a built-in `completions <shell>` command that outputs a hook script. The hook calls back into the binary at every tab press, so completions stay in sync with commands automatically. Supports subcommands, `--options`, short aliases, enum values, and space suppression for command groups.
