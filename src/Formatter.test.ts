import { decode } from '@toon-format/toon'
import { Formatter } from 'incur'

describe('format', () => {
  test('formats success envelope as TOON', () => {
    const result = Formatter.format({
      ok: true,
      data: { message: 'hello world' },
      meta: { command: 'greet', duration: '0ms' },
    })

    expect(result).toMatchInlineSnapshot(`
      "ok: true
      data:
        message: hello world
      meta:
        command: greet
        duration: 0ms"
    `)
  })

  test('formats error envelope as TOON', () => {
    const result = Formatter.format({
      ok: false,
      error: { code: 'UNKNOWN', message: 'boom' },
      meta: { command: 'fail', duration: '0ms' },
    })

    expect(result).toMatchInlineSnapshot(`
      "ok: false
      error:
        code: UNKNOWN
        message: boom
      meta:
        command: fail
        duration: 0ms"
    `)
  })

  test('round-trips through TOON decode', () => {
    const envelope = {
      ok: true,
      data: { items: [1, 2, 3] },
      meta: { command: 'list', duration: '5ms' },
    }

    const result = decode(Formatter.format(envelope))
    expect(result).toMatchObject(envelope)
  })

  test('formats as TOON (explicit)', () => {
    const result = Formatter.format({ message: 'hello' }, 'toon')
    expect(result).toMatchInlineSnapshot(`"message: hello"`)
  })

  test('formats as JSON', () => {
    const result = Formatter.format({ message: 'hello' }, 'json')
    expect(result).toMatchInlineSnapshot(`
      "{
        "message": "hello"
      }"
    `)
  })

  test('formats as YAML', () => {
    const result = Formatter.format({ message: 'hello' }, 'yaml')
    expect(result).toMatchInlineSnapshot(`
      "message: hello
      "
    `)
  })

  test('defaults to TOON when no format specified', () => {
    const result = Formatter.format({ message: 'hello' })
    expect(result).toMatchInlineSnapshot(`"message: hello"`)
  })

  test('formats string value as-is', () => {
    expect(Formatter.format('hello world')).toBe('hello world')
    expect(Formatter.format('hello world', 'json')).toBe('"hello world"')
    expect(Formatter.format('hello world', 'md')).toBe('hello world')
  })

  test('formats number value', () => {
    expect(Formatter.format(42)).toBe('42')
    expect(Formatter.format(42, 'json')).toBe('42')
  })

  test('returns empty string for undefined', () => {
    expect(Formatter.format(undefined)).toBe('')
    expect(Formatter.format(undefined, 'json')).toBe('')
    expect(Formatter.format(undefined, 'yaml')).toBe('')
    expect(Formatter.format(undefined, 'md')).toBe('')
  })

  test('returns empty string for null', () => {
    expect(Formatter.format(null)).toBe('')
    expect(Formatter.format(null, 'json')).toBe('')
    expect(Formatter.format(null, 'yaml')).toBe('')
    expect(Formatter.format(null, 'md')).toBe('')
  })
})

describe('format md', () => {
  test('formats flat object as key-value table', () => {
    const result = Formatter.format({ message: 'hello', status: 'ok' }, 'md')
    expect(result).toMatchInlineSnapshot(`
      "| Key     | Value |
      |---------|-------|
      | message | hello |
      | status  | ok    |"
    `)
  })

  test('formats array of objects as columnar table', () => {
    const result = Formatter.format(
      {
        items: [
          { name: 'a', state: 'open' },
          { name: 'b', state: 'closed' },
        ],
      },
      'md',
    )
    expect(result).toMatchInlineSnapshot(`
      "## items

      | name | state  |
      |------|--------|
      | a    | open   |
      | b    | closed |"
    `)
  })

  test('formats mixed top-level with headings', () => {
    const result = Formatter.format({ items: [{ name: 'a' }], total: 2 }, 'md')
    expect(result).toMatchInlineSnapshot(`
      "## items

      | name |
      |------|
      | a    |

      ## total

      2"
    `)
  })

  test('formats nested objects with dot-delimited path heading', () => {
    const result = Formatter.format({ config: { db: { host: 'localhost', port: 5432 } } }, 'md')
    expect(result).toMatchInlineSnapshot(`
      "## config.db

      | Key  | Value     |
      |------|-----------|
      | host | localhost |
      | port | 5432      |"
    `)
  })

  test('formats deeply nested with multiple branches', () => {
    const result = Formatter.format(
      {
        server: {
          http: { host: '0.0.0.0', port: 3000 },
          tls: { enabled: true, cert: '/etc/ssl/cert.pem' },
        },
        database: {
          primary: { host: 'db1.internal', port: 5432, pool: 10 },
        },
      },
      'md',
    )
    expect(result).toMatchInlineSnapshot(`
      "## server.http

      | Key  | Value   |
      |------|---------|
      | host | 0.0.0.0 |
      | port | 3000    |

      ## server.tls

      | Key     | Value             |
      |---------|-------------------|
      | enabled | true              |
      | cert    | /etc/ssl/cert.pem |

      ## database.primary

      | Key  | Value        |
      |------|--------------|
      | host | db1.internal |
      | port | 5432         |
      | pool | 10           |"
    `)
  })

  test('formats mixed scalars, arrays, and nested at top level', () => {
    const result = Formatter.format(
      {
        name: 'my-project',
        version: '1.0.0',
        dependencies: [
          { name: 'zod', version: '4.3.6' },
          { name: 'yaml', version: '2.8.2' },
        ],
        config: { debug: false, logLevel: 'info' },
      },
      'md',
    )
    expect(result).toMatchInlineSnapshot(`
      "## name

      my-project

      ## version

      1.0.0

      ## dependencies

      | name | version |
      |------|---------|
      | zod  | 4.3.6   |
      | yaml | 2.8.2   |

      ## config

      | Key      | Value |
      |----------|-------|
      | debug    | false |
      | logLevel | info  |"
    `)
  })

  test('formats single-key wrapper with array of objects', () => {
    const result = Formatter.format(
      {
        users: [
          { id: 1, name: 'Alice', role: 'admin' },
          { id: 2, name: 'Bob', role: 'user' },
          { id: 3, name: 'Charlie', role: 'user' },
        ],
      },
      'md',
    )
    expect(result).toMatchInlineSnapshot(`
      "## users

      | id | name    | role  |
      |----|---------|-------|
      | 1  | Alice   | admin |
      | 2  | Bob     | user  |
      | 3  | Charlie | user  |"
    `)
  })
})
