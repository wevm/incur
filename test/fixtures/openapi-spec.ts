/** Sample OpenAPI 3.0 spec describing the Hono test fixture routes. */
export const spec = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List users',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'number' },
            description: 'Max results',
          },
        ],
        responses: {
          '200': {
            description: 'User list',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a user',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        summary: 'Get a user by ID',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'number' },
            description: 'User ID',
          },
        ],
        responses: {
          '200': {
            description: 'User detail',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
      delete: {
        operationId: 'deleteUser',
        summary: 'Delete a user',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'number' },
            description: 'User ID',
          },
        ],
        responses: {
          '200': {
            description: 'Deleted',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/health': {
      get: {
        operationId: 'healthCheck',
        summary: 'Health check',
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
} as const
