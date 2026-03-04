import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

const app = new OpenAPIHono()

const listUsers = createRoute({
  method: 'get',
  path: '/users',
  operationId: 'listUsers',
  request: {
    query: z.object({
      limit: z.coerce.number().optional().openapi({ example: 10, description: 'Max results' }),
    }),
  },
  responses: {
    200: {
      description: 'User list',
      content: {
        'application/json': {
          schema: z.object({
            users: z.array(z.object({ id: z.number(), name: z.string() })),
            limit: z.number(),
          }),
        },
      },
    },
  },
})

app.openapi(listUsers, (c) => {
  const { limit } = c.req.valid('query')
  return c.json({ users: [{ id: 1, name: 'Alice' }], limit: limit ?? 10 }, 200)
})

const getUser = createRoute({
  method: 'get',
  path: '/users/{id}',
  operationId: 'getUser',
  request: {
    params: z.object({
      id: z.coerce.number().openapi({ param: { name: 'id', in: 'path' }, example: 42 }),
    }),
  },
  responses: {
    200: {
      description: 'User detail',
      content: {
        'application/json': {
          schema: z.object({ id: z.number(), name: z.string() }),
        },
      },
    },
  },
})

app.openapi(getUser, (c) => {
  const { id } = c.req.valid('param')
  return c.json({ id, name: 'Alice' }, 200)
})

const createUser = createRoute({
  method: 'post',
  path: '/users',
  operationId: 'createUser',
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().openapi({ example: 'Bob' }),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Created',
      content: {
        'application/json': {
          schema: z.object({ created: z.boolean(), name: z.string() }),
        },
      },
    },
  },
})

app.openapi(createUser, async (c) => {
  const body = c.req.valid('json')
  return c.json({ created: true, name: body.name }, 201)
})

const deleteUser = createRoute({
  method: 'delete',
  path: '/users/{id}',
  operationId: 'deleteUser',
  request: {
    params: z.object({
      id: z.coerce.number().openapi({ param: { name: 'id', in: 'path' }, example: 1 }),
    }),
  },
  responses: {
    200: {
      description: 'Deleted',
      content: {
        'application/json': {
          schema: z.object({ deleted: z.boolean(), id: z.number() }),
        },
      },
    },
  },
})

app.openapi(deleteUser, (c) => {
  const { id } = c.req.valid('param')
  return c.json({ deleted: true, id }, 200)
})

const healthCheck = createRoute({
  method: 'get',
  path: '/health',
  operationId: 'healthCheck',
  responses: {
    200: {
      description: 'OK',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    },
  },
})

app.openapi(healthCheck, (c) => c.json({ ok: true }, 200))

const updateUser = createRoute({
  method: 'put',
  path: '/users/{id}',
  operationId: 'updateUser',
  summary: 'Update a user',
  request: {
    params: z.object({
      id: z.coerce.number().openapi({ param: { name: 'id', in: 'path' }, example: 1 }),
    }),
    body: {
      required: true,
      content: {
        'application/json': {
          schema: z.object({
            name: z.string().openapi({ example: 'Updated' }),
            active: z.boolean().optional().openapi({ example: true, description: 'Whether user is active' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated',
      content: {
        'application/json': {
          schema: z.object({ id: z.number(), name: z.string(), active: z.boolean().optional() }),
        },
      },
    },
  },
})

app.openapi(updateUser, async (c) => {
  const { id } = c.req.valid('param')
  const body = c.req.valid('json')
  return c.json({ id, name: body.name, ...(body.active !== undefined ? { active: body.active } : {}) }, 200)
})

/** Extract the OpenAPI spec as a plain object. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- avoid TS2742 portability error
const spec: any = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: { title: 'Test API', version: '1.0.0' },
})

export { app, spec }
