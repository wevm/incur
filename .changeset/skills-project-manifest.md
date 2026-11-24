---
'incur': patch
---

Fixed same-named CLIs in different projects overwriting each other's skills metadata, which caused false "Skills are out of date" notices. `skills add --no-global` now records its metadata per project, in `<XDG_DATA_HOME>/incur/projects/<hash of the project directory>/<name>.json`. Global installs keep using `<XDG_DATA_HOME>/incur/<name>.json`. The staleness check prefers skills installed in the current project and suggests `skills add --no-global` when those are out of date. `skills list` reports skills installed globally or in the project. `SyncSkills.readHash()` and `SyncSkills.hasInstalledSkills()` take `global: false` to read a project's metadata.
