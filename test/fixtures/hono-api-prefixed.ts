import { Hono } from 'hono'

const app = new Hono()

app.get('/api/users', (c) => {
  const limit = c.req.query('limit')
  return c.json({ users: [{ id: 1, name: 'Alice' }], limit: limit ? Number(limit) : 10 })
})

app.get('/api/users/:id', (c) => {
  return c.json({ id: Number(c.req.param('id')), name: 'Alice' })
})

app.post('/api/users', async (c) => {
  const body = await c.req.json()
  return c.json({ created: true, ...body }, 201)
})

app.get('/api/health', (c) => c.json({ ok: true }))

export { app }
