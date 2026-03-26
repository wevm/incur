import { Skill, z } from 'incur'

test('generates skill file with frontmatter and heading', () => {
  const result = Skill.generate('test', [{ name: 'ping', description: 'Health check' }])
  expect(result).toMatchInlineSnapshot(`
    "# test ping

    Health check"
  `)
})

test('includes arguments table', () => {
  const result = Skill.generate('test', [
    {
      name: 'greet',
      description: 'Greet someone',
      args: z.object({ name: z.string().describe('Name to greet') }),
    },
  ])
  expect(result).toMatchInlineSnapshot(`
    "# test greet

    Greet someone

    ## Arguments

    | Name | Type | Required | Description |
    |------|------|----------|-------------|
    | \`name\` | \`string\` | yes | Name to greet |"
  `)
})

test('includes options table', () => {
  const result = Skill.generate('test', [
    {
      name: 'list',
      description: 'List items',
      options: z.object({
        limit: z.number().default(30).describe('Max items'),
        verbose: z.boolean().default(false).describe('Show details'),
      }),
    },
  ])
  expect(result).toMatchInlineSnapshot(`
    "# test list

    List items

    ## Options

    | Flag | Type | Default | Description |
    |------|------|---------|-------------|
    | \`--limit\` | \`number\` | \`30\` | Max items |
    | \`--verbose\` | \`boolean\` | \`false\` | Show details |"
  `)
})

test('prepends **Deprecated.** to deprecated option descriptions', () => {
  const result = Skill.generate('test', [
    {
      name: 'deploy',
      description: 'Deploy app',
      options: z.object({
        zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
        region: z.string().optional().describe('Target region'),
      }),
    },
  ])
  expect(result).toContain('**Deprecated.** Availability zone')
  expect(result).not.toContain('**Deprecated.** Target region')
})

test('includes output schema', () => {
  const result = Skill.generate('test', [
    {
      name: 'greet',
      description: 'Greet someone',
      output: z.object({ message: z.string().describe('Greeting message') }),
    },
  ])
  expect(result).toMatchInlineSnapshot(`
    "# test greet

    Greet someone

    ## Output

    | Field | Type | Required | Description |
    |-------|------|----------|-------------|
    | \`message\` | \`string\` | yes | Greeting message |"
  `)
})

test('expands nested output schema', () => {
  const result = Skill.generate('test', [
    {
      name: 'list',
      description: 'List items',
      output: z.object({
        items: z.array(
          z.object({
            id: z.number(),
            meta: z.object({ tag: z.string() }),
          }),
        ),
      }),
    },
  ])
  expect(result).toMatchInlineSnapshot(`
    "# test list

    List items

    ## Output

    | Field | Type | Required | Description |
    |-------|------|----------|-------------|
    | \`items\` | \`array\` | yes |  |
    | \`items[].id\` | \`number\` | yes |  |
    | \`items[].meta\` | \`object\` | yes |  |
    | \`items[].meta.tag\` | \`string\` | yes |  |"
  `)
})

test('omits sections when not applicable', () => {
  const result = Skill.generate('test', [{ name: 'ping', description: 'Health check' }])
  expect(result).not.toContain('## Arguments')
  expect(result).not.toContain('## Options')
  expect(result).not.toContain('## Output')
})

test('concatenates multiple commands', () => {
  const result = Skill.generate('test', [
    { name: 'ping', description: 'Health check' },
    { name: 'pong', description: 'Pong back' },
  ])
  expect(result).toMatchInlineSnapshot(`
    "# test ping

    Health check

    # test pong

    Pong back"
  `)
})

describe('index', () => {
  test('generates compact command index', () => {
    const result = Skill.index('test', [
      { name: 'ping', description: 'Health check' },
      { name: 'greet', description: 'Greet someone', args: z.object({ name: z.string() }) },
    ])
    expect(result).toMatchInlineSnapshot(`
      "# test

      | Command | Description |
      |---------|-------------|
      | \`test ping\` | Health check |
      | \`test greet <name>\` | Greet someone |

      Run \`test --llms-full\` for full manifest. Run \`test <command> --schema\` for argument details."
    `)
  })

  test('uses brackets for optional args', () => {
    const result = Skill.index('test', [
      {
        name: 'install',
        description: 'Install a package',
        args: z.object({ package: z.string().optional() }),
      },
    ])
    expect(result).toContain('`test install [package]`')
  })

  test('handles commands without descriptions', () => {
    const result = Skill.index('test', [{ name: 'ping' }])
    expect(result).toContain('| `test ping` |  |')
  })
})

describe('hash', () => {
  test('returns consistent hash for same commands', () => {
    const commands: Skill.CommandInfo[] = [
      { name: 'ping', description: 'Health check' },
      { name: 'greet', description: 'Say hello' },
    ]
    expect(Skill.hash(commands)).toBe(Skill.hash(commands))
  })

  test('changes when command is added', () => {
    const a = Skill.hash([{ name: 'ping', description: 'Health check' }])
    const b = Skill.hash([
      { name: 'ping', description: 'Health check' },
      { name: 'greet', description: 'Say hello' },
    ])
    expect(a).not.toBe(b)
  })

  test('changes when description changes', () => {
    const a = Skill.hash([{ name: 'ping', description: 'Health check' }])
    const b = Skill.hash([{ name: 'ping', description: 'Check health' }])
    expect(a).not.toBe(b)
  })

  test('changes when schema changes', () => {
    const a = Skill.hash([{ name: 'greet', args: z.object({ name: z.string() }) }])
    const b = Skill.hash([{ name: 'greet', args: z.object({ name: z.string(), age: z.number() }) }])
    expect(a).not.toBe(b)
  })

  test('returns 16-char hex string', () => {
    const h = Skill.hash([{ name: 'ping' }])
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('split', () => {
  const commands: Skill.CommandInfo[] = [
    { name: 'auth login', description: 'Log in' },
    { name: 'auth status', description: 'Check status' },
    { name: 'pr list', description: 'List PRs' },
    { name: 'pr create', description: 'Create PR' },
  ]

  const groups = new Map([
    ['auth', 'Authenticate with GitHub'],
    ['pr', 'Manage pull requests'],
  ])

  test('depth 0 returns single file', () => {
    const files = Skill.split('gh', commands, 0)
    expect(files.map((f) => f.dir)).toMatchInlineSnapshot(`
      [
        "",
      ]
    `)
    expect(files[0]!.content).toContain('name: gh')
    expect(files[0]!.content).toContain('# gh auth login')
    expect(files[0]!.content).toContain('# gh pr list')
  })

  test('depth 1 groups by first segment with group frontmatter', () => {
    const files = Skill.split('gh', commands, 1, groups)
    expect(files.map((f) => f.dir)).toMatchInlineSnapshot(`
      [
        "auth",
        "pr",
      ]
    `)
    expect(files[0]!.content).toMatchInlineSnapshot(`
      "---
      name: gh-auth
      description: Authenticate with GitHub. Log in, Check status. Run \`gh auth --help\` for usage details.
      requires_bin: gh
      command: gh auth
      ---

      # gh auth login

      Log in

      ---

      # gh auth status

      Check status"
    `)
    expect(files[1]!.content).toMatchInlineSnapshot(`
      "---
      name: gh-pr
      description: Manage pull requests. List PRs, Create PR. Run \`gh pr --help\` for usage details.
      requires_bin: gh
      command: gh pr
      ---

      # gh pr list

      List PRs

      ---

      # gh pr create

      Create PR"
    `)
  })

  test('depth 1 without group descriptions uses child descriptions', () => {
    const files = Skill.split('gh', commands, 1)
    expect(files[0]!.content).toContain(
      'description: Log in, Check status. Run `gh auth --help` for usage details.',
    )
  })

  test('depth 2 groups by first two segments', () => {
    const files = Skill.split('gh', commands, 2)
    expect(files.map((f) => f.dir)).toMatchInlineSnapshot(`
      [
        "auth-login",
        "auth-status",
        "pr-create",
        "pr-list",
      ]
    `)
  })

  test('shallow commands use available segments', () => {
    const files = Skill.split('test', [{ name: 'ping', description: 'Ping' }], 2)
    expect(files.map((f) => f.dir)).toMatchInlineSnapshot(`
      [
        "ping",
      ]
    `)
  })

  test('description includes --help hint for depth 0', () => {
    const files = Skill.split('gh', commands, 0, groups)
    expect(files[0]!.content).toContain('Run `gh --help` for usage details.')
  })

  test('description includes --help hint for depth 1 with groups', () => {
    const files = Skill.split('gh', commands, 1, groups)
    expect(files[0]!.content).toContain('Run `gh auth --help` for usage details.')
    expect(files[1]!.content).toContain('Run `gh pr --help` for usage details.')
  })

  test('description includes --help hint for depth 2', () => {
    const files = Skill.split('gh', commands, 2)
    expect(files[0]!.content).toContain('Run `gh auth login --help` for usage details.')
  })

  test('emits fallback description when no explicit descriptions exist', () => {
    const files = Skill.split('test', [{ name: 'ping' }], 1)
    expect(files[0]!.content).toContain('description: Run `test ping --help` for usage details.')
  })

  test('includes requires_bin in frontmatter', () => {
    const files = Skill.split('gh', [{ name: 'auth login', description: 'Log in' }], 1)
    expect(files[0]!.content).toContain('requires_bin: gh')
  })

  test('YAML-quotes description containing colon-space', () => {
    const groups = new Map([['search', 'Search items. Use key: value for precision']])
    const files = Skill.split('app', [{ name: 'search list', description: 'List results' }], 1, groups)
    expect(files[0]!.content).toContain(
      'description: "Search items. Use key: value for precision. List results. Run `app search --help` for usage details."',
    )
  })

  test('no per-command frontmatter in split files', () => {
    const files = Skill.split('gh', commands, 1, groups)
    const afterFrontmatter = files[0]!.content.slice(
      files[0]!.content.indexOf('---', files[0]!.content.indexOf('---') + 3) + 3,
    )
    expect(afterFrontmatter).not.toMatch(/^title:/m)
    expect(afterFrontmatter).not.toMatch(/^command:/m)
  })
})
