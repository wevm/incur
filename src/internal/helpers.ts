/** Checks whether a value is a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Converts a camelCase string to kebab-case. */
export function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** Computes the Levenshtein edit distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!)
      prev = tmp
    }
  }
  return dp[n]!
}

/** Suggests the closest command name from a set, returning it if within a reasonable edit distance. */
export function suggest(input: string, candidates: Iterable<string>): string | undefined {
  const threshold = input.length <= 4 ? 2 : Math.floor(input.length / 2)
  const lower = input.toLowerCase()
  const all = Array.isArray(candidates) ? candidates : [...candidates]

  let best: string | undefined
  let bestScore = Infinity

  for (const c of all) {
    const lc = c.toLowerCase()
    const dist = levenshtein(lower, lc)

    let score: number
    if (lc.startsWith(lower) && lc !== lower)
      // prefix match — best tier
      score = dist
    else if (lc.includes(lower))
      // contains match — middle tier
      score = 100 + dist
    else if (dist <= threshold)
      // fuzzy match — last tier
      score = 200 + dist
    else continue

    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}
