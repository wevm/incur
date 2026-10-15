import { Mcp, z } from 'incur'
import { expectTypeOf, test } from 'vitest'

test('globals type flows to Mcp.serve middleware context', () => {
  void Mcp.serve('test', '1.0.0', new Map(), {
    globals: z.object({
      network: z.enum(['mainnet', 'testnet']).default('mainnet'),
      rpcUrl: z.string().transform((value) => new URL(value)),
    }),
    middlewares: [
      (c, next) => {
        expectTypeOf(c.globals).toEqualTypeOf<{ network: 'mainnet' | 'testnet'; rpcUrl: URL }>()
        return next()
      },
    ],
  })
})

test('without globals, Mcp.serve middleware sees empty globals', () => {
  void Mcp.serve('test', '1.0.0', new Map(), {
    middlewares: [
      (c, next) => {
        expectTypeOf(c.globals).toEqualTypeOf<{}>()
        return next()
      },
    ],
  })
})
