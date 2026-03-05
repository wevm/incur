/** A single segment in a filter path: either a string key or an array slice. */
export type Segment = { key: string } | { start: number; end: number }

/** A filter path is an ordered list of segments to traverse. */
export type FilterPath = Segment[]

/** Parses a filter expression string into structured filter paths. */
export function parse(expression: string): FilterPath[] {
  const paths: FilterPath[] = []
  const tokens: string[] = []
  let current = ''
  let depth = 0

  // Split on commas, but commas inside [...] are part of a slice
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i]!
    if (ch === '[') depth++
    else if (ch === ']') depth--

    if (ch === ',' && depth === 0) {
      tokens.push(current)
      current = ''
    } else current += ch
  }
  if (current) tokens.push(current)

  for (const token of tokens) {
    const path: FilterPath = []
    let remaining = token

    while (remaining.length > 0) {
      const bracketIdx = remaining.indexOf('[')

      if (bracketIdx === -1) {
        // No more slices — split remaining by dots
        for (const part of remaining.split('.')) if (part) path.push({ key: part })
        break
      }

      // Parse dot-separated keys before the bracket
      const before = remaining.slice(0, bracketIdx)
      for (const part of before.split('.')) if (part) path.push({ key: part })

      // Parse the slice [start,end]
      const closeBracket = remaining.indexOf(']', bracketIdx)
      const inner = remaining.slice(bracketIdx + 1, closeBracket)
      const [startStr, endStr] = inner.split(',')
      path.push({ start: Number(startStr), end: Number(endStr) })

      remaining = remaining.slice(closeBracket + 1)
      if (remaining.startsWith('.')) remaining = remaining.slice(1)
    }

    paths.push(path)
  }

  return paths
}

/** Applies parsed filter paths to a data value, returning a filtered copy. */
export function apply(data: unknown, paths: FilterPath[]): unknown {
  if (paths.length === 0) return data

  // Single key selecting a scalar → return the scalar directly
  if (paths.length === 1 && paths[0]!.length === 1 && 'key' in paths[0]![0]!) {
    const key = paths[0]![0]!.key
    if (Array.isArray(data)) return data.map((item) => apply(item, paths))
    if (typeof data === 'object' && data !== null) {
      const val = (data as Record<string, unknown>)[key]
      if (typeof val !== 'object' || val === null) return val
      return { [key]: val }
    }
    return undefined
  }

  if (Array.isArray(data)) return data.map((item) => apply(item, paths))

  const result: Record<string, unknown> = {}
  for (const path of paths) merge(result, data, path, 0)
  return result
}

function resolve(data: unknown, segments: Segment[], index: number): unknown {
  if (index >= segments.length) return data
  const segment = segments[index]!

  if ('key' in segment) {
    if (typeof data !== 'object' || data === null) return undefined
    const val = (data as Record<string, unknown>)[segment.key]
    return resolve(val, segments, index + 1)
  }

  // slice segment
  if (!Array.isArray(data)) return undefined
  const sliced = data.slice(segment.start, segment.end)
  if (index + 1 >= segments.length) return sliced
  return sliced.map((item) => resolve(item, segments, index + 1))
}

function merge(target: Record<string, unknown>, data: unknown, segments: Segment[], index: number): void {
  if (index >= segments.length || typeof data !== 'object' || data === null) return
  const segment = segments[index]!

  if ('key' in segment) {
    const val = (data as Record<string, unknown>)[segment.key]
    if (val === undefined) return

    if (index + 1 >= segments.length) {
      target[segment.key] = val
      return
    }

    const next = segments[index + 1]!
    if ('start' in next) {
      // Next segment is a slice
      if (!Array.isArray(val)) return
      const sliced = val.slice(next.start, next.end)
      if (index + 2 >= segments.length) {
        target[segment.key] = sliced
        return
      }
      target[segment.key] = sliced.map((item) => {
        const sub: Record<string, unknown> = {}
        merge(sub, item, segments, index + 2)
        return sub
      })
      return
    }

    // Next segment is a key — recurse into nested object
    if (typeof val !== 'object' || val === null) return
    if (!target[segment.key] || typeof target[segment.key] !== 'object')
      target[segment.key] = {}
    merge(target[segment.key] as Record<string, unknown>, val, segments, index + 1)
    return
  }

  // slice at root level — shouldn't happen in merge (merge starts from object keys)
}
