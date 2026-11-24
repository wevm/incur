import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { detectRunner, exec } from './internal/pm.js'

const exactVersionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
const safePackageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** Registers the CLI as an MCP server via `npx add-mcp` and direct config writes for unsupported agents. */
export async function register(
  name: string,
  options: register.Options = {},
): Promise<register.Result> {
  const runner = detectRunner()
  const command =
    options.command ?? defaultCommand(options.cli ?? name, runner, options.package, options.version)
  const targetAgents = options.agents ?? []
  const ampOnly = targetAgents.length === 1 && targetAgents[0] === 'amp'

  // Amp is registered directly (add-mcp doesn't support it). Its settings are checked first, so
  // invalid settings fail before any agent is configured, and read again when written.
  const amp = targetAgents.length === 0 || targetAgents.includes('amp')
  const ampPath =
    options.global === false
      ? join(process.cwd(), '.amp', 'settings.json')
      : join(homedir(), '.config', 'amp', 'settings.json')
  if (amp) readAmpSettings(ampPath)

  const agents: string[] = []

  // Run add-mcp for agents it supports (skip if only targeting Amp)
  if (!ampOnly) {
    const args = [command, '--name', name, '-y']
    if (options.global !== false) args.push('-g')
    for (const agent of targetAgents.filter((a) => a !== 'amp')) args.push('-a', agent)

    const [cmd, ...prefix] = runner.split(' ')
    const stdout = await exec(cmd!, [...prefix, 'add-mcp', ...args])

    // Extract agent names from add-mcp output (lines like "│ ✓ Claude Code: ~/.claude.json │")
    agents.push(
      ...stdout
        .split('\n')
        .filter((l) => l.includes('✓') || l.includes('✔'))
        .map((l) =>
          l
            .replace(/[│┃|]/g, '')
            .replace(/.*[✓✔]\s*/, '')
            .replace(/:.*/, '')
            .trim(),
        )
        .filter(Boolean),
    )
  }

  if (amp && registerAmp(ampPath, name, command)) agents.push('Amp')

  return { command, agents }
}

/** @internal Reads Amp's settings: `{}` when the file is missing, or throws unless it holds a JSON object. */
function readAmpSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const config = JSON.parse(readFileSync(path, 'utf-8'))
    if (isObject(config)) return config
  } catch {}
  throw new Error(`Invalid Amp settings at ${path}: expected a JSON object`)
}

/** @internal Registers an MCP server in Amp's settings, keeping the other fields of an existing entry. */
function registerAmp(path: string, name: string, command: string): boolean {
  const [cmd, ...args] = splitCommand(command)
  if (!cmd) return false

  const config = readAmpSettings(path)
  const servers = isObject(config['amp.mcpServers']) ? config['amp.mcpServers'] : {}
  const existing = servers[name]
  servers[name] = { ...(isObject(existing) ? existing : undefined), command: cmd, args }
  config['amp.mcpServers'] = servers

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')

  return true
}

/** @internal Whether a JSON value is an object (not an array or `null`). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export declare namespace register {
  /** Options for registering an MCP server. */
  type Options = {
    /** Target specific agents (e.g. `'claude-code'`, `'cursor'`). */
    agents?: string[] | undefined
    /** CLI name used to derive the default command. Defaults to the MCP server name. */
    cli?: string | undefined
    /**
     * Override the command agents will run. Defaults to `<name> --mcp` when the binary is on PATH
     * or, without `package`, the name is not an npm package name (e.g. `tempo wallet`). Otherwise
     * defaults to `<runner> <package> --mcp`.
     */
    command?: string | undefined
    /** Install globally. Defaults to `true`. Otherwise Amp is registered in `.amp/settings.json` in the working directory. */
    global?: boolean | undefined
    /** Trusted npm package used to run the CLI. */
    package?: string | undefined
    /** Exact CLI version appended to `package` when provided. */
    version?: string | undefined
  }

  /** Result of a register operation. */
  type Result = {
    /** Agents the server was registered with. */
    agents: string[]
    /** The command registered. */
    command: string
  }
}

/** @internal Builds the default MCP command for the current launch mode. */
function defaultCommand(name: string, runner: string, pkg?: string, version?: string): string {
  const specifier = pkg !== undefined ? detectPackageSpecifier(name, pkg, version) : undefined
  // A CLI name that is not a package name (e.g. `tempo wallet`) cannot be run by a package runner.
  return shouldUseBareCommand(name, pkg) || (pkg === undefined && !isPackageName(name))
    ? `${name} --mcp`
    : `${runner} ${specifier ?? detectPackageSpecifier(name)} --mcp`
}

/** @internal Returns node_modules path details for the current entrypoint. */
function nodeModulesInfo(): { entry: string; root: string } | null {
  const normalized = process.argv[1]?.replace(/\\/g, '/')
  const match = normalized?.match(/^(.+)\/node_modules\/(.+)$/)
  if (!match) return null
  return { root: match[1]!, entry: match[2]! }
}

/** @internal Uses the bare command only when the binary is expected on PATH. */
function shouldUseBareCommand(name: string, pkg?: string): boolean {
  const bin = process.argv[1]
  if (!bin) return false

  const info = nodeModulesInfo()
  if (info) return !info.entry.startsWith('.bin/') && !packageDependsOn(info.root, pkg ?? name)

  const file = bin.replace(/\\/g, '/').split('/').pop()
  return file === name || file === `${name}.cmd` || file === `${name}.ps1`
}

/** @internal Checks whether the entrypoint came from a project dependency install. */
function packageDependsOn(root: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    const dependencyFields = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ]
    return dependencyFields.some((dependencies) => name in (dependencies ?? {}))
  } catch {
    return false
  }
}

/** @internal Checks whether `name` is a safe npm package name (e.g. `my-cli` or `@scope/my-cli`). */
export function isPackageName(name: string): boolean {
  return safePackageNamePattern.test(name)
}

/** @internal Detects the safe package specifier used to run this CLI. */
export function detectPackageSpecifier(name: string, pkg?: string, version?: string): string {
  if (pkg !== undefined) {
    if (!isPackageName(pkg)) throw new Error(`Invalid npm package name: ${pkg}`)
    if (version !== undefined && !exactVersionPattern.test(version))
      throw new Error(`Invalid exact package version: ${version}`)
    return version === undefined ? pkg : `${pkg}@${version}`
  }
  return name
}

/** Splits a command string into tokens, respecting single and double quotes. */
function splitCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ' ') {
      if (current) tokens.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) tokens.push(current)
  return tokens
}
