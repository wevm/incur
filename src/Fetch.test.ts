import { describe, expect, test } from 'vitest'

import { app } from '../test/fixtures/hono-api.js'
import * as Fetch from './Fetch.js'

describe('parseArgv', () => {
  test('bare tokens → path segments', () => {
    const input = Fetch.parseArgv(['users', 'list'])
    expect(input.path).toBe('/users/list')
  })

  test('empty argv → root path', () => {
    const input = Fetch.parseArgv([])
    expect(input.path).toBe('/')
  })

  test('single token', () => {
    const input = Fetch.parseArgv(['health'])
    expect(input.path).toBe('/health')
  })

  test('default method is GET', () => {
    const input = Fetch.parseArgv(['users'])
    expect(input.method).toBe('GET')
  })

  test('-X sets method', () => {
    const input = Fetch.parseArgv(['users', '-X', 'POST'])
    expect(input.method).toBe('POST')
  })

  test('--method sets method', () => {
    const input = Fetch.parseArgv(['users', '--method', 'DELETE'])
    expect(input.method).toBe('DELETE')
  })

  test('default POST when body present', () => {
    const input = Fetch.parseArgv(['users', '--body', '{"name":"Eve"}'])
    expect(input.method).toBe('POST')
  })

  test('-d sets body', () => {
    const input = Fetch.parseArgv(['users', '-d', '{"name":"Bob"}'])
    expect(input.body).toBe('{"name":"Bob"}')
    expect(input.method).toBe('POST')
  })

  test('--data sets body', () => {
    const input = Fetch.parseArgv(['users', '--data', '{"x":1}'])
    expect(input.body).toBe('{"x":1}')
  })

  test('explicit method overrides body default', () => {
    const input = Fetch.parseArgv(['users', '-X', 'PUT', '-d', '{"name":"Bob"}'])
    expect(input.method).toBe('PUT')
  })

  test('-H sets header', () => {
    const input = Fetch.parseArgv(['users', '-H', 'X-Api-Key: secret'])
    expect(input.headers.get('X-Api-Key')).toBe('secret')
  })

  test('--header sets header', () => {
    const input = Fetch.parseArgv(['users', '--header', 'Authorization: Bearer tok'])
    expect(input.headers.get('Authorization')).toBe('Bearer tok')
  })

  test('multiple headers', () => {
    const input = Fetch.parseArgv(['users', '-H', 'X-A: 1', '-H', 'X-B: 2'])
    expect(input.headers.get('X-A')).toBe('1')
    expect(input.headers.get('X-B')).toBe('2')
  })

  test('unknown --key value → query params', () => {
    const input = Fetch.parseArgv(['users', '--limit', '5', '--sort', 'name'])
    expect(input.query.get('limit')).toBe('5')
    expect(input.query.get('sort')).toBe('name')
  })

  test('--key=value → query params', () => {
    const input = Fetch.parseArgv(['users', '--limit=5'])
    expect(input.query.get('limit')).toBe('5')
  })

  test('mixed tokens, flags, and query params', () => {
    const input = Fetch.parseArgv([
      'users',
      '42',
      '--limit',
      '5',
      '-X',
      'POST',
      '-d',
      '{"x":1}',
      '-H',
      'Auth: tok',
    ])
    expect(input.path).toBe('/users/42')
    expect(input.method).toBe('POST')
    expect(input.body).toBe('{"x":1}')
    expect(input.query.get('limit')).toBe('5')
    expect(input.headers.get('Auth')).toBe('tok')
  })
})

describe('buildRequest', () => {
  test('builds GET request with path', () => {
    const req = Fetch.buildRequest(Fetch.parseArgv(['users']))
    expect(req.method).toBe('GET')
    expect(new URL(req.url).pathname).toBe('/users')
  })

  test('builds request with query params', () => {
    const req = Fetch.buildRequest(Fetch.parseArgv(['users', '--limit', '5']))
    const url = new URL(req.url)
    expect(url.searchParams.get('limit')).toBe('5')
  })

  test('builds POST request with body', () => {
    const req = Fetch.buildRequest(Fetch.parseArgv(['users', '-X', 'POST', '-d', '{"name":"Bob"}']))
    expect(req.method).toBe('POST')
  })

  test('builds request with headers', () => {
    const req = Fetch.buildRequest(Fetch.parseArgv(['users', '-H', 'X-Api-Key: secret']))
    expect(req.headers.get('X-Api-Key')).toBe('secret')
  })
})

describe('parseResponse', () => {
  test('parses JSON response', async () => {
    const res = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.status).toBe(200)
    expect(output.data).toEqual({ ok: true })
  })

  test('parses text response', async () => {
    const res = new Response('hello world', { status: 200 })
    const output = await Fetch.parseResponse(res)
    expect(output.data).toBe('hello world')
  })

  test('error status → ok: false', async () => {
    const res = new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(false)
    expect(output.status).toBe(404)
    expect(output.data).toEqual({ message: 'not found' })
  })
})

describe('round-trip with Hono', () => {
  test('GET /users', async () => {
    const input = Fetch.parseArgv(['users'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toEqual({ users: [{ id: 1, name: 'Alice' }], limit: 10 })
  })

  test('GET /users?limit=5', async () => {
    const input = Fetch.parseArgv(['users', '--limit', '5'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toEqual({ users: [{ id: 1, name: 'Alice' }], limit: 5 })
  })

  test('GET /users/:id', async () => {
    const input = Fetch.parseArgv(['users', '42'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toEqual({ id: 42, name: 'Alice' })
  })

  test('POST /users with body', async () => {
    const input = Fetch.parseArgv(['users', '-X', 'POST', '-d', '{"name":"Bob"}'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.status).toBe(201)
    expect(output.data).toEqual({ created: true, name: 'Bob' })
  })

  test('POST /users with implicit method', async () => {
    const input = Fetch.parseArgv(['users', '--body', '{"name":"Eve"}'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toEqual({ created: true, name: 'Eve' })
  })

  test('DELETE /users/:id', async () => {
    const input = Fetch.parseArgv(['users', '1', '--method', 'DELETE'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toEqual({ deleted: true, id: 1 })
  })

  test('GET /health', async () => {
    const input = Fetch.parseArgv(['health'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toEqual({ ok: true })
  })

  test('GET /error → 404', async () => {
    const input = Fetch.parseArgv(['error'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(false)
    expect(output.status).toBe(404)
    expect(output.data).toEqual({ message: 'not found' })
  })

  test('GET /text → plain text', async () => {
    const input = Fetch.parseArgv(['text'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
    expect(output.data).toBe('hello world')
  })

  test('custom headers pass through', async () => {
    const input = Fetch.parseArgv(['users', '-H', 'X-Custom: hello'])
    const req = Fetch.buildRequest(input)
    expect(req.headers.get('X-Custom')).toBe('hello')
    const res = await app.fetch(req)
    const output = await Fetch.parseResponse(res)
    expect(output.ok).toBe(true)
  })

  test('streaming NDJSON response', async () => {
    const input = Fetch.parseArgv(['stream'])
    const req = Fetch.buildRequest(input)
    const res = await app.fetch(req)
    expect(Fetch.isStreamingResponse(res)).toBe(true)
    const chunks: unknown[] = []
    for await (const chunk of Fetch.parseStreamingResponse(res)) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([{ progress: 1 }, { progress: 2 }])
  })
})
