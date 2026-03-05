import { Filter } from 'incur'

describe('parse', () => {
  test('single key', () => {
    expect(Filter.parse('foo')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "foo",
          },
        ],
      ]
    `)
  })

  test('dot notation', () => {
    expect(Filter.parse('bar.baz')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "bar",
          },
          {
            "key": "baz",
          },
        ],
      ]
    `)
  })

  test('slice notation', () => {
    expect(Filter.parse('items[0,3]')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "items",
          },
          {
            "end": 3,
            "start": 0,
          },
        ],
      ]
    `)
  })

  test('mixed keys and slices', () => {
    expect(Filter.parse('a.b.c[0,10]')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "a",
          },
          {
            "key": "b",
          },
          {
            "key": "c",
          },
          {
            "end": 10,
            "start": 0,
          },
        ],
      ]
    `)
  })

  test('multiple paths', () => {
    expect(Filter.parse('name,age')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "name",
          },
        ],
        [
          {
            "key": "age",
          },
        ],
      ]
    `)
  })

  test('slice followed by dot path', () => {
    expect(Filter.parse('items[0,3].name')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "items",
          },
          {
            "end": 3,
            "start": 0,
          },
          {
            "key": "name",
          },
        ],
      ]
    `)
  })

  test('comma inside slice is not a separator', () => {
    expect(Filter.parse('foo,items[0,3],bar')).toMatchInlineSnapshot(`
      [
        [
          {
            "key": "foo",
          },
        ],
        [
          {
            "key": "items",
          },
          {
            "end": 3,
            "start": 0,
          },
        ],
        [
          {
            "key": "bar",
          },
        ],
      ]
    `)
  })
})

describe('apply', () => {
  test('selects single top-level key', () => {
    const data = { name: 'alice', age: 30, email: 'alice@example.com' }
    expect(Filter.apply(data, Filter.parse('name'))).toMatchInlineSnapshot(`"alice"`)
  })

  test('selects nested key with dot notation', () => {
    const data = { user: { name: 'alice', email: 'alice@example.com' }, status: 'active' }
    expect(Filter.apply(data, Filter.parse('user.name'))).toMatchInlineSnapshot(`
      {
        "user": {
          "name": "alice",
        },
      }
    `)
  })

  test('slices array', () => {
    const data = { items: [1, 2, 3, 4, 5] }
    expect(Filter.apply(data, Filter.parse('items[0,3]'))).toMatchInlineSnapshot(`
      {
        "items": [
          1,
          2,
          3,
        ],
      }
    `)
  })

  test('selects nested field after slice', () => {
    const data = {
      users: [
        { name: 'alice', age: 30 },
        { name: 'bob', age: 25 },
        { name: 'charlie', age: 35 },
      ],
    }
    expect(Filter.apply(data, Filter.parse('users[0,2].name'))).toMatchInlineSnapshot(`
      {
        "users": [
          {
            "name": "alice",
          },
          {
            "name": "bob",
          },
        ],
      }
    `)
  })

  test('multiple filter paths merged', () => {
    const data = { name: 'alice', age: 30, email: 'alice@example.com' }
    expect(Filter.apply(data, Filter.parse('name,age'))).toMatchInlineSnapshot(`
      {
        "age": 30,
        "name": "alice",
      }
    `)
  })

  test('returns scalar directly for single key selection', () => {
    const data = { message: 'hello world', status: 'ok' }
    const result = Filter.apply(data, Filter.parse('message'))
    expect(result).toBe('hello world')
  })

  test('returns object for single key with object value', () => {
    const data = { user: { name: 'alice' }, status: 'ok' }
    expect(Filter.apply(data, Filter.parse('user'))).toMatchInlineSnapshot(`
      {
        "user": {
          "name": "alice",
        },
      }
    `)
  })

  test('returns undefined for missing key', () => {
    const data = { name: 'alice' }
    expect(Filter.apply(data, Filter.parse('missing'))).toMatchInlineSnapshot(`undefined`)
  })

  test('applies filter to each element when data is array', () => {
    const data = [
      { name: 'alice', age: 30 },
      { name: 'bob', age: 25 },
    ]
    expect(Filter.apply(data, Filter.parse('name'))).toMatchInlineSnapshot(`
      [
        "alice",
        "bob",
      ]
    `)
  })

  test('empty paths returns data unchanged', () => {
    const data = { foo: 'bar' }
    expect(Filter.apply(data, [])).toMatchInlineSnapshot(`
      {
        "foo": "bar",
      }
    `)
  })
})
