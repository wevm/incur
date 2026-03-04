import { Hono } from 'hono'

const app = new Hono()

app.get('/users', (c) => {
  const limit = c.req.query('limit')
  return c.json({ users: [{ id: 1, name: 'Alice' }], limit: limit ? Number(limit) : 10 })
})

app.get('/users/:id', (c) => {
  const id = c.req.param('id')
  return c.json({ id: Number(id), name: 'Alice' })
})

app.post('/users', async (c) => {
  const body = await c.req.json()
  return c.json({ created: true, ...body }, 201)
})

app.delete('/users/:id', (c) => {
  return c.json({ deleted: true, id: Number(c.req.param('id')) })
})

app.get('/health', (c) => c.json({ ok: true }))

app.get('/error', (c) => c.json({ message: 'not found' }, 404))

app.get('/text', (c) => c.text('hello world'))

app.get('/stream', (c) => {
  return c.newResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"progress":1}\n'))
        controller.enqueue(new TextEncoder().encode('{"progress":2}\n'))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  )
})

export { app }
