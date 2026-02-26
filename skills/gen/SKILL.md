---
name: clac-gen
description: Code generation utilities. Generate Markdown skill files from a CLI definition., Generate type definitions for development.
command: clac gen
---

# clac gen skills

Generate Markdown skill files from a CLI definition.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir` | `string` |  | Project root directory |
| `--entry` | `string` |  | Entrypoint path (absolute) |
| `--output` | `string` |  | Output directory |
| `--depth` | `number` | `1` | Grouping depth (0 = single file) |

---

# clac gen types

Generate type definitions for development.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--dir` | `string` |  | Project root directory |
| `--entry` | `string` |  | Entrypoint path (absolute) |
| `--output` | `string` |  | Output path (absolute) |
