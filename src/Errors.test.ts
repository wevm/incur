import { Errors } from 'incur'

describe('BaseError', () => {
  test('extends Error and sets name', () => {
    const error = new Errors.BaseError('something went wrong')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('Incur.BaseError')
    expect(error.shortMessage).toBe('something went wrong')
    expect(error.message).toBe('something went wrong')
  })

  test('extracts details from cause', () => {
    const cause = new Error('connection refused')
    const error = new Errors.BaseError('request failed', { cause })
    expect(error.details).toBe('connection refused')
    expect(error.message).toMatchInlineSnapshot(`
      "request failed

      Details: connection refused"
    `)
  })

  test('walk() returns deepest cause', () => {
    const inner = new Error('root cause')
    const middle = new Errors.BaseError('mid', { cause: inner })
    const outer = new Errors.BaseError('top', { cause: middle })
    expect(outer.walk()).toBe(inner)
  })

  test('walk(fn) returns first matching cause', () => {
    const inner = new Errors.IncurError({ code: 'FOO', message: 'foo' })
    const outer = new Errors.BaseError('top', { cause: inner })
    expect(outer.walk((e) => e instanceof Errors.IncurError)).toBe(inner)
  })

  test('walk() without cause returns self', () => {
    const error = new Errors.BaseError('standalone')
    expect(error.walk()).toBe(error)
  })
})

describe('IncurError', () => {
  test('has code, hint, retryable', () => {
    const error = new Errors.IncurError({
      code: 'NOT_AUTHENTICATED',
      message: 'Token not found',
      hint: 'Set GH_TOKEN env var',
      retryable: false,
    })
    expect(error.name).toBe('Incur.IncurError')
    expect(error.code).toBe('NOT_AUTHENTICATED')
    expect(error.hint).toBe('Set GH_TOKEN env var')
    expect(error.retryable).toBe(false)
    expect(error).toBeInstanceOf(Errors.BaseError)
  })

  test('defaults retryable to false', () => {
    const error = new Errors.IncurError({ code: 'FAIL', message: 'fail' })
    expect(error.retryable).toBe(false)
  })
})

describe('ValidationError', () => {
  test('has fieldErrors', () => {
    const error = new Errors.ValidationError({
      message: 'Invalid arguments',
      fieldErrors: [
        {
          code: 'invalid_value',
          missing: false,
          path: 'state',
          expected: 'open | closed',
          received: 'invalid',
          message: 'Invalid enum value',
        },
      ],
    })
    expect(error.name).toBe('Incur.ValidationError')
    expect(error.fieldErrors).toEqual([
      {
        code: 'invalid_value',
        missing: false,
        path: 'state',
        expected: 'open | closed',
        received: 'invalid',
        message: 'Invalid enum value',
      },
    ])
    expect(error).toBeInstanceOf(Errors.BaseError)
  })
})

describe('ParseError', () => {
  test('sets name', () => {
    const error = new Errors.ParseError({ message: 'Unknown flag: --foo' })
    expect(error.name).toBe('Incur.ParseError')
    expect(error.shortMessage).toBe('Unknown flag: --foo')
    expect(error).toBeInstanceOf(Errors.BaseError)
  })
})
