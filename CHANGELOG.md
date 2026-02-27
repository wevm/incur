# incur

## 0.1.3

### Patch Changes

- 0e42bc0: Added native skill installation.

## 0.1.2

### Patch Changes

- dfd804c: Added ability for a root command to have both a `run` handler and subcommands. Subcommands take precedence — unmatched tokens fall back to the root handler. `--help` shows both root command usage and the subcommand list.

## 0.1.1

### Patch Changes

- 370d039: Fixed commands returning `undefined` being serialized as the literal string `"undefined"` in output. Void commands now produce no output in human and machine modes. MCP tool calls with undefined results now return valid JSON (`null`) instead of broken output.

## 0.1.0

### Minor Changes

- 09e4d76: Initial release.

## 0.0.2

### Patch Changes

- 9c7f8aa: Updated SKILL.md
- 3d38f2d: Added usage info at end of description frontmatter in skills.

## 0.0.1

### Patch Changes

- 1318c14: Initial release
