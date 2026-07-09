---
'incur': patch
---

Fixed generated and synced skills to use the same command projection as CLI skill output.

`Skillgen` and `SyncSkills` now avoid generating duplicate skills for command aliases, preserve output schemas and examples consistently, and include the fetch gateway skill hint for fetch-based commands.
