import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const extensions = ['.cts', '.cjs', '.mts', '.mjs', '.ts', '.js'] as const
const segmentPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** @internal A command module discovered from its filesystem route. */
export type Route = {
  file: string
  segments: string[]
}

/** @internal A command supplied by a standalone build manifest. */
export type ManifestRoute = Route & {
  command: unknown
}

/** @internal Global key shared by generated standalone entrypoints and the runtime loader. */
export const manifestKey = 'incur.fs.manifests'

/** @internal Discovers command module files below a directory. */
export async function discover(directory: string): Promise<Route[]> {
  const routes: Route[] = []

  async function walk(current: string, prefix: string[]): Promise<void> {
    const entries: Dirent[] = await fs.readdir(current, { withFileTypes: true })

    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) {
        assertSegment(entry.name, target)
        await walk(target, [...prefix, entry.name])
        continue
      }
      if (!entry.isFile()) continue

      const extension = extensions.find((candidate) => entry.name.endsWith(candidate))
      if (!extension) continue
      const stem = entry.name.slice(0, -extension.length)
      if (stem.endsWith('.d') || stem.endsWith('.test') || stem.endsWith('.spec')) continue
      assertSegment(stem, target)
      routes.push({ file: target, segments: [...prefix, stem] })
    }
  }

  await walk(directory, [])

  const seen = new Map<string, string>()
  for (const route of routes) {
    const name = route.segments.join(' ')
    const existing = seen.get(name)
    if (existing)
      throw new Error(
        `Duplicate filesystem command '${name}' from '${existing}' and '${route.file}'.`,
      )
    seen.set(name, route.file)
  }
  return routes
}

/** @internal Consumes the next manifest embedded by a standalone build. */
export function consumeManifest(): ManifestRoute[] | undefined {
  const global = globalThis as typeof globalThis & {
    [key: symbol]: ManifestRoute[][] | undefined
  }
  const manifests = global[Symbol.for(manifestKey)]
  return manifests?.shift()
}

function assertSegment(segment: string, source: string): void {
  if (segmentPattern.test(segment)) return
  throw new Error(
    `Invalid filesystem command segment '${segment}' from '${source}'. Use lowercase kebab-case names.`,
  )
}
