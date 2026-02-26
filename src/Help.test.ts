import { Help, z } from 'clac'

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

      Usage: gh pr list [repo]

      Arguments:
        repo  Repository in owner/repo format

      Options:
        --state <string>  Filter by state (default: open)
        --limit <number>  Max PRs to return (default: 30)

      Built-in Commands:
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md>  Output format
        --help                        Show help
        --llms                        Print LLM-readable manifest
        --verbose                     Show full output envelope
        --version                     Show version"
    `)
  })

  test('omits sections when no schemas', () => {
    const result = Help.formatCommand('tool ping', {
      description: 'Health check',
    })
    expect(result).toMatchInlineSnapshot(`
      "tool ping — Health check

      Usage: tool ping

      Built-in Commands:
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md>  Output format
        --help                        Show help
        --llms                        Print LLM-readable manifest
        --verbose                     Show full output envelope
        --version                     Show version"
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

      Built-in Commands:
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md>  Output format
        --help                        Show help
        --llms                        Print LLM-readable manifest
        --verbose                     Show full output envelope
        --version                     Show version"
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

      Built-in Commands:
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md>  Output format
        --help                        Show help
        --llms                        Print LLM-readable manifest
        --verbose                     Show full output envelope
        --version                     Show version"
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

      Built-in Commands:
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md>  Output format
        --help                        Show help
        --llms                        Print LLM-readable manifest
        --verbose                     Show full output envelope
        --version                     Show version"
    `)
  })
})
