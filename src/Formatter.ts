import { encode } from '@toon-format/toon'
import { stringify as yamlStringify } from 'yaml'

/** Supported output formats. */
export type Format = 'toon' | 'json' | 'yaml' | 'md' | 'jsonl'

/** Serializes a value to the specified format. Defaults to TOON. */
export function format(value: unknown, fmt: Format = 'toon'): string {
  if (value == null) return ''
  if (fmt === 'json') return JSON.stringify(value, null, 2)
  if (fmt === 'yaml') return yamlStringify(value)
  if (fmt === 'md') return formatMarkdown(value)
  // toon
  if (isScalar(value)) return String(value)
  return encode(value as Record<string, unknown>)
}

/** Whether a value is a scalar (string, number, boolean, null, undefined). */
function isScalar(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object'
}

/** Whether all values in an object are scalars. */
function isFlat(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every(isScalar)
}

/** Whether a value is an array of plain objects. */
function isArrayOfObjects(value: unknown): value is Record<string, unknown>[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))
  )
}

/** Renders an aligned markdown table from headers and rows. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const pad = (s: string, i: number) => s.padEnd(widths[i]!)
  const headerRow = `| ${headers.map(pad).join(' | ')} |`
  const sep = `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`
  const body = rows.map((r) => `| ${headers.map((_, i) => pad(r[i] ?? '', i)).join(' | ')} |`)
  return `${headerRow}\n${sep}\n${body.join('\n')}`
}

/** Renders a key-value table from a flat object. */
function kvTable(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
  return table(
    ['Key', 'Value'],
    entries.map(([k, v]) => [k, String(v)]),
  )
}

/** Renders a columnar table from an array of objects. */
function columnarTable(items: Record<string, unknown>[]): string {
  const keys = [...new Set(items.flatMap(Object.keys))]
  return table(
    keys,
    items.map((item) => keys.map((k) => String(item[k] ?? ''))),
  )
}

/** Formats a value as Markdown, recursing into nested objects. */
function formatMarkdown(value: unknown, path: string[] = []): string {
  if (isScalar(value)) {
    if (path.length === 0) return String(value)
    return `## ${path.join('.')}\n\n${String(value)}`
  }

  if (Array.isArray(value)) {
    if (isArrayOfObjects(value)) {
      const table = columnarTable(value)
      if (path.length === 0) return table
      return `## ${path.join('.')}\n\n${table}`
    }
    return formatMarkdown(String(value), path)
  }

  const obj = value as Record<string, unknown>
  const entries = Object.entries(obj)

  // Single flat object at root — no headings needed
  if (path.length === 0 && isFlat(obj)) return kvTable(obj)

  // Check if we need headings (mixed types or nested at root)
  const needsHeadings =
    path.length > 0 || entries.length > 1 || entries.some(([, v]) => !isScalar(v))

  if (needsHeadings) {
    const sections = entries.map(([key, val]) => {
      const childPath = [...path, key]
      if (isScalar(val)) return `## ${childPath.join('.')}\n\n${String(val)}`
      if (isArrayOfObjects(val)) return `## ${childPath.join('.')}\n\n${columnarTable(val)}`
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        const nested = val as Record<string, unknown>
        if (isFlat(nested)) return `## ${childPath.join('.')}\n\n${kvTable(nested)}`
        return formatMarkdown(nested, childPath)
      }
      return `## ${childPath.join('.')}\n\n${String(val)}`
    })
    return sections.join('\n\n')
  }

  return kvTable(obj)
}
