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
