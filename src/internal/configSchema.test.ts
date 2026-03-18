import { Cli, z } from 'incur'

import * as ConfigSchema from './configSchema.js'

describe('fromCli', () => {
  test('generates schema for root options and leaf commands', () => {
    const cli = Cli.create('test', {
      options: z.object({
        verbose: z.boolean().default(false),
      }),
    })
    cli.command('echo', {
      options: z.object({
        prefix: z.string().default(''),
        upper: z.boolean().default(false),
      }),
      run: (c) => c.options,
    })

    const schema = ConfigSchema.fromCli(cli)
    expect(schema).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "$schema": {
            "type": "string",
          },
          "commands": {
            "additionalProperties": false,
            "properties": {
              "echo": {
                "additionalProperties": false,
                "properties": {
                  "options": {
                    "additionalProperties": false,
                    "properties": {
                      "prefix": {
                        "default": "",
                        "type": "string",
                      },
                      "upper": {
                        "default": false,
                        "type": "boolean",
                      },
                    },
                    "type": "object",
                  },
                },
                "type": "object",
              },
            },
            "type": "object",
          },
          "options": {
            "additionalProperties": false,
            "properties": {
              "verbose": {
                "default": false,
                "type": "boolean",
              },
            },
            "type": "object",
          },
        },
        "type": "object",
      }
    `)
  })

  test('generates schema for nested command groups', () => {
    const project = Cli.create('project')
    project.command('list', {
      options: z.object({
        limit: z.number().default(10),
        label: z.array(z.string()).default([]),
      }),
      run: (c) => c.options,
    })

    const cli = Cli.create('test')
    cli.command(project)

    const schema = ConfigSchema.fromCli(cli)
    expect(schema).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "$schema": {
            "type": "string",
          },
          "commands": {
            "additionalProperties": false,
            "properties": {
              "project": {
                "additionalProperties": false,
                "properties": {
                  "commands": {
                    "additionalProperties": false,
                    "properties": {
                      "list": {
                        "additionalProperties": false,
                        "properties": {
                          "options": {
                            "additionalProperties": false,
                            "properties": {
                              "label": {
                                "default": [],
                                "items": {
                                  "type": "string",
                                },
                                "type": "array",
                              },
                              "limit": {
                                "default": 10,
                                "type": "number",
                              },
                            },
                            "type": "object",
                          },
                        },
                        "type": "object",
                      },
                    },
                    "type": "object",
                  },
                },
                "type": "object",
              },
            },
            "type": "object",
          },
        },
        "type": "object",
      }
    `)
  })

  test('returns schema with only $schema for cli with no commands', () => {
    const cli = Cli.create('test')
    const schema = ConfigSchema.fromCli(cli)
    expect(schema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { $schema: { type: 'string' } },
    })
  })

  test('skips fetch gateway commands', () => {
    const cli = Cli.create('test')
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })
    cli.command('api', {
      description: 'API gateway',
      fetch: () => new Response('ok'),
    })

    const schema = ConfigSchema.fromCli(cli)
    const commandKeys = Object.keys((schema as any).properties.commands.properties)
    expect(commandKeys).toEqual(['echo'])
  })

  test('includes commands without options as empty objects', () => {
    const cli = Cli.create('test')
    cli.command('ping', {
      run: () => 'pong',
    })

    const schema = ConfigSchema.fromCli(cli)
    expect(schema).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "$schema": {
            "type": "string",
          },
          "commands": {
            "additionalProperties": false,
            "properties": {
              "ping": {
                "additionalProperties": false,
                "type": "object",
              },
            },
            "type": "object",
          },
        },
        "type": "object",
      }
    `)
  })
})
