import { Cli, z } from 'clac'

const cli = Cli.create('gh', {
  version: '2.62.0',
  description: 'Work seamlessly with GitHub from the command line.',
})

const pr = Cli.create('pr', { description: 'Manage pull requests' })
  .command('list', {
    description: 'List pull requests in a repository',
    options: z.object({
      state: z.enum(['open', 'closed', 'merged', 'all']).default('open'),
      limit: z.number().default(30),
      label: z.array(z.string()).default([]),
      json: z.boolean().default(false),
    }),
    alias: { state: 's', limit: 'l', json: 'j' },
    output: z.object({
      items: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          state: z.string(),
          author: z.string(),
        }),
      ),
      totalCount: z.number(),
    }),
    readOnly: true,
    openWorld: true,
    run({ ok }) {
      const items: { number: number; title: string; state: string; author: string }[] = []
      return ok({ items, totalCount: 0 }, {
        cta: { commands: items.map((item) => ({ command: `pr view ${item.number}`, description: `View "${item.title}"` })) },
      })
    },
  })
  .command('view', {
    description: 'View a pull request',
    args: z.object({ number: z.number() }),
    options: z.object({ web: z.boolean().default(false) }),
    alias: { web: 'w' },
    output: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      state: z.string(),
      mergeable: z.boolean(),
    }),
    readOnly: true,
    openWorld: true,
    run({ args, ok }) {
      const result = {
        number: args.number,
        title: `PR #${args.number}`,
        body: '',
        state: 'open',
        mergeable: true,
      }
      return ok(result, result.mergeable ? {
        cta: { commands: [{ command: 'pr merge', description: 'Merge this PR' }] },
      } : undefined)
    },
  })
  .command('create', {
    description: 'Create a pull request',
    args: z.object({ title: z.string() }),
    options: z.object({
      body: z.string().default(''),
      draft: z.boolean().default(false),
      base: z.string().default('main'),
    }),
    alias: { body: 'b', draft: 'd' },
    output: z.object({ number: z.number(), url: z.string() }),
    openWorld: true,
    run({ ok }) {
      return ok({ number: 1, url: `https://github.com/org/repo/pull/1` }, {
        cta: { commands: [{ command: 'pr view', description: 'View the new PR' }] },
      })
    },
  })
  .command('merge', {
    description: 'Merge a pull request',
    args: z.object({ number: z.number() }),
    options: z.object({
      method: z.enum(['merge', 'squash', 'rebase']).default('merge'),
      deleteBranch: z.boolean().default(false),
    }),
    alias: { method: 'm', deleteBranch: 'd' },
    output: z.object({ merged: z.boolean() }),
    destructive: true,
    openWorld: true,
    run() {
      return { merged: true }
    },
  })

const issue = Cli.create('issue', { description: 'Manage issues' })
  .command('list', {
    description: 'List issues in a repository',
    options: z.object({
      state: z.enum(['open', 'closed', 'all']).default('open'),
      limit: z.number().default(30),
      label: z.array(z.string()).default([]),
    }),
    alias: { state: 's', limit: 'l' },
    output: z.object({
      items: z.array(z.object({ number: z.number(), title: z.string(), state: z.string() })),
    }),
    readOnly: true,
    openWorld: true,
    run({ ok }) {
      const items: { number: number; title: string; state: string }[] = []
      return ok({ items }, {
        cta: { commands: items.map((item) => ({ command: `issue view ${item.number}`, description: `View "${item.title}"` })) },
      })
    },
  })
  .command('create', {
    description: 'Create a new issue',
    args: z.object({ title: z.string() }),
    options: z.object({
      body: z.string().default(''),
      label: z.array(z.string()).default([]),
    }),
    alias: { body: 'b' },
    output: z.object({ number: z.number(), url: z.string() }),
    openWorld: true,
    run({ ok }) {
      return ok({ number: 1, url: `https://github.com/org/repo/issues/1` }, {
        cta: { commands: [{ command: 'issue view 1', description: 'View the new issue' }] },
      })
    },
  })
  .command('view', {
    description: 'View an issue',
    args: z.object({ number: z.number() }),
    output: z.object({
      number: z.number(),
      title: z.string(),
      body: z.string(),
      state: z.string(),
    }),
    readOnly: true,
    openWorld: true,
    run({ args }) {
      return { number: args.number, title: '', body: '', state: 'open' }
    },
  })

const auth = Cli.create('auth', { description: 'Authenticate with GitHub' })
  .command('status', {
    description: 'View authentication status',
    options: z.object({ hostname: z.string().default('github.com') }),
    alias: { hostname: 'h' },
    output: z.object({ loggedIn: z.boolean(), hostname: z.string() }),
    readOnly: true,
    run({ options, ok, error }) {
      if (!process.env.GH_TOKEN)
        return error({
          code: 'NOT_AUTHENTICATED',
          message: `Not logged in to ${options.hostname}`,
          cta: { description: 'Authenticate to continue:', commands: ['auth login'] },
        })
      return ok({ loggedIn: true, hostname: options.hostname })
    },
  })
  .command('login', {
    description: 'Authenticate with a GitHub host',
    options: z.object({
      hostname: z.string().default('github.com'),
      web: z.boolean().default(false),
      scopes: z.array(z.string()).default([]),
    }),
    alias: { hostname: 'h', web: 'w' },
    idempotent: true,
    openWorld: true,
    run({ options }) {
      return { hostname: options.hostname, scopes: options.scopes }
    },
  })

cli.command(pr)
cli.command(issue)
cli.command(auth)
cli.serve()

export default cli
