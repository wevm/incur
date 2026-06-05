---
'incur': patch
---

Fixed `--llms` and `--llms-full` markdown output when scoped to a command group (e.g. `cli auth --llms`) to no longer duplicate the group prefix in command signatures (`cli auth auth login` → `cli auth login`).

The scoped name already carries the prefix, so command collection now runs with an empty prefix to match the unscoped and JSON/YAML manifest output.
