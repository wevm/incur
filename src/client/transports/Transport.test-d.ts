import { Cli } from 'incur'
import { HttpTransport, MemoryTransport, Resources, Rpc, Transport } from 'incur/client'
import { expectTypeOf, test } from 'vitest'

test('transport base types preserve discriminants and capabilities', async () => {
  expectTypeOf<Transport.TransportType>().toEqualTypeOf<'http' | 'memory'>()
  expectTypeOf<Transport.Config<'http'>['type']>().toEqualTypeOf<'http'>()
  expectTypeOf<Transport.Config<'memory'>['type']>().toEqualTypeOf<'memory'>()

  type Custom = Transport.Factory<'http', { ping(): Promise<'pong'> }>
  const custom = undefined as unknown as Custom
  const resolved = custom()
  expectTypeOf(resolved.config.type).toEqualTypeOf<'http'>()
  expectTypeOf(await resolved.ping()).toEqualTypeOf<'pong'>()
})

test('http and memory transport factories expose the expected resolved capabilities', async () => {
  const http = HttpTransport.create({ baseUrl: new URL('https://example.com') })
  const resolvedHttp = http()
  expectTypeOf(http).toEqualTypeOf<HttpTransport.HttpTransport>()
  expectTypeOf(resolvedHttp.config.type).toEqualTypeOf<'http'>()
  expectTypeOf(resolvedHttp.baseUrl).toEqualTypeOf<URL>()
  expectTypeOf(resolvedHttp.request).toEqualTypeOf<
    (request: Rpc.Request) => Promise<Rpc.Response | Rpc.StreamResponse>
  >()
  expectTypeOf(resolvedHttp.discover).toEqualTypeOf<
    (request: Resources.Request) => Promise<Resources.Response>
  >()
  // @ts-expect-error HTTP transports do not expose local methods.
  void resolvedHttp.local

  const memory = MemoryTransport.create(Cli.create('app'))
  const resolvedMemory = memory()
  expectTypeOf(memory).toEqualTypeOf<MemoryTransport.MemoryTransport>()
  expectTypeOf(resolvedMemory.config.type).toEqualTypeOf<'memory'>()
  expectTypeOf(resolvedMemory.local.skills.add).toBeFunction()
  expectTypeOf(resolvedMemory.local.skills.list).toBeFunction()
  expectTypeOf(resolvedMemory.local.mcp.add).toBeFunction()
  // @ts-expect-error memory transports do not expose an HTTP base URL.
  void resolvedMemory.baseUrl
})

test('transport option types reject invalid values', () => {
  HttpTransport.create({ baseUrl: 'https://example.com', headers: [['x-test', 'yes']] })
  HttpTransport.create({ baseUrl: new URL('https://example.com'), fetch: globalThis.fetch })
  MemoryTransport.create(Cli.create('app'), { env: { TOKEN: undefined } })
  // @ts-expect-error baseUrl is required.
  HttpTransport.create({})
  // @ts-expect-error baseUrl must be a string or URL.
  HttpTransport.create({ baseUrl: 123 })
  // @ts-expect-error env values must be strings or undefined.
  MemoryTransport.create(Cli.create('app'), { env: { TOKEN: 123 } })
})
