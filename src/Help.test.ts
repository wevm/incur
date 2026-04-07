import { Help, z } from 'incur'

describe('redact: short secrets should not leak characters', () => {
  /**
   * The internal `redact()` function is exercised through `formatCommand`
   * by passing an env schema + envSource with a set value.
   */
  function getRedactedValue(secret: string): string {
    const env = z.object({ SECRET: z.string().describe('a secret') })
    const output = Help.formatCommand('test', {
      env,
      envSource: { SECRET: secret },
      hideGlobalOptions: true,
    })
    const match = output.match(/set:\s*(\S+)/)
    if (!match) throw new Error(`Could not find "set:" in output:\n${output}`)
    return match[1]!
  }

  test('1-char secret is fully masked', () => {
    const redacted = getRedactedValue('x')
    expect(redacted).not.toContain('x')
  })

  test('2-char secret does not leak any character', () => {
    const redacted = getRedactedValue('ab')
    expect(redacted).not.toContain('b')
  })

  test('3-char secret does not leak any character', () => {
    const redacted = getRedactedValue('abc')
    expect(redacted).not.toContain('c')
  })

  test('4-char secret does not leak any character', () => {
    const redacted = getRedactedValue('wxyz')
    expect(redacted).not.toContain('z')
  })
})

describe('formatCommand', () => {
  test('formats leaf command with args and options', () => {
    const result = Help.formatCommand('gh pr list', {
      description: 'List pull requests',
      args: z.object({
        repo: z.string().optional().describe('Repository in owner/repo format'),
      }),
      options: z.object({
        state: z.string().default('open').describe('Filter by state'),
        limit: z.number().default(30).describe('Max PRs to return'),
      }),
    })
    expect(result).toMatchInlineSnapshot(`
      "gh pr list — List pull requests

      Usage: gh pr list [repo] [options]

      Arguments:
        repo  Repository in owner/repo format

      Options:
        --state <string>  Filter by state (default: open)
        --limit <number>  Max PRs to return (default: 30)

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('omits sections when no schemas', () => {
    const result = Help.formatCommand('tool ping', {
      description: 'Health check',
    })
    expect(result).toMatchInlineSnapshot(`
      "tool ping — Health check

      Usage: tool ping

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('formats optional args in brackets, required in angle brackets', () => {
    const result = Help.formatCommand('tool greet', {
      args: z.object({
        name: z.string().describe('Name'),
        title: z.string().optional().describe('Title'),
      }),
    })
    expect(result).toMatchInlineSnapshot(`
      "tool greet

      Usage: tool greet <name> [title]

      Arguments:
        name   Name
        title  Title

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('synopsis uses key name for non-union args and expanded values for enums', () => {
    const result = Help.formatCommand('tool run', {
      args: z.object({
        port: z.number().describe('Port number'),
        verbose: z.boolean().optional().describe('Verbose'),
        mode: z.enum(['fast', 'slow']).describe('Mode'),
      }),
    })
    expect(result).toContain('Usage: tool run <port> [verbose] <fast|slow>')
  })

  test('shows count type in help for meta count', () => {
    const result = Help.formatCommand('tool run', {
      options: z.object({
        verbose: z.number().default(0).meta({ count: true }).describe('Verbosity level'),
      }),
      alias: { verbose: 'v' },
    })
    expect(result).toContain('--verbose, -v <count>')
    expect(result).toContain('Verbosity level')
  })

  test('omits value placeholders for boolean flag options', () => {
    const result = Help.formatCommand('tool deploy', {
      options: z.object({
        dryRun: z.boolean().optional().describe('Preview without submitting.'),
      }),
    })

    const line = result.split('\n').find((line) => line.includes('--dry-run'))

    expect(line).toBe('  --dry-run  Preview without submitting.')
  })

  test('omits value placeholders for aliased boolean flag options', () => {
    const result = Help.formatCommand('tool deploy', {
      options: z.object({
        dryRun: z.boolean().optional().describe('Preview without submitting.'),
      }),
      alias: { dryRun: 'd' },
    })

    const line = result.split('\n').find((line) => line.includes('--dry-run'))

    expect(line).toBe('  --dry-run, -d  Preview without submitting.')
  })

  test('omits default false for boolean flag options', () => {
    const result = Help.formatCommand('tool deploy', {
      options: z.object({
        dryRun: z.boolean().default(false).describe('Preview without submitting.'),
      }),
    })

    const line = result.split('\n').find((line) => line.includes('--dry-run'))

    expect(line).toBe('  --dry-run  Preview without submitting.')
  })

  test('shows default true for boolean flag options', () => {
    const result = Help.formatCommand('tool deploy', {
      options: z.object({
        watch: z.boolean().default(true).describe('Watch for changes.'),
      }),
    })

    const line = result.split('\n').find((line) => line.includes('--watch'))

    expect(line).toBe('  --watch  Watch for changes. (default: true)')
  })

  test('shows enum values for z.enum options', () => {
    const result = Help.formatCommand('tool deploy', {
      options: z.object({
        env: z.enum(['staging', 'production']).describe('Target environment'),
      }),
    })
    expect(result).toContain('--env <staging|production>')
  })

  test('shows literal values for z.union of z.literal options', () => {
    const result = Help.formatCommand('tool deploy', {
      options: z.object({
        level: z
          .union([z.literal('low'), z.literal('medium'), z.literal('high')])
          .describe('Priority level'),
      }),
    })
    expect(result).toContain('--level <low|medium|high>')
  })

  test('shows [deprecated] tag for deprecated options', () => {
    const result = Help.formatCommand('tool deploy', {
      description: 'Deploy app',
      options: z.object({
        zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
        region: z.string().optional().describe('Target region'),
      }),
    })
    expect(result).toContain('[deprecated] Availability zone')
    expect(result).not.toContain('[deprecated] Target region')
  })

  test('shows config global options when flag name is set', () => {
    const result = Help.formatCommand('tool deploy', {
      configFlag: 'config',
      options: z.object({
        env: z.enum(['staging', 'production']).describe('Target environment'),
      }),
    })
    expect(result).toMatchInlineSnapshot(`
      "tool deploy

      Usage: tool deploy [options]

      Options:
        --env <staging|production>  Target environment

      Global Options:
        --config <path>                     Load JSON option defaults from a file
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --no-config                         Disable JSON option defaults for this run
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })
})

describe('formatRoot', () => {
  test('formats root with command list', () => {
    const result = Help.formatRoot('gh', {
      description: 'GitHub CLI',
      commands: [
        { name: 'pr list', description: 'List pull requests' },
        { name: 'pr view', description: 'View a pull request' },
        { name: 'issue list', description: 'List issues' },
      ],
    })
    expect(result).toMatchInlineSnapshot(`
      "gh — GitHub CLI

      Usage: gh <command>

      Commands:
        pr list     List pull requests
        pr view     View a pull request
        issue list  List issues

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('formats root with no description', () => {
    const result = Help.formatRoot('tool', {
      commands: [{ name: 'ping', description: 'Health check' }],
    })
    expect(result).toMatchInlineSnapshot(`
      "tool

      Usage: tool <command>

      Commands:
        ping  Health check

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('formatRoot shows aliases', () => {
    const result = Help.formatRoot('my-tool', {
      description: 'A test CLI',
      version: '1.0.0',
      aliases: ['mt', 'myt'],
      commands: [{ name: 'fetch', description: 'Fetch a URL' }],
    })
    expect(result).toMatchInlineSnapshot(`
      "my-tool@1.0.0 — A test CLI

      Usage: my-tool <command>
      Aliases: mt, myt

      Commands:
        fetch  Fetch a URL

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('formatCommand shows aliases', () => {
    const result = Help.formatCommand('my-tool', {
      description: 'A test CLI',
      version: '1.0.0',
      aliases: ['mt', 'myt'],
      args: z.object({ url: z.string().describe('URL to fetch') }),
    })
    expect(result).toMatchInlineSnapshot(`
      "my-tool@1.0.0 — A test CLI

      Usage: my-tool <url>
      Aliases: mt, myt

      Arguments:
        url  URL to fetch

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope"
    `)
  })

  test('formatRoot shows config global options when flag name is set', () => {
    const result = Help.formatRoot('tool', {
      configFlag: 'config',
      root: true,
      commands: [{ name: 'ping', description: 'Health check' }],
    })
    expect(result).toMatchInlineSnapshot(`
      "tool

      Usage: tool <command>

      Commands:
        ping  Health check

      Integrations:
        completions  Generate shell completion script
        mcp add      Register as MCP server
        skills       Sync skill files to agents (add, list)

      Global Options:
        --config <path>                     Load JSON option defaults from a file
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --no-config                         Disable JSON option defaults for this run
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope
        --version                           Show version"
    `)
  })
})
