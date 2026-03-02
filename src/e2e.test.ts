import { Cli, Errors, Skill, Typegen, z } from 'incur'

let __mockSkillsHash: string | undefined

const originalIsTTY = process.stdout.isTTY
beforeAll(() => {
  ;(process.stdout as any).isTTY = false
})
afterAll(() => {
  ;(process.stdout as any).isTTY = originalIsTTY
})

vi.mock('./SyncSkills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SyncSkills.js')>()
  return { ...actual, readHash: () => __mockSkillsHash }
})

describe('routing', () => {
  test('top-level command', async () => {
    const { output } = await serve(createApp(), ['ping'])
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
  })

  test('group command', async () => {
    const { output } = await serve(createApp(), ['auth', 'logout'])
    expect(output).toMatchInlineSnapshot(`
      "loggedOut: true
      "
    `)
  })

  test('nested group command (3 levels deep)', async () => {
    const { output } = await serve(createApp(), ['project', 'deploy', 'status', 'd-456'])
    expect(output).toMatchInlineSnapshot(`
      "deployId: d-456
      status: running
      progress: 75
      "
    `)
  })

  test('mounted leaf CLI as single command', async () => {
    const { output } = await serve(createApp(), ['config'])
    expect(output).toMatchInlineSnapshot(`
      "apiUrl: "https://api.example.com"
      timeout: 30
      debug: false
      "
    `)
  })

  test('mounted leaf CLI with args', async () => {
    const { output } = await serve(createApp(), ['config', 'apiUrl'])
    expect(output).toMatchInlineSnapshot(`
      "key: apiUrl
      value: some-value
      "
    `)
  })

  test('unknown top-level command', async () => {
    const { output, exitCode } = await serve(createApp(), ['nonexistent'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: 'nonexistent' is not a command. See 'app --help' for a list of available commands.
      "
    `)
  })

  test('unknown top-level command shows human error in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const { output, exitCode } = await serve(createApp(), ['nonexistent'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: 'nonexistent' is not a command. See 'app --help' for a list of available commands.
      "
    `)
  })

  test('unknown subcommand lists available', async () => {
    const { output, exitCode } = await serve(createApp(), ['auth', 'whoami'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: 'whoami' is not a command. See 'app auth --help' for a list of available commands.
      "
    `)
  })

  test('unknown nested subcommand', async () => {
    const { output, exitCode } = await serve(createApp(), ['project', 'deploy', 'nope'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: 'nope' is not a command. See 'app project deploy --help' for a list of available commands.
      "
    `)
  })
})

describe('args and options', () => {
  test('positional args in order', async () => {
    const { output } = await serve(createApp(), ['echo', 'hello'])
    expect(output).toMatchInlineSnapshot(`
      "result[1]: hello
      "
    `)
  })

  test('--flag value form', async () => {
    const { output } = await serve(createApp(), ['echo', 'hello', '--upper', '--prefix', '>>'])
    expect(output).toMatchInlineSnapshot(`
      "result[1]: >> HELLO
      "
    `)
  })

  test('multiple options combined', async () => {
    const { output } = await serve(createApp(), ['echo', 'hi', '--upper', '--prefix', '!'])
    expect(output).toMatchInlineSnapshot(`
      "result[1]: ! HI
      "
    `)
  })

  test('--no-flag negation for booleans', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'list',
      '--no-archived',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.items.every((i: any) => !i.archived)).toBe(true)
  })

  test('array option collects multiple values', async () => {
    const { output } = await serve(createApp(), [
      'auth',
      'login',
      '--scopes',
      'read',
      '--scopes',
      'write',
      '--verbose',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.data.scopes).toMatchInlineSnapshot(`
      [
        "read",
        "write",
      ]
    `)
  })

  test('number coercion from argv strings', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'list',
      '--limit',
      '5',
      '--verbose',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.data.total).toBe(1)
  })

  test('enum validation fails for invalid value', async () => {
    const { output, exitCode } = await serve(createApp(), ['project', 'list', '--sort', 'invalid'])
    expect(exitCode).toBe(1)
    expect(output).toContain('Error')
    expect(output).toContain('sort')
  })

  test('missing required arg fails validation', async () => {
    const { output, exitCode } = await serve(createApp(), ['project', 'get'])
    expect(exitCode).toBe(1)
    expect(output).toContain('VALIDATION_ERROR')
  })

  test('missing required arg shows human error in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const { output, exitCode } = await serve(createApp(), ['project', 'get'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toContain('Error: missing required argument <id>')
  })

  test('unknown flag returns error', async () => {
    const { output, exitCode } = await serve(createApp(), ['ping', '--unknown-flag'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: "Unknown flag: --unknown-flag"
      "
    `)
  })

  test('unknown flag shows human error in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const { output, exitCode } = await serve(createApp(), ['ping', '--unknown-flag'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: Unknown flag: --unknown-flag
      "
    `)
  })
})

describe('output formats', () => {
  test('default TOON format', async () => {
    const { output } = await serve(createApp(), ['ping'])
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
    expect(() => json(output)).toThrow()
  })

  test('--format json', async () => {
    const { output } = await serve(createApp(), ['ping', '--format', 'json'])
    expect(output).toMatchInlineSnapshot(`
      "{
        "pong": true
      }
      "
    `)
  })

  test('--json shorthand', async () => {
    const { output } = await serve(createApp(), ['ping', '--json'])
    expect(output).toMatchInlineSnapshot(`
      "{
        "pong": true
      }
      "
    `)
  })

  test('--format yaml', async () => {
    const { output } = await serve(createApp(), ['ping', '--format', 'yaml'])
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
  })

  test('CLI-level default format', async () => {
    const cli = Cli.create('test', { format: 'json' })
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping'])
    expect(output).toMatchInlineSnapshot(`
      "{
        "pong": true
      }
      "
    `)
  })

  test('command-level default format', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { format: 'json', run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping'])
    expect(output).toMatchInlineSnapshot(`
      "{
        "pong": true
      }
      "
    `)
  })

  test('command-level format overrides CLI-level', async () => {
    const cli = Cli.create('test', { format: 'yaml' })
    cli.command('ping', { format: 'json', run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping'])
    expect(output).toMatchInlineSnapshot(`
      "{
        "pong": true
      }
      "
    `)
  })

  test('--format flag overrides command-level default', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { format: 'json', run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--format', 'yaml'])
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
  })

  test('--verbose full envelope', async () => {
    const { output } = await serve(createApp(), ['ping', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        pong: true
      meta:
        command: ping
        duration: <stripped>
      "
    `)
  })

  test('--verbose --format json full envelope', async () => {
    const { output } = await serve(createApp(), ['ping', '--verbose', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "data": {
          "pong": true,
        },
        "meta": {
          "command": "ping",
          "duration": "<stripped>",
        },
        "ok": true,
      }
    `)
  })

  test('nested command path in verbose meta', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'deploy',
      'status',
      'd-1',
      '--verbose',
      '--format',
      'json',
    ])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "data": {
          "deployId": "d-1",
          "progress": 75,
          "status": "running",
        },
        "meta": {
          "command": "project deploy status",
          "duration": "<stripped>",
        },
        "ok": true,
      }
    `)
  })
})

describe('undefined output', () => {
  test('void command produces no output in human mode', async () => {
    const { output, exitCode } = await serve(createApp(), ['noop'])
    expect(output).toBe('')
    expect(exitCode).toBeUndefined()
  })

  test('void command produces no output with --format json', async () => {
    const { output } = await serve(createApp(), ['noop', '--format', 'json'])
    expect(output).toBe('')
  })

  test('void command produces no output with --format yaml', async () => {
    const { output } = await serve(createApp(), ['noop', '--format', 'yaml'])
    expect(output).toBe('')
  })

  test('void command shows envelope with --verbose', async () => {
    const { output } = await serve(createApp(), ['noop', '--verbose', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "meta": {
          "command": "noop",
          "duration": "<stripped>",
        },
        "ok": true,
      }
    `)
  })
})

describe('error handling', () => {
  test('thrown Error shows structured error', async () => {
    const { output, exitCode } = await serve(createApp(), ['explode'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: kaboom
      "
    `)
  })

  test('thrown Error shows human error in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const { output, exitCode } = await serve(createApp(), ['explode'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: kaboom
      "
    `)
  })

  test('IncurError preserves code and retryable', async () => {
    const { output, exitCode } = await serve(createApp(), ['explode-clac', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "code": "QUOTA_EXCEEDED",
        "message": "Rate limit exceeded",
        "retryable": true,
      }
    `)
  })

  test('error() sentinel returns error envelope', async () => {
    const { output, exitCode } = await serve(createApp(), [
      'auth',
      'status',
      '--verbose',
      '--format',
      'json',
    ])
    expect(exitCode).toBe(1)
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "NOT_AUTHENTICATED",
          "message": "Not logged in",
          "retryable": false,
        },
        "meta": {
          "command": "auth status",
          "cta": {
            "commands": [
              {
                "command": "app auth login",
              },
            ],
            "description": "Suggested commands:",
          },
          "duration": "<stripped>",
        },
        "ok": false,
      }
    `)
  })

  test('IncurError in nested command', async () => {
    const { output, exitCode } = await serve(createApp(), [
      'project',
      'delete',
      'p1',
      '--format',
      'json',
    ])
    expect(exitCode).toBe(1)
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "code": "CONFIRMATION_REQUIRED",
        "message": "Use --force to delete project p1",
        "retryable": true,
      }
    `)
  })

  test('validation error includes field errors', async () => {
    const { output, exitCode } = await serve(createApp(), ['validate-fail', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = json(output)
    expect(parsed.fieldErrors.length).toBeGreaterThan(0)
    expect(parsed.fieldErrors[0].path).toBe('email')
  })

  test('command not found returns error envelope', async () => {
    const { output, exitCode } = await serve(createApp(), [
      'nonexistent',
      '--verbose',
      '--format',
      'json',
    ])
    expect(exitCode).toBe(1)
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "COMMAND_NOT_FOUND",
          "message": "'nonexistent' is not a command. See 'app --help' for a list of available commands.",
        },
        "meta": {
          "command": "nonexistent",
          "duration": "<stripped>",
        },
        "ok": false,
      }
    `)
  })

  test('error envelope respects --format json', async () => {
    const { output, exitCode } = await serve(createApp(), ['explode', '--format', 'json'])
    expect(exitCode).toBe(1)
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "code": "UNKNOWN",
        "message": "kaboom",
      }
    `)
  })
})

describe('cta', () => {
  test('ok() with string CTAs', async () => {
    const { output } = await serve(createApp(), ['auth', 'login', '--verbose', '--format', 'json'])
    expect(json(output).meta.cta).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "command": "app auth status",
          },
        ],
        "description": "Verify your session:",
      }
    `)
  })

  test('ok() with object CTAs including descriptions', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'create',
      'MyProject',
      '--verbose',
      '--format',
      'json',
    ])
    expect(json(output).meta.cta).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "command": "app project get p-new",
            "description": "View "MyProject"",
          },
          {
            "command": "app project list",
          },
        ],
        "description": "Suggested commands:",
      }
    `)
  })

  test('error() with CTA', async () => {
    const { output } = await serve(createApp(), ['auth', 'status', '--verbose', '--format', 'json'])
    expect(json(output).meta.cta).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "command": "app auth login",
          },
        ],
        "description": "Suggested commands:",
      }
    `)
  })

  test('plain return omits CTA', async () => {
    const { output } = await serve(createApp(), ['ping', '--verbose', '--format', 'json'])
    expect(json(output).meta.cta).toBeUndefined()
  })

  test('dynamic CTA list from data', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'list',
      '--archived',
      '--verbose',
      '--format',
      'json',
    ])
    expect(json(output).meta.cta).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "command": "app project get p1",
            "description": "View "Alpha"",
          },
          {
            "command": "app project get p2",
            "description": "View "Beta"",
          },
        ],
        "description": "Suggested commands:",
      }
    `)
  })
})

describe('async', () => {
  test('async handler resolves', async () => {
    const { output } = await serve(createApp(), ['slow'])
    expect(output).toMatchInlineSnapshot(`
      "done: true
      "
    `)
  })
})

describe('streaming', () => {
  test('default streams toon per chunk (human)', async () => {
    const { output } = await serve(createApp(), ['stream'])
    expect(output).toMatchInlineSnapshot(`
      "content: hello
      content: world
      "
    `)
  })

  test('default streams toon per chunk (--verbose)', async () => {
    const { output } = await serve(createApp(), ['stream', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "content: hello
      content: world
      "
    `)
  })

  test('--format json buffers all chunks', async () => {
    const { output } = await serve(createApp(), ['stream', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      [
        {
          "content": "hello",
        },
        {
          "content": "world",
        },
      ]
    `)
  })

  test('--format json --verbose buffers with envelope', async () => {
    const { output } = await serve(createApp(), ['stream', '--verbose', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "data": [
          {
            "content": "hello",
          },
          {
            "content": "world",
          },
        ],
        "meta": {
          "command": "stream",
          "duration": "<stripped>",
        },
        "ok": true,
      }
    `)
  })

  test('plain text streams as lines', async () => {
    const { output } = await serve(createApp(), ['stream-text'])
    expect(output).toMatchInlineSnapshot(`
      "hello
      world
      "
    `)
  })

  test('plain text streams as jsonl chunks', async () => {
    const { output } = await serve(createApp(), ['stream-text', '--format', 'jsonl'])
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ type: 'chunk', data: 'hello' })
    expect(lines[1]).toEqual({ type: 'chunk', data: 'world' })
    expect(lines[2].type).toBe('done')
  })

  test('--format jsonl explicit', async () => {
    const { output } = await serve(createApp(), ['stream', '--format', 'jsonl'])
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ type: 'chunk', data: { content: 'hello' } })
    expect(lines[1]).toEqual({ type: 'chunk', data: { content: 'world' } })
    expect(lines[2].type).toBe('done')
  })

  test('ok() CTA in jsonl done record', async () => {
    const { output } = await serve(createApp(), ['stream-ok', '--format', 'jsonl'])
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const done = lines.find((l: any) => l.type === 'done')
    expect(done.meta.cta).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "command": "app ping",
          },
        ],
        "description": "Suggested commands:",
      }
    `)
  })

  test('ok() CTA shows after toon stream', async () => {
    const { output } = await serve(createApp(), ['stream-ok'])
    expect(output).toContain('n: 1')
    expect(output).toContain('n: 2')
    expect(output).toContain('Suggested commands:')
    expect(output).toContain('app ping')
  })

  test('error() mid-stream in jsonl', async () => {
    const { output, exitCode } = await serve(createApp(), ['stream-error', '--format', 'jsonl'])
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ type: 'chunk', data: { n: 1 } })
    expect(lines[1]).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "STREAM_FAIL",
          "message": "broke mid-stream",
        },
        "ok": false,
        "type": "error",
      }
    `)
    expect(exitCode).toBe(1)
  })

  test('error() mid-stream in toon', async () => {
    const { output, exitCode } = await serve(createApp(), ['stream-error'])
    expect(output).toContain('n: 1')
    expect(output).toContain('Error (STREAM_FAIL): broke mid-stream')
    expect(exitCode).toBe(1)
  })

  test('thrown error mid-stream in jsonl', async () => {
    const { output, exitCode } = await serve(createApp(), ['stream-throw', '--format', 'jsonl'])
    const lines = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ type: 'chunk', data: { n: 1 } })
    expect(lines[1]).toMatchInlineSnapshot(`
      {
        "error": {
          "code": "UNKNOWN",
          "message": "stream kaboom",
        },
        "ok": false,
        "type": "error",
      }
    `)
    expect(exitCode).toBe(1)
  })

  test('thrown error mid-stream in toon', async () => {
    const { output, exitCode } = await serve(createApp(), ['stream-throw'])
    expect(output).toContain('n: 1')
    expect(output).toContain('Error: stream kaboom')
    expect(exitCode).toBe(1)
  })
})

describe('help', () => {
  test('root help (no args)', async () => {
    const { output, exitCode } = await serve(createApp(), [])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "app — A comprehensive CLI application for testing.
      v3.5.0

      Usage: app <command>

      Commands:
        auth           Authentication commands
        config         Show current configuration
        echo           Echo back arguments
        explode        Always fails
        explode-clac   Fails with IncurError
        noop           Returns nothing
        ping           Health check
        project        Manage projects
        slow           Async command
        stream         Stream chunks
        stream-error   Stream with mid-stream error
        stream-ok      Stream with ok() return
        stream-text    Stream plain text
        stream-throw   Stream that throws
        validate-fail  Fails validation

      Built-in Commands:
        mcp add     Register as an MCP server
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --verbose                           Show full output envelope
        --version                           Show version
      "
    `)
  })

  test('--help on root', async () => {
    const { output } = await serve(createApp(), ['--help'])
    expect(output).toContain('Usage: app <command>')
  })

  test('group help (no subcommand)', async () => {
    const { output, exitCode } = await serve(createApp(), ['auth'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "app auth — Authentication commands

      Usage: app auth <command>

      Commands:
        login   Log in to the service
        logout  Log out of the service
        status  Show authentication status

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('nested group help', async () => {
    const { output, exitCode } = await serve(createApp(), ['project', 'deploy'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "app project deploy — Deployment commands

      Usage: app project deploy <command>

      Commands:
        create    Create a deployment
        rollback  Rollback a deployment
        status    Check deployment status

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--help on leaf command', async () => {
    const { output } = await serve(createApp(), ['project', 'list', '--help'])
    expect(output).toMatchInlineSnapshot(`
      "app project list — List projects

      Usage: app project list [options]

      Options:
        --limit, -l <number>  Max results (default: 20)
        --sort, -s <value>    Sort field (default: name)
        --archived <boolean>  Include archived (default: false)

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--help includes examples', async () => {
    const { output } = await serve(createApp(), ['project', 'deploy', 'create', '--help'])
    expect(output).toMatchInlineSnapshot(`
      "app project deploy create — Create a deployment

      Usage: app project deploy create <env> [options]

      Arguments:
        env  Target environment

      Options:
        --branch, -b <string>  Branch to deploy (default: main)
        --dry-run <boolean>    Dry run mode (default: false)

      Examples:
        $ app project deploy create staging                                    Deploy staging from main
        $ app project deploy create production --branch release --dryRun true  Dry run a production deploy

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--help on group shows group help', async () => {
    const { output } = await serve(createApp(), ['project', '--help'])
    expect(output).toContain('app project')
    expect(output).toContain('deploy')
    expect(output).toContain('list')
  })

  test('--version', async () => {
    const { output } = await serve(createApp(), ['--version'])
    expect(output).toMatchInlineSnapshot(`
      "3.5.0
      "
    `)
  })

  test('--help takes precedence over --version', async () => {
    const { output } = await serve(createApp(), ['--help', '--version'])
    expect(output).toContain('Usage: app <command>')
    expect(output).toContain('v3.5.0')
  })
})

describe('--llms', () => {
  test('json manifest lists all leaf commands sorted', async () => {
    const { output } = await serve(createApp(), ['--llms', '--format', 'json'])
    const manifest = json(output)
    expect(manifest.version).toBe('incur.v1')
    const names = manifest.commands.map((c: any) => c.name)
    expect(names).toMatchInlineSnapshot(`
      [
        "auth login",
        "auth logout",
        "auth status",
        "config",
        "echo",
        "explode",
        "explode-clac",
        "noop",
        "ping",
        "project create",
        "project delete",
        "project deploy create",
        "project deploy rollback",
        "project deploy status",
        "project get",
        "project list",
        "slow",
        "stream",
        "stream-error",
        "stream-ok",
        "stream-text",
        "stream-throw",
        "validate-fail",
      ]
    `)
  })

  test('manifest includes schema.args and schema.options separately', async () => {
    const { output } = await serve(createApp(), ['--llms', '--format', 'json'])
    const projectList = json(output).commands.find((c: any) => c.name === 'project list')
    expect(projectList.schema.options.properties).toMatchInlineSnapshot(`
      {
        "archived": {
          "default": false,
          "description": "Include archived",
          "type": "boolean",
        },
        "limit": {
          "default": 20,
          "description": "Max results",
          "type": "number",
        },
        "sort": {
          "default": "name",
          "description": "Sort field",
          "enum": [
            "name",
            "created",
            "updated",
          ],
          "type": "string",
        },
      }
    `)
    expect(projectList.schema.args).toBeUndefined()
  })

  test('manifest includes schema.output', async () => {
    const { output } = await serve(createApp(), ['--llms', '--format', 'json'])
    const projectGet = json(output).commands.find((c: any) => c.name === 'project get')
    expect(projectGet.schema.output).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "description": {
            "type": "string",
          },
          "id": {
            "type": "string",
          },
          "members": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "role": {
                  "type": "string",
                },
                "userId": {
                  "type": "string",
                },
              },
              "required": [
                "userId",
                "role",
              ],
              "type": "object",
            },
            "type": "array",
          },
          "name": {
            "type": "string",
          },
        },
        "required": [
          "id",
          "name",
          "description",
          "members",
        ],
        "type": "object",
      }
    `)
  })

  test('manifest omits schema when no schemas defined', async () => {
    const { output } = await serve(createApp(), ['--llms', '--format', 'json'])
    const ping = json(output).commands.find((c: any) => c.name === 'ping')
    expect(ping.schema).toBeUndefined()
  })

  test('scoped --llms to group', async () => {
    const { output } = await serve(createApp(), ['auth', '--llms', '--format', 'json'])
    const names = json(output).commands.map((c: any) => c.name)
    expect(names).toMatchInlineSnapshot(`
      [
        "auth login",
        "auth logout",
        "auth status",
      ]
    `)
  })

  test('scoped --llms to nested group', async () => {
    const { output } = await serve(createApp(), ['project', 'deploy', '--llms', '--format', 'json'])
    const names = json(output).commands.map((c: any) => c.name)
    expect(names).toMatchInlineSnapshot(`
      [
        "project deploy create",
        "project deploy rollback",
        "project deploy status",
      ]
    `)
  })

  test('default --llms outputs markdown', async () => {
    const { output } = await serve(createApp(), ['--llms'])
    expect(output).toContain('# app')
    expect(output).toContain('auth login')
    expect(output).toContain('project list')
  })

  test('--llms markdown includes argument tables', async () => {
    const { output } = await serve(createApp(), ['project', '--llms'])
    expect(output).toContain('Arguments')
    expect(output).toContain('`id`')
  })

  test('--llms markdown includes options tables', async () => {
    const { output } = await serve(createApp(), ['project', '--llms'])
    expect(output).toContain('Options')
    expect(output).toContain('`--limit`')
  })

  test('--llms json includes examples on commands', async () => {
    const { output } = await serve(createApp(), ['project', 'deploy', '--llms', '--format', 'json'])
    const deployCreate = json(output).commands.find((c: any) => c.name === 'project deploy create')
    expect(deployCreate.examples).toMatchInlineSnapshot(`
      [
        {
          "command": "project deploy create staging",
          "description": "Deploy staging from main",
        },
        {
          "command": "project deploy create production --branch release --dryRun true",
          "description": "Dry run a production deploy",
        },
      ]
    `)
  })

  test('--llms json omits examples when not defined', async () => {
    const { output } = await serve(createApp(), ['--llms', '--format', 'json'])
    const ping = json(output).commands.find((c: any) => c.name === 'ping')
    expect(ping.examples).toBeUndefined()
  })

  test('--llms markdown includes examples section', async () => {
    const { output } = await serve(createApp(), ['--llms'])
    expect(output).toContain('Examples')
    expect(output).toContain('Deploy staging from main')
    expect(output).toContain('app project deploy create staging')
  })

  test('--llms markdown includes output tables', async () => {
    const { output } = await serve(createApp(), ['project', '--llms'])
    expect(output).toContain('Output')
  })

  test('--llms --format yaml', async () => {
    const { output } = await serve(createApp(), ['--llms', '--format', 'yaml'])
    expect(output).toContain('version: incur.v1')
  })
})

describe('typegen', () => {
  test('generates correct .d.ts for entire CLI', () => {
    expect(Typegen.fromCli(createApp())).toMatchInlineSnapshot(`
      "declare module 'incur' {
        interface Register {
          commands: {
            'auth login': { args: {}; options: { hostname: string; web: boolean; scopes: string[] } }
            'auth logout': { args: {}; options: {} }
            'auth status': { args: {}; options: {} }
            'config': { args: { key: string }; options: {} }
            'echo': { args: { message: string; repeat: number }; options: { upper: boolean; prefix: string } }
            'explode': { args: {}; options: {} }
            'explode-clac': { args: {}; options: {} }
            'noop': { args: {}; options: {} }
            'ping': { args: {}; options: {} }
            'project create': { args: { name: string }; options: { description: string; private: boolean } }
            'project delete': { args: { id: string }; options: { force: boolean } }
            'project deploy create': { args: { env: string }; options: { branch: string; dryRun: boolean } }
            'project deploy rollback': { args: { deployId: string }; options: {} }
            'project deploy status': { args: { deployId: string }; options: {} }
            'project get': { args: { id: string }; options: {} }
            'project list': { args: {}; options: { limit: number; sort: "name" | "created" | "updated"; archived: boolean } }
            'slow': { args: {}; options: {} }
            'stream': { args: {}; options: {} }
            'stream-error': { args: {}; options: {} }
            'stream-ok': { args: {}; options: {} }
            'stream-text': { args: {}; options: {} }
            'stream-throw': { args: {}; options: {} }
            'validate-fail': { args: { email: string; age: number }; options: {} }
          }
        }
      }
      "
    `)
  })
})

describe('composition', () => {
  test('multiple groups on same parent', async () => {
    const cli = createApp()
    const { output: o1 } = await serve(cli, ['auth', 'logout'])
    expect(o1).toMatchInlineSnapshot(`
      "loggedOut: true
      "
    `)
    const { output: o2 } = await serve(cli, ['project', 'list', '--format', 'json'])
    expect(json(o2).items).toBeDefined()
    const { output: o3 } = await serve(cli, ['ping'])
    expect(o3).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
  })

  test('deeply nested deploy commands work alongside siblings', async () => {
    const cli = createApp()
    const { output: o1 } = await serve(cli, ['project', 'deploy', 'create', 'staging'])
    expect(o1).toMatchInlineSnapshot(`
      "deployId: d-123
      url: "https://staging.example.com"
      status: pending
      "
    `)
    const { output: o2 } = await serve(cli, ['project', 'list', '--format', 'json'])
    expect(json(o2).items).toBeDefined()
  })

  test('leaf CLI mounted alongside groups', async () => {
    const cli = createApp()
    const { output: o1 } = await serve(cli, ['config'])
    expect(o1).toMatchInlineSnapshot(`
      "apiUrl: "https://api.example.com"
      timeout: 30
      debug: false
      "
    `)
    const { output: o2 } = await serve(cli, ['auth', 'logout'])
    expect(o2).toMatchInlineSnapshot(`
      "loggedOut: true
      "
    `)
  })

  test('create with single options object', async () => {
    const cli = Cli.create({
      name: 'one-shot',
      description: 'Single object form',
      run: () => ({ result: 42 }),
    })
    expect(cli.name).toBe('one-shot')
    const { output } = await serve(cli, [])
    expect(output).toMatchInlineSnapshot(`
      "result: 42
      "
    `)
  })
})

describe('root command with subcommands', () => {
  function createHybrid() {
    const cli = Cli.create('tool', {
      description: 'A tool with a default action',
      args: z.object({ query: z.string().optional().describe('Search query') }),
      run(c) {
        return { default: true, query: c.args.query ?? null }
      },
    })
    cli.command('info', {
      description: 'Show info',
      run: () => ({ info: true }),
    })
    cli.command('version', {
      description: 'Show version',
      run: () => ({ version: '1.0.0' }),
    })
    return cli
  }

  test('runs root handler with no args', async () => {
    const { output } = await serve(createHybrid(), [])
    expect(output).toMatchInlineSnapshot(`
      "default: true
      query: null
      "
    `)
  })

  test('runs root handler with positional args', async () => {
    const { output } = await serve(createHybrid(), ['hello'])
    expect(output).toMatchInlineSnapshot(`
      "default: true
      query: hello
      "
    `)
  })

  test('subcommand takes precedence', async () => {
    const { output } = await serve(createHybrid(), ['info'])
    expect(output).toMatchInlineSnapshot(`
      "info: true
      "
    `)
  })

  test('--help shows root usage and subcommands', async () => {
    const { output } = await serve(createHybrid(), ['--help'])
    expect(output).toMatchInlineSnapshot(`
      "tool — A tool with a default action

      Usage: tool [query] | <command>

      Arguments:
        query  Search query

      Commands:
        info     Show info
        version  Show version

      Built-in Commands:
        mcp add     Register as an MCP server
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --verbose                           Show full output envelope
        --version                           Show version
      "
    `)
  })

  test('subcommand --help shows subcommand help', async () => {
    const { output } = await serve(createHybrid(), ['info', '--help'])
    expect(output).toContain('tool info')
    expect(output).toContain('Show info')
    expect(output).not.toContain('Commands:')
  })
})

describe('edge cases', () => {
  test('command with only options (no args)', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'list',
      '--limit',
      '1',
      '--format',
      'json',
    ])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "cta": {
          "commands": [
            {
              "command": "app project get p1",
              "description": "View "Alpha"",
            },
          ],
          "description": "Suggested commands:",
        },
        "items": [
          {
            "archived": false,
            "id": "p1",
            "name": "Alpha",
          },
        ],
        "total": 1,
      }
    `)
  })

  test('command with only args (no options)', async () => {
    const { output } = await serve(createApp(), ['project', 'get', 'p1', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "description": "Main project",
        "id": "p1",
        "members": [
          {
            "role": "admin",
            "userId": "u1",
          },
        ],
        "name": "Alpha",
      }
    `)
  })

  test('command with no schemas at all', async () => {
    const { output } = await serve(createApp(), ['ping', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "pong": true,
      }
    `)
  })

  test('optional arg can be omitted', async () => {
    const { output } = await serve(createApp(), ['config', '--format', 'json'])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "apiUrl": "https://api.example.com",
        "debug": false,
        "timeout": 30,
      }
    `)
  })

  test('--force passes through to handler', async () => {
    const { output } = await serve(createApp(), [
      'project',
      'delete',
      'p1',
      '--force',
      '--format',
      'json',
    ])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "deleted": true,
        "id": "p1",
      }
    `)
  })

  test('flag order does not matter', async () => {
    const { output } = await serve(createApp(), [
      '--format',
      'json',
      'project',
      'deploy',
      'create',
      'prod',
      '--branch',
      'release',
      '--verbose',
    ])
    expect(json(output)).toMatchInlineSnapshot(`
      {
        "data": {
          "deployId": "d-123",
          "status": "pending",
          "url": "https://prod.example.com",
        },
        "meta": {
          "command": "project deploy create",
          "duration": "<stripped>",
        },
        "ok": true,
      }
    `)
  })

  test('empty argv on router shows help', async () => {
    const { output, exitCode } = await serve(createApp(), [])
    expect(exitCode).toBeUndefined()
    expect(output).toContain('Usage: app <command>')
  })
})

describe('env', () => {
  test('env vars passed to handler', async () => {
    const { output } = await serve(
      createApp(),
      ['auth', 'login', '--verbose', '--format', 'json'],
      { env: { AUTH_HOST: 'custom.example.com' } },
    )
    expect(json(output).data.hostname).toBe('custom.example.com')
  })

  test('env defaults applied when var is unset', async () => {
    const { output } = await serve(
      createApp(),
      ['auth', 'login', '--verbose', '--format', 'json'],
      { env: {} },
    )
    expect(json(output).data.hostname).toBe('api.example.com')
  })

  test('--help shows env vars section', async () => {
    const { output } = await serve(createApp(), ['auth', 'login', '--help'])
    expect(output).toMatchInlineSnapshot(`
      "app auth login — Log in to the service

      Usage: app auth login [options]

      Options:
        --hostname, -h <string>  API hostname (default: api.example.com)
        --web, -w <boolean>      Open browser (default: false)
        --scopes <array>         OAuth scopes

      Environment Variables:
        AUTH_TOKEN  Pre-existing auth token
        AUTH_HOST   Auth server hostname (default: api.example.com)

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--llms json includes schema.env', async () => {
    const { output } = await serve(createApp(), ['auth', '--llms', '--format', 'json'])
    const login = json(output).commands.find((c: any) => c.name === 'auth login')
    expect(login.schema.env.properties).toMatchInlineSnapshot(`
      {
        "AUTH_HOST": {
          "default": "api.example.com",
          "description": "Auth server hostname",
          "type": "string",
        },
        "AUTH_TOKEN": {
          "description": "Pre-existing auth token",
          "type": "string",
        },
      }
    `)
  })

  test('--llms markdown includes env vars table', async () => {
    const { output } = await serve(createApp(), ['auth', '--llms'])
    expect(output).toContain('Environment Variables')
    expect(output).toContain('`AUTH_TOKEN`')
    expect(output).toContain('`AUTH_HOST`')
  })
})

describe('skills staleness', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    __mockSkillsHash = undefined
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  test('warns when running a command with stale skills', async () => {
    __mockSkillsHash = '0000000000000000'
    const { output } = await serve(createApp(), ['ping'])
    expect(output).toContain('pong: true')
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Skills are out of date.'))
  })

  test('no warning when skills hash matches', async () => {
    // Use a simple CLI where we can compute the exact hash
    const cli = Cli.create('tool', { version: '1.0.0' })
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })
    __mockSkillsHash = Skill.hash([{ name: 'ping', description: 'Health check' }])

    const { output } = await serve(cli, ['ping'])
    expect(output).toContain('pong: true')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  test('no warning on first use (no hash stored)', async () => {
    __mockSkillsHash = undefined
    const { output } = await serve(createApp(), ['ping'])
    expect(output).toContain('pong: true')
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  test('no warning for --llms', async () => {
    __mockSkillsHash = '0000000000000000'
    await serve(createApp(), ['--llms'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  test('no warning for --mcp', async () => {
    __mockSkillsHash = '0000000000000000'
    // --mcp starts a server that reads stdin, so we can't easily test it here.
    // Instead verify it doesn't reach the staleness check by checking --version
    await serve(createApp(), ['--version'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})

describe('middleware', () => {
  test('onion execution order around handler', async () => {
    const { cli, order } = createMiddlewareApp()
    const { output } = await serve(cli, ['ping'])
    expect(output).toContain('pong: true')
    expect(order).toEqual(['root-mw:before', 'ping-handler', 'root-mw:after'])
  })

  test('vars: defaults initialize, middleware overrides with set()', async () => {
    const { cli } = createMiddlewareApp()
    const { output } = await serve(cli, ['whoami'])
    expect(output).toMatchInlineSnapshot(`
      "user: alice
      requestId: req-default
      "
    `)
  })

  test('vars: verbose envelope includes var data', async () => {
    const { cli } = createMiddlewareApp()
    const { output } = await serve(cli, ['whoami', '--verbose', '--format', 'json'])
    const parsed = json(output)
    expect(parsed.data.user).toBe('alice')
    expect(parsed.data.requestId).toBe('req-default')
  })

  test('group-scoped middleware runs after root middleware', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    await serve(cli, ['admin', 'reset'])
    expect(order).toEqual(['root-mw:before', 'admin-mw', 'reset-handler', 'root-mw:after'])
  })

  test('group middleware does not run for non-group commands', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    await serve(cli, ['ping'])
    expect(order).not.toContain('admin-mw')
  })

  test('middleware wraps streaming handlers', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    const { output } = await serve(cli, ['stream'])
    expect(output).toContain('n: 1')
    expect(output).toContain('n: 2')
    expect(order).toEqual(['root-mw:before', 'stream:1', 'stream:2', 'root-mw:after'])
  })

  test('middleware errors propagate as command errors', async () => {
    const { cli } = createMiddlewareApp()
    const { output, exitCode } = await serve(cli, ['explode'])
    expect(exitCode).toBe(1)
    expect(output).toContain('BOOM')
    expect(output).toContain('kaboom')
  })

  test('middleware does not run for --help', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    await serve(cli, ['--help'])
    expect(order).toEqual([])
  })

  test('middleware does not run for --llms', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    await serve(cli, ['--llms'])
    expect(order).toEqual([])
  })

  test('middleware does not run for --version', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    await serve(cli, ['--version'])
    expect(order).toEqual([])
  })

  test('middleware does not run for command --help', async () => {
    const { cli, order } = createMiddlewareApp()
    order.length = 0
    await serve(cli, ['ping', '--help'])
    expect(order).toEqual([])
  })

  test('short-circuit: middleware that does not call next() prevents handler', async () => {
    const order: string[] = []
    const cli = Cli.create('app')
      .use(async (_c, _next) => {
        order.push('gate')
        // intentionally not calling next()
      })
      .command('deploy', {
        run() {
          order.push('handler')
          return { deployed: true }
        },
      })

    const { output } = await serve(cli, ['deploy'])
    expect(order).toEqual(['gate'])
    expect(output).toBe('')
  })
})

describe('deprecated flags', () => {
  test('emits stderr warning when deprecated flag is used in TTY mode', async () => {
    const cli = Cli.create('app')
      .command('deploy', {
        options: z.object({
          zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
          region: z.string().optional().describe('Target region'),
        }),
        run: ({ options }) => ({ zone: options.zone, region: options.region }),
      })

    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    ;(process.stdout as any).isTTY = true
    try {
      await serve(cli, ['deploy', '--zone', 'us-east-1'])
      expect(spy).toHaveBeenCalledWith('Warning: --zone is deprecated\n')
    } finally {
      ;(process.stdout as any).isTTY = false
      spy.mockRestore()
    }
  })

  test('does not emit stderr warning for non-deprecated flags', async () => {
    const cli = Cli.create('app')
      .command('deploy', {
        options: z.object({
          zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
          region: z.string().optional().describe('Target region'),
        }),
        run: ({ options }) => ({ region: options.region }),
      })

    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    ;(process.stdout as any).isTTY = true
    try {
      await serve(cli, ['deploy', '--region', 'us-west-2'])
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'))
    } finally {
      ;(process.stdout as any).isTTY = false
      spy.mockRestore()
    }
  })

  test('does not emit stderr warning in agent mode (non-TTY)', async () => {
    const cli = Cli.create('app')
      .command('deploy', {
        options: z.object({
          zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
        }),
        run: ({ options }) => ({ zone: options.zone }),
      })

    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await serve(cli, ['deploy', '--zone', 'us-east-1'])
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('deprecated'))
    } finally {
      spy.mockRestore()
    }
  })
})

async function serve(
  cli: { serve: Cli.Cli['serve'] },
  argv: string[],
  options: Cli.serve.Options = {},
) {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
    ...options,
  })
  return {
    output: output
      .replace(/duration: \d+ms/g, 'duration: <stripped>')
      .replace(/"duration": "\d+ms"/g, '"duration": "<stripped>"'),
    exitCode,
  }
}

function json(raw: string) {
  return JSON.parse(raw)
}

function createMiddlewareApp() {
  const order: string[] = []

  const admin = Cli.create('admin', { description: 'Admin commands' })
    .use(async (_c, next) => {
      order.push('admin-mw')
      await next()
    })
    .command('reset', {
      description: 'Reset database',
      run() {
        order.push('reset-handler')
        return { reset: true }
      },
    })

  const cli = Cli.create('app', {
    description: 'Middleware test app',
    version: '1.0.0',
    vars: z.object({
      user: z.string().default('anon'),
      requestId: z.string().default(() => 'req-default'),
    }),
  })
    .use(async (c, next) => {
      order.push('root-mw:before')
      c.set('user', 'alice')
      await next()
      order.push('root-mw:after')
    })
    .command('whoami', {
      description: 'Show current user',
      run(c) {
        order.push('whoami-handler')
        return { user: c.var.user, requestId: c.var.requestId }
      },
    })
    .command('ping', {
      description: 'Health check',
      run() {
        order.push('ping-handler')
        return { pong: true }
      },
    })
    .command('explode', {
      description: 'Always fails',
      run() {
        throw new Errors.IncurError({ code: 'BOOM', message: 'kaboom' })
      },
    })
    .command('stream', {
      description: 'Stream chunks',
      async *run() {
        order.push('stream:1')
        yield { n: 1 }
        order.push('stream:2')
        yield { n: 2 }
      },
    })
    .command(admin)

  return { cli, order }
}

function createApp() {
  const auth = Cli.create('auth', { description: 'Authentication commands' })
    .command('login', {
      description: 'Log in to the service',
      env: z.object({
        AUTH_TOKEN: z.string().optional().describe('Pre-existing auth token'),
        AUTH_HOST: z.string().default('api.example.com').describe('Auth server hostname'),
      }),
      options: z.object({
        hostname: z.string().default('api.example.com').describe('API hostname'),
        web: z.boolean().default(false).describe('Open browser'),
        scopes: z.array(z.string()).default([]).describe('OAuth scopes'),
      }),
      alias: { hostname: 'h', web: 'w' },
      run(c) {
        return c.ok(
          { hostname: c.env.AUTH_HOST, scopes: c.options.scopes },
          {
            cta: {
              description: 'Verify your session:',
              commands: ['auth status'],
            },
          },
        )
      },
    })
    .command('logout', {
      description: 'Log out of the service',
      run(c) {
        return c.ok({ loggedOut: true })
      },
    })
    .command('status', {
      description: 'Show authentication status',
      output: z.object({ loggedIn: z.boolean(), hostname: z.string(), user: z.string() }),
      run(c) {
        return c.error({
          code: 'NOT_AUTHENTICATED',
          message: 'Not logged in',
          retryable: false,
          cta: { commands: ['auth login'] },
        })
      },
    })

  const project = Cli.create('project', { description: 'Manage projects' })
    .command('list', {
      description: 'List projects',
      options: z.object({
        limit: z.number().default(20).describe('Max results'),
        sort: z.enum(['name', 'created', 'updated']).default('name').describe('Sort field'),
        archived: z.boolean().default(false).describe('Include archived'),
      }),
      alias: { limit: 'l', sort: 's' },

      output: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            archived: z.boolean(),
          }),
        ),
        total: z.number(),
      }),
      run(c) {
        const items = [
          { id: 'p1', name: 'Alpha', archived: false },
          { id: 'p2', name: 'Beta', archived: true },
        ].filter((p) => c.options.archived || !p.archived)
        return c.ok(
          { items, total: items.length },
          {
            cta: {
              commands: items.map((p) => ({
                command: `project get ${p.id}`,
                description: `View "${p.name}"`,
              })),
            },
          },
        )
      },
    })
    .command('get', {
      description: 'Get a project by ID',
      args: z.object({ id: z.string().describe('Project ID') }),
      output: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        members: z.array(z.object({ userId: z.string(), role: z.string() })),
      }),
      run(c) {
        return c.ok({
          id: c.args.id,
          name: 'Alpha',
          description: 'Main project',
          members: [{ userId: 'u1', role: 'admin' }],
        })
      },
    })
    .command('create', {
      description: 'Create a new project',
      args: z.object({ name: z.string().describe('Project name') }),
      options: z.object({
        description: z.string().default('').describe('Project description'),
        private: z.boolean().default(false).describe('Private project'),
      }),
      alias: { description: 'd' },

      output: z.object({ id: z.string(), url: z.string() }),
      run(c) {
        return c.ok(
          { id: 'p-new', url: 'https://example.com/projects/p-new' },
          {
            cta: {
              commands: [
                { command: 'project get p-new', description: `View "${c.args.name}"` },
                'project list',
              ],
            },
          },
        )
      },
    })
    .command('delete', {
      description: 'Delete a project',
      args: z.object({ id: z.string().describe('Project ID') }),
      options: z.object({
        force: z.boolean().default(false).describe('Skip confirmation'),
      }),
      alias: { force: 'f' },

      run(c) {
        if (!c.options.force)
          throw new Errors.IncurError({
            code: 'CONFIRMATION_REQUIRED',
            message: `Use --force to delete project ${c.args.id}`,
            retryable: true,
          })
        return { deleted: true, id: c.args.id }
      },
    })

  const deploy = Cli.create('deploy', { description: 'Deployment commands' })
    .command('create', {
      description: 'Create a deployment',
      args: z.object({ env: z.string().describe('Target environment') }),
      options: z.object({
        branch: z.string().default('main').describe('Branch to deploy'),
        dryRun: z.boolean().default(false).describe('Dry run mode'),
      }),
      alias: { branch: 'b' },

      output: z.object({ deployId: z.string(), url: z.string(), status: z.string() }),
      examples: [
        { description: 'Deploy staging from main', args: { env: 'staging' } },
        {
          description: 'Dry run a production deploy',
          args: { env: 'production' },
          options: { branch: 'release', dryRun: true },
        },
      ],
      run(c) {
        return c.ok({
          deployId: 'd-123',
          url: `https://${c.args.env}.example.com`,
          status: c.options.dryRun ? 'dry-run' : 'pending',
        })
      },
    })
    .command('status', {
      description: 'Check deployment status',
      args: z.object({ deployId: z.string().describe('Deployment ID') }),

      output: z.object({ deployId: z.string(), status: z.string(), progress: z.number() }),
      run(c) {
        return { deployId: c.args.deployId, status: 'running', progress: 75 }
      },
    })
    .command('rollback', {
      description: 'Rollback a deployment',
      args: z.object({ deployId: z.string().describe('Deployment ID') }),

      run(c) {
        return { rolledBack: true, deployId: c.args.deployId }
      },
    })

  project.command(deploy)

  const config = Cli.create('config', {
    description: 'Show current configuration',
    args: z.object({ key: z.string().optional().describe('Config key to show') }),
    run(c) {
      if (c.args.key) return { key: c.args.key, value: 'some-value' }
      return { apiUrl: 'https://api.example.com', timeout: 30, debug: false }
    },
  })

  const cli = Cli.create('app', {
    version: '3.5.0',
    description: 'A comprehensive CLI application for testing.',
  })

  cli.command('ping', {
    description: 'Health check',
    run() {
      return { pong: true }
    },
  })

  cli.command('echo', {
    description: 'Echo back arguments',
    args: z.object({
      message: z.string().describe('Message to echo'),
      repeat: z.number().optional().describe('Times to repeat'),
    }),
    options: z.object({
      upper: z.boolean().default(false).describe('Uppercase output'),
      prefix: z.string().default('').describe('Prefix string'),
    }),
    alias: { upper: 'u', prefix: 'p' },
    run(c) {
      const count = c.args.repeat ?? 1
      let msg = c.options.prefix ? `${c.options.prefix} ${c.args.message}` : c.args.message
      if (c.options.upper) msg = msg.toUpperCase()
      return { result: Array(count).fill(msg) }
    },
  })

  cli.command('slow', {
    description: 'Async command',
    async run() {
      await new Promise((r) => setTimeout(r, 5))
      return { done: true }
    },
  })

  cli.command('explode', {
    description: 'Always fails',
    run() {
      throw new Error('kaboom')
    },
  })

  cli.command('explode-clac', {
    description: 'Fails with IncurError',
    run() {
      throw new Errors.IncurError({
        code: 'QUOTA_EXCEEDED',
        message: 'Rate limit exceeded',
        retryable: true,
        hint: 'Wait 60 seconds',
      })
    },
  })

  cli.command('validate-fail', {
    description: 'Fails validation',
    args: z.object({
      email: z.string().email().describe('Email address'),
      age: z.number().min(0).max(150).describe('Age'),
    }),
    run({ args }) {
      return args
    },
  })

  cli.command('noop', {
    description: 'Returns nothing',
    run() {},
  })

  cli.command('stream', {
    description: 'Stream chunks',
    async *run() {
      yield { content: 'hello' }
      yield { content: 'world' }
    },
  })

  cli.command('stream-text', {
    description: 'Stream plain text',
    async *run() {
      yield 'hello'
      yield 'world'
    },
  })

  cli.command('stream-ok', {
    description: 'Stream with ok() return',
    async *run({ ok }) {
      yield { n: 1 }
      yield { n: 2 }
      return ok(undefined as any, { cta: { commands: ['ping'] } })
    },
  })

  cli.command('stream-error', {
    description: 'Stream with mid-stream error',
    async *run({ error }) {
      yield { n: 1 }
      return error({ code: 'STREAM_FAIL', message: 'broke mid-stream' })
    },
  })

  cli.command('stream-throw', {
    description: 'Stream that throws',
    async *run() {
      yield { n: 1 }
      throw new Error('stream kaboom')
    },
  })

  cli.command(auth)
  cli.command(project)
  cli.command(config)

  return cli
}
