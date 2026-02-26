import { Cli, z } from 'incur'

const cli = Cli.create('presto', {
  version: '0.4.1',
  description: 'A command-line HTTP client with built-in MPP payment support.',
})

// query (root-level URL request) — modeled as an explicit subcommand
cli.command('query', {
  description: 'Make an HTTP request with optional payment',
  args: z.object({
    url: z.string().describe('URL to request'),
  }),
  options: z.object({
    dryRun: z.boolean().optional().describe('Show what would be paid without executing'),
    method: z.string().optional().describe('Custom request method (GET, POST, PUT, DELETE, ...)'),
    header: z.array(z.string()).optional().describe("Add custom header (e.g. 'Accept: text/plain')"),
    data: z.array(z.string()).optional().describe('POST data (use @filename or @- for stdin)'),
    json: z.string().optional().describe('Send JSON data with Content-Type header'),
    include: z.boolean().optional().describe('Include HTTP response headers in output'),
    output: z.string().optional().describe('Write output to file'),
    timeout: z.number().optional().describe('Maximum time for the request in seconds'),
    noRedirect: z.boolean().optional().describe('Disable following redirects'),
    network: z.string().optional().describe('Restrict to a specific network'),
  }),
  alias: { method: 'X', header: 'H', data: 'd', include: 'i', output: 'o', timeout: 'm', network: 'n' },
  examples: [
    { args: { url: 'https://api.example.com/data' }, description: 'Simple GET' },
    {
      args: { url: 'https://api.example.com/data' },
      options: { method: 'POST', json: '{"key":"value"}' },
      description: 'POST with JSON body',
    },
    {
      args: { url: 'https://api.example.com/data' },
      options: { dryRun: true },
      description: 'Preview payment without executing',
    },
  ],
  run({ args, error }) {
    const loggedIn = true
    if (!loggedIn)
      return error({
        code: 'NOT_AUTHENTICATED',
        message: 'No wallet connected. Log in first.',
        retryable: true,
        cta: {
          description: 'To authenticate:',
          commands: [
            { command: 'login', description: 'Sign up or log in to your Tempo wallet' },
          ],
        },
      })
    return {
      id: 'chatcmpl-abc123',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello! How can I help you today?' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 },
    }
  },
})

cli.command('login', {
  description: 'Sign up or log in to your Tempo wallet',
  run({ ok }) {
    return ok({ status: 'logged_in' }, {
      cta: {
        description: 'Next steps:',
        commands: [
          { command: 'whoami', description: 'Check your wallet address and balances' },
          { command: 'query', args: { url: 'https://api.example.com/data' }, description: 'Make your first paid request' },
        ],
      },
    })
  },
})

cli.command('logout', {
  description: 'Log out and disconnect your wallet',
  options: z.object({
    yes: z.boolean().optional().describe('Skip confirmation prompt'),
  }),
  run() {
    return { status: 'logged_out' }
  },
})

cli.command('whoami', {
  description: 'Show wallet address, balances, and access keys',
  output: z.object({
    address: z.string(),
    balances: z.array(z.object({
      network: z.string(),
      amount: z.string(),
    })),
  }),
  run() {
    return {
      address: '0x1234...abcd',
      balances: [{ network: 'tempo', amount: '100.00 TEMPO' }],
    }
  },
})

// session subcommand group
const session = Cli.create('session', { description: 'Manage payment sessions' })

session.command('list', {
  description: 'List active payment sessions',
  options: z.object({
    all: z.boolean().optional().describe('Show all channels: active, orphaned, and closing'),
    orphaned: z.boolean().optional().describe('Scan on-chain for orphaned channels'),
    closed: z.boolean().optional().describe('Show channels pending finalization'),
    network: z.string().optional().describe('Filter by network'),
  }),
  run() {
    return { sessions: [] }
  },
})

session.command('close', {
  description: 'Close a payment session',
  args: z.object({
    url: z.string().optional().describe('URL, origin, or channel ID (0x...) to close'),
  }),
  options: z.object({
    all: z.boolean().optional().describe('Close all active sessions'),
    orphaned: z.boolean().optional().describe('Close only orphaned on-chain channels'),
    closed: z.boolean().optional().describe('Finalize channels pending close'),
  }),
  run({ ok }) {
    return ok({ closed: true }, {
      cta: {
        description: 'Suggested commands:',
        commands: [
          { command: 'session list', description: 'View remaining sessions' },
          { command: 'whoami', description: 'Check updated balances' },
        ],
      },
    })
  },
})

session.command('recover', {
  description: 'Recover a session from on-chain state',
  run() {
    return { recovered: true }
  },
})

cli.command(session)

// key subcommand group
const key = Cli.create('key', { description: 'Manage access keys' })

key.command('list', {
  description: 'List all access keys and their spending limits',
  run() {
    return { keys: [] }
  },
})

key.command('create', {
  description: 'Create a new access key for a local wallet',
  options: z.object({
    name: z.string().optional().describe('Wallet name'),
  }),
  run() {
    return { created: true }
  },
})

cli.command(key)

// wallet subcommand group
const wallet = Cli.create('wallet', { description: 'Manage wallets' })

wallet.command('create', {
  description: 'Create a new wallet',
  options: z.object({
    name: z.string().optional().describe('Name for the wallet'),
    passkey: z.boolean().optional().describe('Create a passkey-based wallet via browser auth'),
  }),
  run() {
    return { created: true }
  },
})

wallet.command('import', {
  description: 'Import an existing private key as a local wallet',
  options: z.object({
    name: z.string().optional().describe('Name for the wallet'),
    stdinKey: z.boolean().optional().describe('Read the private key from stdin'),
  }),
  run() {
    return { imported: true }
  },
})

wallet.command('delete', {
  description: 'Delete a wallet',
  args: z.object({
    name: z.string().optional().describe('Wallet name to delete'),
  }),
  options: z.object({
    passkey: z.boolean().optional().describe('Delete the passkey wallet'),
    yes: z.boolean().optional().describe('Skip confirmation prompt'),
  }),
  run() {
    return { deleted: true }
  },
})

cli.command(wallet)

cli.serve()

export default cli
