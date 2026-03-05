import { Help, z } from 'incur'

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
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
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
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
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
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
        --verbose                           Show full output envelope"
    `)
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
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
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
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
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
      Aliases: mt, myt

      Usage: my-tool <command>

      Commands:
        fetch  Fetch a URL

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
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
      Aliases: mt, myt

      Usage: my-tool <url>

      Arguments:
        url  URL to fetch

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --schema                            Show JSON Schema for a command
        --verbose                           Show full output envelope"
    `)
  })
})
