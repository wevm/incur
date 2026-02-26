import fs from 'node:fs/promises'
import path from 'node:path'
import url from 'node:url'
import * as Cli from '../Cli.js'

/**
 * Dynamically imports a module and extracts its default-exported CLI instance.
 * Temporarily replaces `process.argv` and `process.exit` to prevent imported
 * modules that call `.serve()` at the top level from interfering.
 */
export async function importCli(input: string): Promise<Cli.Cli> {
  const resolved = path.resolve(input)
  const stat = await fs.stat(resolved)
  const file = stat.isDirectory() ? await resolveEntry(resolved) : resolved
  const href = url.pathToFileURL(file).href

  const savedArgv = process.argv
  const savedExit = process.exit
  const savedWrite = process.stdout.write
  process.argv = [savedArgv[0]!]
  process.exit = (() => {}) as never
  process.stdout.write = (() => true) as never
  try {
    const mod = await import(href)
    const cli = mod.default as Cli.Cli
    if (!cli || !Cli.toCommands.has(cli))
      throw new Error(`Expected default export to be a \`Cli\` instance: ${input}`)
    return cli
  } finally {
    process.argv = savedArgv
    process.exit = savedExit
    process.stdout.write = savedWrite
  }
}

/** Resolves the CLI entry file from a directory by checking `package.json` `bin`, then falling back to `cli.ts`. */
async function resolveEntry(dir: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))
    if (pkg.bin) {
      const entries = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin) as string[]
      const src = entries.find((e) => e.endsWith('.ts'))
      const entry = src ?? entries[0]
      if (entry) return path.join(dir, entry)
    }
    if (pkg.main) return path.join(dir, pkg.main)
  } catch {}
  return path.join(dir, 'cli.ts')
}
