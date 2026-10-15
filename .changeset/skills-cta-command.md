---
'incur': patch
---

Fixed the stale-skills CTA for CLI names that are not npm package names (e.g. `Cli.create('tempo wallet')`). Under a package manager, the CTA no longer suggests running the name as a package (e.g. `pnpx tempo wallet skills add`), and suggests the installed binary (`tempo wallet skills add`) unless `package` is set.
