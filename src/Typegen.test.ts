import { Cli, Typegen, z } from 'incur'

describe('fromCli', () => {
  test('simple commands with args and options', () => {
    const cli = Cli.create('test')
      .command('get', {
        args: z.object({ id: z.number() }),
        run: () => ({}),
      })
      .command('list', {
        options: z.object({ limit: z.number() }),
        run: () => ({}),
      })

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        get: { args: { id: number }; options: {} }
        list: { args: {}; options: { limit: number } }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('command with no args or options', () => {
    const cli = Cli.create('test').command('ping', { run: () => ({}) })

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        ping: { args: {}; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('sub-commands use full path', () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr')
      .command('list', {
        options: z.object({ state: z.string() }),
        run: () => ({}),
      })
      .command('create', {
        args: z.object({ title: z.string() }),
        run: () => ({}),
      })
    cli.command(pr)

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        "pr create": { args: { title: string }; options: {} }
        "pr list": { args: {}; options: { state: string } }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('deeply nested sub-commands', () => {
    const cli = Cli.create('test')
    const review = Cli.create('review').command('approve', {
      args: z.object({ id: z.number() }),
      run: () => ({}),
    })
    const pr = Cli.create('pr')
    pr.command(review)
    cli.command(pr)

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        "pr review approve": { args: { id: number }; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('enum types fromCli union of literals', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ state: z.enum(['open', 'closed', 'merged']) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"open" | "closed" | "merged"')
  })

  test('boolean types', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ verbose: z.boolean() }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('verbose: boolean')
  })

  test('array types', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ tags: z.array(z.string()) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('tags: string[]')
  })

  test('emits scalar and array output schemas', () => {
    const cli = Cli.create('test')
      .command('read', {
        output: z.string(),
        run: () => 'content',
      })
      .command('list', {
        output: z.array(z.object({ id: z.string(), active: z.boolean() })),
        run: () => [{ id: 'one', active: true }],
      })

<<<<<<< HEAD
    const output = Typegen.fromCli(cli)
    expect(output).toContain('read: { args: {}; options: {}; output: string }')
    expect(output).toContain(
      'list: { args: {}; options: {}; output: { id: string; active: boolean }[] }',
    )
=======
    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        read: { args: {}; options: {}; output: string }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
>>>>>>> 0a77e57 (fix: tighten typed client typegen surface)
  })

  test('marks async generator commands as streams', () => {
    const cli = Cli.create('test').command('tail', {
      output: z.object({ line: z.string() }),
      async *run() {
        yield { line: 'ok' }
      },
    })

<<<<<<< HEAD
    const output = Typegen.fromCli(cli)
    expect(output).toContain(
      'tail: { args: {}; options: {}; output: { line: string }; stream: true }',
    )
=======
    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        list: { args: {}; options: {}; output: { id: string; active: boolean }[] }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
>>>>>>> 0a77e57 (fix: tighten typed client typegen surface)
  })

  test('commands are sorted alphabetically', () => {
    const cli = Cli.create('test')
      .command('zebra', { run: () => ({}) })
      .command('alpha', { run: () => ({}) })
      .command('middle', { run: () => ({}) })

    const output = Typegen.fromCli(cli)
    const commandOrder = [...output.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])
    expect(commandOrder).toEqual(['alpha', 'middle', 'zebra'])
  })

  test('const schema via z.literal', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ mode: z.literal('strict') }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('mode: "strict"')
  })

  test('array of union items gets parens', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ values: z.array(z.union([z.string(), z.number()])) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('values: (string | number)[]')
  })

  test('null type', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ empty: z.null() }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('empty: null')
  })

  test('nested object with properties', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ config: z.object({ host: z.string(), port: z.number() }) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('config: { host: string; port: number }')
  })

  test('optional properties include undefined for exact optional property types', () => {
    const cli = Cli.create('test').command('create', {
      args: z.object({ name: z.string() }),
      options: z.object({
        verbose: z.boolean().optional(),
        output: z.string(),
      }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('verbose?: boolean | undefined')
    expect(output).toContain('output: string')
  })

  test('mixed top-level and grouped commands', () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({}) })
    const pr = Cli.create('pr').command('list', { run: () => ({}) })
    cli.command(pr)

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "export type Commands = {
        ping: { args: {}; options: {} }
        "pr list": { args: {}; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }

      declare module 'incur/client' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('includes root commands and excludes raw fetch gateways', () => {
    const cli = Cli.create('status', {
      run: () => ({ ok: true }),
    }).command('raw', {
      fetch: () => new Response('{}'),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('status: { args: {}; options: {} }')
    expect(output).not.toContain("'raw'")
    expect(output).toContain("declare module 'incur/client'")
  })

<<<<<<< HEAD
  test('escapes command and property keys', () => {
=======
  test('escapes command keys', () => {
>>>>>>> 3df4c76 (refactor: keep public surface typegen scoped)
    const cli = Cli.create('test').command('bad key "quoted"', {
      options: z.object({
        'bad-key': z.string().optional(),
        'quote"key': z.number(),
        nested: z.object({ 'child-key': z.string().optional() }),
      }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"bad key \\"quoted\\""')
<<<<<<< HEAD
<<<<<<< HEAD
    expect(output).toContain('"bad-key"?: string | undefined')
    expect(output).toContain('"quote\\"key": number')
    expect(output).toContain('nested: { "child-key"?: string | undefined }')
  })

  test('catchall index signatures include optional property undefined', () => {
    const cli = Cli.create('test').command('shape', {
      output: z.object({ maybe: z.string().optional() }).catchall(z.boolean()),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain(
      'shape: { args: {}; options: {}; output: { maybe?: string | undefined; [key: string]: boolean | string | undefined } }',
    )
  })

  test('wraps JSON Schema conversion failures in TypegenError', () => {
    const cli = Cli.create('test').command('created', {
      output: z.date(),
      run: () => new Date(),
    })

    expect(() => Typegen.fromCli(cli)).toThrow(Typegen.TypegenError)
    expect(() => Typegen.fromCli(cli)).toThrow(
      'Cannot generate TypeScript for command "created" output',
    )
  })

  test('throws TypegenError for unsupported JSON Schema refs', () => {
    let node: z.ZodType
    node = z.lazy(() => z.object({ next: node.optional() }))
    const cli = Cli.create('test').command('broken', {
      output: node,
      run: () => ({ next: {} }),
    })

    expect(() => Typegen.fromCli(cli)).toThrow(Typegen.TypegenError)
    expect(() => Typegen.fromCli(cli)).toThrow('unsupported JSON Schema reference "#"')
=======
>>>>>>> 3df4c76 (refactor: keep public surface typegen scoped)
=======
    expect(output).toContain('"bad-key"?: string | undefined')
    expect(output).toContain('"quote\\"key": number')
    expect(output).toContain('nested: { "child-key"?: string | undefined }')
>>>>>>> dbb43b1 (fix: align typed client contracts)
  })
})
