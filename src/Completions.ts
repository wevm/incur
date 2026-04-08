import type { z } from 'zod'

import type { Shell } from './internal/command.js'

/** A completion candidate with an optional description. */
export type Candidate = {
  /** Optional description shown alongside the candidate. */
  description?: string | undefined
  /** When true, the shell should not append a trailing space after this candidate. */
  noSpace?: boolean | undefined
  /** The completion value. */
  value: string
}

/** @internal Entry stored in a command map — either a leaf definition or a group. */
type CommandEntry = {
  _group?: true | undefined
  alias?: Record<string, string | undefined> | undefined
  args?: z.ZodObject<any> | undefined
  commands?: Map<string, CommandEntry> | undefined
  default?: CommandEntry | undefined
  description?: string | undefined
  options?: z.ZodObject<any> | undefined
}

/**
 * Generates a shell hook script that registers dynamic completions for the CLI.
 * The hook calls back into the binary with `COMPLETE=<shell>` at every tab press.
 */
export function register(shell: Shell, name: string): string {
  switch (shell) {
    case 'bash':
      return bashRegister(name)
    case 'zsh':
      return zshRegister(name)
    case 'fish':
      return fishRegister(name)
    case 'nushell':
      return nushellRegister(name)
  }
}

/**
 * Computes completion candidates for the given argv words and cursor index.
 * Walks the command tree to resolve the active command, then suggests
 * subcommands, options, or positional argument hints.
 */
export function complete(
  commands: Map<string, CommandEntry>,
  rootCommand: CommandEntry | undefined,
  argv: string[],
  index: number,
): Candidate[] {
  const current = argv[index] ?? ''

  // Walk argv tokens up to (but not including) the cursor word to resolve the active scope
  let scope: { commands: Map<string, CommandEntry>; leaf?: CommandEntry | undefined } = {
    commands,
    leaf: rootCommand,
  }

  for (let i = 0; i < index; i++) {
    const token = argv[i]!
    if (token.startsWith('-')) continue
    const entry = scope.commands.get(token)
    if (!entry) continue
    if (entry._group && entry.commands) {
      scope = { commands: entry.commands, leaf: entry.default }
    } else {
      scope = { commands: new Map(), leaf: entry }
      break
    }
  }

  const candidates: Candidate[] = []

  // If cursor word starts with '-', suggest options from the active leaf command
  if (current.startsWith('-')) {
    const leaf = scope.leaf
    if (leaf?.options) {
      const shape = leaf.options.shape as Record<string, any>
      for (const key of Object.keys(shape)) {
        const kebab = key.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)
        const flag = `--${kebab}`
        if (flag.startsWith(current))
          candidates.push({ value: flag, description: descriptionOf(shape[key]) })
      }
      // Short aliases
      if (leaf.alias)
        for (const [name, short] of Object.entries(leaf.alias)) {
          const flag = `-${short}`
          if (flag.startsWith(current)) {
            const desc = descriptionOf(shape[name])
            candidates.push({ value: flag, description: desc })
          }
        }
    }
    return candidates
  }

  // Check if previous token is a non-boolean option expecting a value
  if (index > 0) {
    const prev = argv[index - 1]!
    const leaf = scope.leaf
    if (leaf?.options && prev.startsWith('-')) {
      const name = resolveOptionName(prev, leaf)
      if (name) {
        const values = possibleValues(name, leaf.options)
        if (values) {
          for (const v of values) if (v.startsWith(current)) candidates.push({ value: v })
          return candidates
        }
        if (!isBooleanOption(name, leaf.options)) return candidates
      }
    }
  }

  // Suggest subcommands (groups get noSpace so user can keep typing subcommand)
  for (const [name, entry] of scope.commands) {
    if (name.startsWith(current))
      candidates.push({
        value: name,
        description: entry.description,
        ...(entry._group ? { noSpace: true } : undefined),
      })
  }

  return candidates
}

/**
 * Formats completion candidates into shell-specific output.
 * - bash: `\013`-separated values (noSpace candidates end with `\001`)
 * - zsh: `value:description` newline-separated (`:` escaped in values)
 * - fish: `value\tdescription` newline-separated
 * - nushell: JSON array of `{value, description}` records
 */
export function format(shell: Shell, candidates: Candidate[]): string {
  switch (shell) {
    case 'bash': {
      return candidates.map((c) => (c.noSpace ? `${c.value}\x01` : c.value)).join('\v')
    }
    case 'zsh': {
      return candidates
        .map((c) => {
          const escaped = c.value.replaceAll(':', '\\:')
          return c.description ? `${escaped}:${c.description}` : escaped
        })
        .join('\n')
    }
    case 'fish': {
      return candidates
        .map((c) => (c.description ? `${c.value}\t${c.description}` : c.value))
        .join('\n')
    }
    case 'nushell': {
      const records = candidates.map((c) => {
        const record: { value: string; description?: string } = { value: c.value }
        if (c.description) record.description = c.description
        return record
      })
      return JSON.stringify(records)
    }
  }
}

/** @internal Resolves a flag token (e.g. `--foo-bar` or `-f`) to its camelCase option name. */
function resolveOptionName(token: string, entry: CommandEntry): string | undefined {
  if (!entry.options) return undefined
  const known = new Set(Object.keys(entry.options.shape))
  const kebabToCamel = new Map<string, string>()
  for (const name of known) {
    const kebab = name.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)
    if (kebab !== name) kebabToCamel.set(kebab, name)
  }

  if (token.startsWith('--')) {
    const raw = token.slice(2)
    const name = kebabToCamel.get(raw) ?? raw
    return known.has(name) ? name : undefined
  }
  if (token.startsWith('-') && token.length === 2 && entry.alias) {
    const short = token.slice(1)
    for (const [name, alias] of Object.entries(entry.alias)) if (alias === short) return name
  }
  return undefined
}

/** @internal Checks if an option's inner type is boolean or count. */
function isBooleanOption(name: string, schema: z.ZodObject<any>): boolean {
  const field = schema.shape[name]
  if (!field) return false
  if (typeof field.meta === 'function' && field.meta()?.count === true) return true
  return unwrap(field).constructor.name === 'ZodBoolean'
}

/** @internal Extracts possible values from enum schemas. */
function possibleValues(name: string, schema: z.ZodObject<any>): string[] | undefined {
  const field = schema.shape[name]
  if (!field) return undefined
  const inner = unwrap(field)
  if (inner.constructor.name === 'ZodEnum') return Object.values((inner as any)._zod.def.entries)
  if (inner.constructor.name === 'ZodNativeEnum') return Object.keys((inner as any)._zod.def.values)
  return undefined
}

/** @internal Unwraps ZodDefault/ZodOptional to get the inner type. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema as any
  while (s._zod?.def?.innerType) s = s._zod.def.innerType
  return s
}

/** @internal Extracts a description from a Zod schema's metadata. */
function descriptionOf(schema: z.ZodType | undefined): string | undefined {
  if (!schema) return undefined
  return (schema as any).description
}

// ---------------------------------------------------------------------------
// Shell registration scripts
// ---------------------------------------------------------------------------

/** @internal Sanitizes a CLI name into a valid shell identifier. */
function ident(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

function bashRegister(name: string): string {
  const id = ident(name)
  return `_incur_complete_${id}() {
    local IFS=$'\\013'
    local _COMPLETE_INDEX=\${COMP_CWORD}
    local _completions
    _completions=( $(
        export COMPLETE="bash"
        export _COMPLETE_INDEX="$_COMPLETE_INDEX"
        "${name}" -- "\${COMP_WORDS[@]}"
    ) )
    if [[ $? != 0 ]]; then
        unset COMPREPLY
        return
    fi
    local _nospace=false
    COMPREPLY=()
    for _c in "\${_completions[@]}"; do
        if [[ "$_c" == *$'\\001' ]]; then
            _nospace=true
            COMPREPLY+=("\${_c%$'\\001'}")
        else
            COMPREPLY+=("$_c")
        fi
    done
    if [[ $_nospace == true ]]; then
        compopt -o nospace
    fi
}
complete -o default -o bashdefault -o nosort -F _incur_complete_${id} ${name}`
}

function zshRegister(name: string): string {
  const id = ident(name)
  return `#compdef ${name}
_incur_complete_${id}() {
    local completions=("\${(@f)$(
        export _COMPLETE_INDEX=$(( CURRENT - 1 ))
        export COMPLETE="zsh"
        "${name}" -- "\${words[@]}" 2>/dev/null
    )}")
    if [[ -n $completions ]]; then
        _describe 'values' completions -S ''
    fi
}
compdef _incur_complete_${id} ${name}`
}

function fishRegister(name: string): string {
  return `complete --keep-order --exclusive --command ${name} \\
    --arguments "(COMPLETE=fish ${name} -- (commandline --current-process --tokenize --cut-at-cursor) (commandline --current-token))"`
}

function nushellRegister(name: string): string {
  const id = ident(name)
  return `# External completer for ${name}
# Add to $env.config.completions.external.completer or use in a dispatch completer.
let _incur_complete_${id} = {|spans|
    COMPLETE=nushell ${name} -- ...$spans | from json
}`
}
