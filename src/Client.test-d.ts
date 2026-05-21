import { expectTypeOf, test } from 'vitest'

import * as Client from './Client.js'

test('types data calls from explicit output generics', () => {
  const context = Client.create({
    transport: async () => ({
      ok: true,
      data: { id: 1 },
      meta: { command: 'read', duration: '1ms' },
    }),
  })

  expectTypeOf(
    Client.call<{ id: number }>(context, ['read'], { args: { id: '1' } }),
  ).resolves.toEqualTypeOf<{ id: number }>()
})

test('types result calls from explicit output and error generics', () => {
  const context = Client.create({
    transport: async () => ({
      ok: true,
      data: { value: 'ok' },
      meta: { command: 'read', duration: '1ms' },
    }),
  })

  expectTypeOf(
    Client.result<{ value: string }, { message: string }>(context, ['read']),
  ).resolves.toEqualTypeOf<Client.Result<{ value: string }, { message: string }>>()
})
