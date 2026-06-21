/** Serializes JSON with BigInt values represented as decimal strings. */
export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_key, value) => {
      if (typeof value === 'bigint') return value.toString()
      return value
    },
    space,
  )
}

/** Converts a value to JSON-compatible data. */
export function normalize(value: unknown): unknown {
  return JSON.parse(stringify(value))
}
