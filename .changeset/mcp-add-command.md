---
'incur': patch
---

Fixed the default `mcp add` command for CLI names that are not npm package names (e.g. `Cli.create('tempo wallet')`). The registered command no longer runs the name as a package (e.g. `npx tempo wallet --mcp`), and runs the installed binary (`tempo wallet --mcp`) unless `package` is set.
