/** Structured input parsed from curl-style argv. */
export type FetchInput = {
  body: string | undefined
  headers: Headers
  method: string
  path: string
  query: URLSearchParams
}

/** Structured output from a fetch Response. */
export type FetchOutput = {
  data: unknown
  headers: Headers
  ok: boolean
  status: number
}

/** Reserved flags consumed by the fetch gateway (not forwarded as query params). */
const reservedFlags = new Set(['method', 'body', 'data', 'header'])
const reservedShort: Record<string, string> = { X: 'method', d: 'data', H: 'header' }

/** Parses curl-style argv into a structured fetch input. */
export function parseArgv(argv: string[]): FetchInput {
  const segments: string[] = []
  const headers = new Headers()
  const query = new URLSearchParams()
  let method: string | undefined
  let body: string | undefined

  let i = 0
  while (i < argv.length) {
    const token = argv[i]!

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx !== -1) {
        // --key=value
        const key = token.slice(2, eqIdx)
        const value = token.slice(eqIdx + 1)
        if (reservedFlags.has(key)) handleReserved(key, value)
        else query.set(key, value)
        i++
      } else {
        const key = token.slice(2)
        const value = argv[i + 1]
        if (value === undefined) throw new Error(`Missing value for --${key}`)
        if (reservedFlags.has(key)) handleReserved(key, value)
        else query.set(key, value)
        i += 2
      }
    } else if (token.startsWith('-') && token.length === 2) {
      const short = token[1]!
      const mapped = reservedShort[short]
      if (mapped) {
        const value = argv[i + 1]
        if (value === undefined) throw new Error(`Missing value for -${short}`)
        handleReserved(mapped, value)
        i += 2
      } else {
        // Unknown short flag — treat as single token, don't consume next
        i++
      }
    } else {
      segments.push(token)
      i++
    }
  }

  function handleReserved(key: string, value: string) {
    if (key === 'method') method = value.toUpperCase()
    else if (key === 'body' || key === 'data') body = value
    else if (key === 'header') {
      const colonIdx = value.indexOf(':')
      if (colonIdx !== -1) {
        const name = value.slice(0, colonIdx).trim()
        const val = value.slice(colonIdx + 1).trim()
        headers.set(name, val)
      }
    }
  }

  return {
    path: segments.length > 0 ? `/${segments.join('/')}` : '/',
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
    query,
  }
}

/** Constructs a standard Request from a FetchInput. */
export function buildRequest(input: FetchInput): Request {
  const url = new URL(input.path, 'http://localhost')
  input.query.forEach((value, key) => url.searchParams.set(key, value))

  const init: RequestInit = {
    method: input.method,
    headers: input.headers,
  }

  if (input.body !== undefined) {
    init.body = input.body
    if (!input.headers.has('content-type')) input.headers.set('content-type', 'application/json')
  }

  return new Request(url.toString(), init)
}

/** Returns true if the response body is a stream that should be consumed incrementally. */
export function isStreamingResponse(response: Response): boolean {
  return response.body !== null && response.headers.get('content-type') === 'application/x-ndjson'
}

/** Parses a streaming response body as an async generator of parsed NDJSON chunks. */
export async function* parseStreamingResponse(
  response: Response,
): AsyncGenerator<unknown, void, unknown> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      if (line.length === 0) continue
      try {
        yield JSON.parse(line)
      } catch {
        yield line
      }
    }
  }

  // flush remaining buffer
  const remaining = buffer.trim()
  if (remaining.length > 0) {
    try {
      yield JSON.parse(remaining)
    } catch {
      yield remaining
    }
  }
}

/** Parses a fetch Response into structured output. */
export async function parseResponse(response: Response): Promise<FetchOutput> {
  const text = await response.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    headers: response.headers,
  }
}
