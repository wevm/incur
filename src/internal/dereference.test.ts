import { describe, expect, test } from 'vitest'

import { dereference } from './dereference.js'

describe('dereference', () => {
  test('resolves basic $ref', () => {
    const spec = {
      paths: {
        '/users': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      },
    }
    const result = dereference(spec) as any
    expect(result.paths['/users'].get.responses['200'].content['application/json'].schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    })
  })

  test('resolves nested $ref (ref target contains another ref)', () => {
    const spec = {
      components: {
        schemas: {
          Name: { type: 'string' },
          User: {
            type: 'object',
            properties: { name: { $ref: '#/components/schemas/Name' } },
          },
        },
      },
      root: { $ref: '#/components/schemas/User' },
    }
    const result = dereference(spec) as any
    expect(result.root).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    })
  })

  test('handles circular $ref without infinite loop', () => {
    const spec = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              child: { $ref: '#/components/schemas/Node' },
            },
          },
        },
      },
      root: { $ref: '#/components/schemas/Node' },
    }
    const result = dereference(spec) as any
    // Should resolve without hanging
    expect(result.root.type).toBe('object')
    expect(result.root.properties.value).toEqual({ type: 'string' })
    // Circular ref should point back to the same resolved object
    expect(result.root.properties.child).toBe(result.root)
  })

  test('resolves multiple refs to same target (shares identity)', () => {
    const spec = {
      components: { schemas: { Id: { type: 'number' } } },
      a: { $ref: '#/components/schemas/Id' },
      b: { $ref: '#/components/schemas/Id' },
    }
    const result = dereference(spec) as any
    expect(result.a).toEqual({ type: 'number' })
    expect(result.a).toBe(result.b)
  })

  test('resolves $ref in arrays', () => {
    const spec = {
      components: { schemas: { Tag: { type: 'string' } } },
      items: [{ $ref: '#/components/schemas/Tag' }, { $ref: '#/components/schemas/Tag' }],
    }
    const result = dereference(spec) as any
    expect(result.items[0]).toEqual({ type: 'string' })
    expect(result.items[1]).toEqual({ type: 'string' })
  })

  test('handles deeply nested path', () => {
    const spec = {
      a: { b: { c: { d: { value: 42 } } } },
      ref: { $ref: '#/a/b/c/d' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual({ value: 42 })
  })

  test('handles JSON Pointer escaping (~0 for ~, ~1 for /)', () => {
    const spec = {
      'a/b': { 'c~d': { value: 'escaped' } },
      ref: { $ref: '#/a~1b/c~0d' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual({ value: 'escaped' })
  })

  test('throws on unresolvable $ref', () => {
    const spec = { ref: { $ref: '#/does/not/exist' } }
    expect(() => dereference(spec)).toThrow('Cannot resolve $ref')
  })

  test('passes through primitives unchanged', () => {
    expect(dereference('hello')).toBe('hello')
    expect(dereference(42)).toBe(42)
    expect(dereference(null)).toBe(null)
    expect(dereference(true)).toBe(true)
  })

  test('does not mutate original object', () => {
    const spec = {
      components: { schemas: { User: { type: 'object' } } },
      ref: { $ref: '#/components/schemas/User' },
    }
    const original = JSON.stringify(spec)
    dereference(spec)
    expect(JSON.stringify(spec)).toBe(original)
  })

  test('resolves $ref: "#" to root', () => {
    const spec = { type: 'object', self: { $ref: '#' } }
    const result = dereference(spec) as any
    expect(result.self.type).toBe('object')
  })

  test('realistic OpenAPI spec with shared parameter and request body refs', () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            parameters: [{ $ref: '#/components/parameters/UserId' }],
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/User' },
                  },
                },
              },
            },
          },
          put: {
            operationId: 'updateUser',
            parameters: [{ $ref: '#/components/parameters/UserId' }],
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UserInput' },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          UserId: {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'number' },
          },
        },
        schemas: {
          User: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              name: { type: 'string' },
            },
          },
          UserInput: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
    }
    const result = dereference(spec) as any
    const getParams = result.paths['/users/{id}'].get.parameters
    expect(getParams[0].name).toBe('id')
    expect(getParams[0].in).toBe('path')
    // Both GET and PUT share the same resolved parameter
    const putParams = result.paths['/users/{id}'].put.parameters
    expect(putParams[0]).toBe(getParams[0])
    // Request body schema resolved
    const bodySchema =
      result.paths['/users/{id}'].put.requestBody.content['application/json'].schema
    expect(bodySchema.properties.name).toEqual({ type: 'string' })
    expect(bodySchema.required).toEqual(['name'])
  })

  test('mutual circular refs', () => {
    const spec = {
      components: {
        schemas: {
          A: {
            type: 'object',
            properties: { b: { $ref: '#/components/schemas/B' } },
          },
          B: {
            type: 'object',
            properties: { a: { $ref: '#/components/schemas/A' } },
          },
        },
      },
      root: { $ref: '#/components/schemas/A' },
    }
    const result = dereference(spec) as any
    expect(result.root.type).toBe('object')
    expect(result.root.properties.b.type).toBe('object')
    expect(result.root.properties.b.properties.a).toBe(result.root)
  })

  test('$ref target is a primitive (string)', () => {
    const spec = {
      components: { values: { name: 'Alice' } },
      ref: { $ref: '#/components/values/name' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toBe('Alice')
  })

  test('$ref target is a primitive (number)', () => {
    const spec = {
      components: { values: { count: 42 } },
      ref: { $ref: '#/components/values/count' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toBe(42)
  })

  test('$ref target is null', () => {
    const spec = {
      components: { values: { empty: null } },
      ref: { $ref: '#/components/values/empty' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toBe(null)
  })

  test('$ref target is an array', () => {
    const spec = {
      components: { values: { tags: ['a', 'b', 'c'] } },
      ref: { $ref: '#/components/values/tags' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual(['a', 'b', 'c'])
  })

  test('$ref to array element by index', () => {
    const spec = {
      items: [{ name: 'first' }, { name: 'second' }],
      ref: { $ref: '#/items/1' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual({ name: 'second' })
  })

  test('chain of refs (A -> B -> C)', () => {
    const spec = {
      a: { $ref: '#/b' },
      b: { $ref: '#/c' },
      c: { value: 'end' },
    }
    const result = dereference(spec) as any
    expect(result.a).toEqual({ value: 'end' })
    expect(result.b).toEqual({ value: 'end' })
  })

  test('triple circular (A -> B -> C -> A)', () => {
    const spec = {
      components: {
        schemas: {
          A: { type: 'A', next: { $ref: '#/components/schemas/B' } },
          B: { type: 'B', next: { $ref: '#/components/schemas/C' } },
          C: { type: 'C', next: { $ref: '#/components/schemas/A' } },
        },
      },
      root: { $ref: '#/components/schemas/A' },
    }
    const result = dereference(spec) as any
    expect(result.root.type).toBe('A')
    expect(result.root.next.type).toBe('B')
    expect(result.root.next.next.type).toBe('C')
    expect(result.root.next.next.next).toBe(result.root)
  })

  test('$ref with sibling properties (OpenAPI 3.1 style)', () => {
    const spec = {
      components: {
        schemas: {
          User: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
      ref: {
        $ref: '#/components/schemas/User',
        description: 'A user object',
      },
    }
    const result = dereference(spec) as any
    // siblings are dropped (ref replaces the whole node)
    expect(result.ref.type).toBe('object')
    expect(result.ref.description).toBeUndefined()
  })

  test('root is an array', () => {
    const root = [{ a: 1 }, { b: 2 }]
    const result = dereference(root) as any
    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })

  test('empty object', () => {
    expect(dereference({})).toEqual({})
  })

  test('$ref "#/" resolves to root', () => {
    const spec = { type: 'root', self: { $ref: '#/' } }
    const result = dereference(spec) as any
    expect(result.self.type).toBe('root')
  })

  test('falsy primitive targets (false, 0, empty string)', () => {
    const spec = {
      vals: { a: false, b: 0, c: '' },
      refA: { $ref: '#/vals/a' },
      refB: { $ref: '#/vals/b' },
      refC: { $ref: '#/vals/c' },
    }
    const result = dereference(spec) as any
    expect(result.refA).toBe(false)
    expect(result.refB).toBe(0)
    expect(result.refC).toBe('')
  })

  test('$ref target is an empty array', () => {
    const spec = {
      vals: { empty: [] as unknown[] },
      ref: { $ref: '#/vals/empty' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual([])
  })

  test('$ref target is an empty object', () => {
    const spec = {
      vals: { empty: {} },
      ref: { $ref: '#/vals/empty' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual({})
  })

  test('chained ref to primitive (A -> B -> string)', () => {
    const spec = {
      vals: { greeting: 'hello' },
      b: { $ref: '#/vals/greeting' },
      a: { $ref: '#/b' },
    }
    const result = dereference(spec) as any
    expect(result.a).toBe('hello')
    expect(result.b).toBe('hello')
  })

  test('$ref with non-string value is treated as normal object', () => {
    const spec = { obj: { $ref: 123, other: 'value' } }
    const result = dereference(spec) as any
    expect(result.obj).toEqual({ $ref: 123, other: 'value' })
  })

  test('$ref that does not start with # is left as-is', () => {
    const spec = { obj: { $ref: 'http://example.com/schema.json' } }
    const result = dereference(spec) as any
    expect(result.obj).toEqual({ $ref: 'http://example.com/schema.json' })
  })

  test('$ref inside array inside a $ref target', () => {
    const spec = {
      components: {
        schemas: {
          Tag: { type: 'string' },
          User: {
            type: 'object',
            properties: {
              tags: {
                type: 'array',
                items: { $ref: '#/components/schemas/Tag' },
              },
            },
          },
        },
      },
      root: { $ref: '#/components/schemas/User' },
    }
    const result = dereference(spec) as any
    expect(result.root.properties.tags.items).toEqual({ type: 'string' })
  })

  test('allOf/oneOf/anyOf with $ref items', () => {
    const spec = {
      components: {
        schemas: {
          Name: { type: 'string' },
          Age: { type: 'number' },
        },
      },
      root: {
        allOf: [
          { $ref: '#/components/schemas/Name' },
          { $ref: '#/components/schemas/Age' },
        ],
      },
    }
    const result = dereference(spec) as any
    expect(result.root.allOf[0]).toEqual({ type: 'string' })
    expect(result.root.allOf[1]).toEqual({ type: 'number' })
  })

  test('$ref inside deeply nested arrays', () => {
    const spec = {
      vals: { x: { value: 1 } },
      nested: [[{ $ref: '#/vals/x' }]],
    }
    const result = dereference(spec) as any
    expect(result.nested[0][0]).toEqual({ value: 1 })
  })

  test('circular ref inside an array (items ref self)', () => {
    const spec = {
      components: {
        schemas: {
          Tree: {
            type: 'object',
            properties: {
              children: {
                type: 'array',
                items: { $ref: '#/components/schemas/Tree' },
              },
            },
          },
        },
      },
      root: { $ref: '#/components/schemas/Tree' },
    }
    const result = dereference(spec) as any
    expect(result.root.type).toBe('object')
    expect(result.root.properties.children.items).toBe(result.root)
  })

  test('$ref target is a boolean true', () => {
    const spec = {
      vals: { flag: true },
      ref: { $ref: '#/vals/flag' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toBe(true)
  })

  test('same $ref used in different subtrees resolves identically', () => {
    const spec = {
      components: { schemas: { S: { type: 'object' } } },
      tree: {
        left: { schema: { $ref: '#/components/schemas/S' } },
        right: { schema: { $ref: '#/components/schemas/S' } },
      },
    }
    const result = dereference(spec) as any
    expect(result.tree.left.schema).toBe(result.tree.right.schema)
  })

  test('ref target with array value containing refs', () => {
    const spec = {
      components: {
        schemas: { Tag: { type: 'string' } },
        lists: {
          tags: [{ $ref: '#/components/schemas/Tag' }, { literal: true }],
        },
      },
      ref: { $ref: '#/components/lists/tags' },
    }
    const result = dereference(spec) as any
    expect(result.ref[0]).toEqual({ type: 'string' })
    expect(result.ref[1]).toEqual({ literal: true })
  })

  test('root object is itself a $ref (self-referential)', () => {
    const spec = { $ref: '#', type: 'object' }
    const result = dereference(spec) as any
    // $ref takes precedence, siblings (type) are dropped per OpenAPI 3.0.
    // Circular self-ref resolves without infinite loop.
    expect(result).toBeDefined()
    expect(result.type).toBeUndefined()
  })

  test('non-local $ref is preserved (not resolved)', () => {
    const spec = {
      a: { $ref: 'https://example.com/schema.json#/Foo' },
      b: { $ref: './other.yaml#/Bar' },
      c: { $ref: 'relative.json' },
    }
    const result = dereference(spec) as any
    expect(result.a.$ref).toBe('https://example.com/schema.json#/Foo')
    expect(result.b.$ref).toBe('./other.yaml#/Bar')
    expect(result.c.$ref).toBe('relative.json')
  })

  test('$ref target contains a non-local $ref (preserved after deref)', () => {
    const spec = {
      components: {
        schemas: {
          External: { type: 'object', nested: { $ref: 'https://example.com/other.json' } },
        },
      },
      root: { $ref: '#/components/schemas/External' },
    }
    const result = dereference(spec) as any
    expect(result.root.type).toBe('object')
    expect(result.root.nested.$ref).toBe('https://example.com/other.json')
  })

  test('forward reference (A uses B, B defined after A)', () => {
    const spec = {
      components: {
        schemas: {
          A: { type: 'object', child: { $ref: '#/components/schemas/B' } },
          B: { type: 'string' },
        },
      },
      root: { $ref: '#/components/schemas/A' },
    }
    const result = dereference(spec) as any
    expect(result.root.child).toEqual({ type: 'string' })
  })

  test('deep chain of refs (A -> B -> C -> D -> E -> value)', () => {
    const spec = {
      a: { $ref: '#/b' },
      b: { $ref: '#/c' },
      c: { $ref: '#/d' },
      d: { $ref: '#/e' },
      e: { value: 'deep' },
    }
    const result = dereference(spec) as any
    expect(result.a).toEqual({ value: 'deep' })
  })

  test('deep chain of refs to array', () => {
    const spec = {
      a: { $ref: '#/b' },
      b: { $ref: '#/c' },
      c: [1, 2, 3],
    }
    const result = dereference(spec) as any
    expect(result.a).toEqual([1, 2, 3])
  })

  test('combined ~0 and ~1 escaping in same pointer segment', () => {
    const spec = {
      'a~/b': { value: 'complex' },
      ref: { $ref: '#/a~0~1b' },
    }
    const result = dereference(spec) as any
    expect(result.ref).toEqual({ value: 'complex' })
  })

  test('$ref to nested value inside a ref target', () => {
    const spec = {
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: { name: { type: 'string', maxLength: 100 } },
          },
        },
      },
      nameSchema: { $ref: '#/components/schemas/User/properties/name' },
    }
    const result = dereference(spec) as any
    expect(result.nameSchema).toEqual({ type: 'string', maxLength: 100 })
  })

  test('multiple independent circular cycles', () => {
    const spec = {
      components: {
        schemas: {
          X: { type: 'X', self: { $ref: '#/components/schemas/X' } },
          Y: { type: 'Y', self: { $ref: '#/components/schemas/Y' } },
        },
      },
      refX: { $ref: '#/components/schemas/X' },
      refY: { $ref: '#/components/schemas/Y' },
    }
    const result = dereference(spec) as any
    expect(result.refX.type).toBe('X')
    expect(result.refX.self).toBe(result.refX)
    expect(result.refY.type).toBe('Y')
    expect(result.refY.self).toBe(result.refY)
    // X and Y are distinct
    expect(result.refX).not.toBe(result.refY)
  })

  test('object with constructor/toString keys (no prototype issues)', () => {
    const spec = {
      vals: { constructor: { value: 1 }, toString: { value: 2 } },
      a: { $ref: '#/vals/constructor' },
      b: { $ref: '#/vals/toString' },
    }
    const result = dereference(spec) as any
    expect(result.a).toEqual({ value: 1 })
    expect(result.b).toEqual({ value: 2 })
  })

  test('ref to boolean nested inside object', () => {
    const spec = {
      config: { features: { enabled: true, disabled: false } },
      a: { $ref: '#/config/features/enabled' },
      b: { $ref: '#/config/features/disabled' },
    }
    const result = dereference(spec) as any
    expect(result.a).toBe(true)
    expect(result.b).toBe(false)
  })

  test('array of $refs to different types', () => {
    const spec = {
      vals: { str: 'hello', num: 42, obj: { x: 1 }, arr: [1, 2] },
      refs: [
        { $ref: '#/vals/str' },
        { $ref: '#/vals/num' },
        { $ref: '#/vals/obj' },
        { $ref: '#/vals/arr' },
      ],
    }
    const result = dereference(spec) as any
    expect(result.refs[0]).toBe('hello')
    expect(result.refs[1]).toBe(42)
    expect(result.refs[2]).toEqual({ x: 1 })
    expect(result.refs[3]).toEqual([1, 2])
  })

  test('circular ref where first encounter is NOT via $ref', () => {
    // Schema defines Node inline (not behind a $ref), but Node's child uses $ref
    const spec = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              child: { $ref: '#/components/schemas/Node' },
            },
          },
        },
      },
      // Access Node directly through the tree walk, not via $ref
      direct: {
        schema: {
          type: 'wrapper',
          inner: { $ref: '#/components/schemas/Node' },
        },
      },
    }
    const result = dereference(spec) as any
    expect(result.direct.schema.inner.type).toBe('object')
    expect(result.direct.schema.inner.properties.child).toBe(result.direct.schema.inner)
  })
})
