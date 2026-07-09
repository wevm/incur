import { z } from 'zod'

import * as Cli from './Cli.js'
import middleware from './middleware.js'

test('returns the handler unchanged', () => {
  const handler = vi.fn()
  expect(middleware(handler)).toBe(handler)
})

test('HTTP route exposes inbound request to middleware context', async () => {
  const vars = z.object({ authorization: z.string().nullable().default(null) })
  const cli = Cli.create('test', { vars })
    .use(
      middleware<typeof vars>((c, next) => {
        c.set('authorization', c.request?.headers.get('authorization') ?? null)
        return next()
      }),
    )
    .command('auth', {
      run: (c) => ({ authorization: c.var.authorization }),
    })

  const res = await cli.fetch(
    new Request('http://localhost/auth', { headers: { authorization: 'Bearer t' } }),
  )

  expect(await res.json()).toMatchObject({
    ok: true,
    data: { authorization: 'Bearer t' },
  })
})
