---
name: incur-typescript-client
description: Use when consuming an incur CLI from TypeScript with `incur/client`, including generated command types, `HttpClient`, `MemoryClient`, streaming, CTAs, resources, and client errors.
command: incur
---

# incur TypeScript Client

Use this skill when TypeScript code needs to call an incur CLI programmatically. Use the root `incur` skill when building the CLI itself. Use shell commands, generated Skills, or MCP when the caller is an agent or human operating outside TypeScript.

The public client API lives in `incur/client`:

```ts
import {
  Client,
  HttpClient,
  HttpTransport,
  Local,
  MemoryClient,
  MemoryTransport,
  Resources,
  Run,
} from 'incur/client'
```

## Setup

The client is typed from a command map. Generate it from the CLI entrypoint:

```ts
// src/cli.ts
import { Cli, z } from 'incur'

const cli = Cli.create('acme', {
  description: 'Acme operations CLI',
})
  .command('project status', {
    args: z.object({ projectId: z.string() }),
    output: z.object({ status: z.enum(['ok', 'blocked']) }),
    run() {
      return { status: 'ok' as const }
    },
  })
  .command('logs tail', {
    args: z.object({ service: z.string() }),
    output: z.object({ line: z.string() }),
    async *run() {
      yield { line: 'ready' }
    },
  })

cli.serve()

export default cli
```

Run type generation:

```sh
npx incur gen --entry ./src/cli.ts --output ./src/incur.generated.ts
```

The generated file exports `Commands` and augments both `incur` and `incur/client`:

```ts
import type { Commands } from './incur.generated.js'
```

Command IDs are full command paths such as `'project status'` or `'logs tail'`. Command map entries have this shape:

```ts
type Commands = {
  'project status': {
    args: { projectId: string }
    options: {}
    output: { status: 'ok' | 'blocked' }
  }
  'logs tail': {
    args: { service: string }
    options: {}
    output: { line: string }
    stream: true
  }
}
```

## Creating Clients

Use `HttpClient` for remote or served CLIs. The CLI must be exposed with `cli.fetch` in Bun, Deno, Cloudflare Workers, Hono, Next.js, or another Fetch-compatible runtime.

```ts
import { HttpClient } from 'incur/client'
import type { Commands } from './incur.generated.js'

const client = HttpClient.create<Commands>({
  baseUrl: 'https://ops.acme.test',
  // Optional; defaults to globalThis.fetch.
  fetch,
  // Optional; merged into every request.
  headers: { authorization: `Bearer ${token}` },
  // Defaults for every client.run(). Per-call input overrides these.
  outputFormat: 'toon',
})
```

Use `MemoryClient` for in-process calls, tests, local automation, and local setup actions:

```ts
import { MemoryClient } from 'incur/client'
import cli from './cli.js'

const memoryClient = MemoryClient.create(cli, {
  env: { ACME_TOKEN: 'dev_secret_123' },
  outputFormat: 'toon',
})
```

`MemoryClient.create(cli)` infers commands from a concrete CLI. You can still provide an explicit command map when needed:

```ts
const memoryClient = MemoryClient.create<Commands>(cli)
```

Use `Client.create()` and transports only when composing lower-level client infrastructure:

```ts
const httpViaTransport = Client.create<Commands>({
  transport: HttpTransport.create({
    baseUrl: 'https://ops.acme.test',
    headers: { authorization: `Bearer ${token}` },
  }),
  outputFormat: 'toon',
})

const memoryViaTransport = Client.create({
  transport: MemoryTransport.create(cli, {
    env: { ACME_TOKEN: 'dev_secret_123' },
  }),
})
```

## Running Commands

`client.run(command, input)` mirrors a CLI invocation. `args` are positional arguments, `options` are named flags, and output controls mirror global CLI flags.

```ts
const report = await client.run('project report', {
  args: { projectId: 'proj_web_2026' },
  options: { includeClosed: false },

  // Equivalent to --filter-output. This changes result.data, so data is typed unknown.
  selection: ['summary', 'items[0:3]', 'nextCursor'],

  // These affect rendered result.output.text, not the server's original full output.
  outputFormat: 'md',
  outputTokenCount: true,
  outputTokenLimit: 128,
})
```

The returned value for non-streaming commands is `Run.Result<data, Commands>`:

```ts
console.log(report)
/// Run.Result<unknown, Commands>
// {
//   ok: true,
//   data: {
//     summary: 'Website refresh is on track',
//     items: [
//       { id: 'task_1', title: 'Finalize copy', status: 'done' },
//       { id: 'task_2', title: 'QA checkout flow', status: 'blocked' },
//       { id: 'task_3', title: 'Publish launch checklist', status: 'open' },
//     ],
//     nextCursor: 'task_4',
//   },
//   output: {
//     text: '## Website refresh is on track\n\n- done: Finalize copy\n- blocked: QA checkout flow',
//     format: 'md',
//     tokenCount: 37,
//     tokenLimit: 128,
//     tokenOffset: 0,
//     next: [Function],
//   },
//   meta: {
//     command: 'project report',
//     duration: '18ms',
//     cta: {
//       commands: [
//         {
//           command: 'project unblock',
//           cliCommand: 'project unblock task_2',
//           description: 'Unblock the blocked checkout QA task.',
//           args: { taskId: 'task_2' },
//           options: {},
//           raw: { command: 'project unblock', args: { taskId: 'task_2' } },
//           run: [Function],
//         },
//       ],
//     },
//   },
// }
```

Because `selection` changes the shape of `data`, selected results are typed as `unknown`.

If `output.next` exists, fetch the next rendered output page for the same command:

```ts
const nextPage = await report.output?.next?.()

console.log(nextPage)
/// Run.Result<unknown, Commands> | undefined
// {
//   ok: true,
//   data: { ... },
//   output: {
//     text: '- open: Publish launch checklist',
//     format: 'md',
//     tokenCount: 37,
//     tokenLimit: 128,
//     tokenOffset: 128,
//   },
//   meta: { command: 'project report', duration: '12ms' },
// }
```

Input is strict. Required `args` and `options` make the input object required; unknown commands and extra keys are rejected by TypeScript when the command map is known.

```ts
await client.run('project status', {
  args: { projectId: 'proj_web_2026' },
})

// Type error: unknown command.
await client.run('project missing')

// Type error: missing required args.
await client.run('project status')
```

If the client has a default `selection`, result data is conservative `unknown`. Clear it for a call with `selection: undefined` to recover the full output type:

```ts
const selectedClient = HttpClient.create<Commands, { selection: string[] }>({
  baseUrl: 'https://ops.acme.test',
  selection: ['summary'],
})

const selected = await selectedClient.run('project report', {
  args: { projectId: 'proj_web_2026' },
})
// selected.data is unknown

const full = await selectedClient.run('project report', {
  args: { projectId: 'proj_web_2026' },
  selection: undefined,
})

console.log(full)
/// Run.Result<ProjectReport, Commands>
// {
//   ok: true,
//   data: {
//     summary: 'Website refresh is on track',
//     items: [
//       { id: 'task_1', title: 'Finalize copy', status: 'done' },
//       { id: 'task_2', title: 'QA checkout flow', status: 'blocked' },
//       { id: 'task_3', title: 'Publish launch checklist', status: 'open' },
//     ],
//     nextCursor: 'task_4',
//   },
//   output: {
//     text: 'summary: Website refresh is on track\nitems[3]{id,title,status}: ...',
//     format: 'toon',
//   },
//   meta: { command: 'project report', duration: '18ms' },
// }
```

## CTAs

Commands can return CTAs in `meta.cta`. Client CTAs are runnable:

```ts
const cta = report.meta.cta?.commands[0]

console.log(cta)
/// Run.Cta<Commands> | undefined
// {
//   command: 'project unblock',
//   cliCommand: 'project unblock task_2',
//   description: 'Unblock the blocked checkout QA task.',
//   args: { taskId: 'task_2' },
//   options: {},
//   raw: {
//     command: 'project unblock',
//     args: { taskId: 'task_2' },
//     options: {},
//     description: 'Unblock the blocked checkout QA task.',
//   },
//   run: [Function],
// }

if (cta) {
  const result = await cta.run({
    outputFormat: 'toon',
  })

  console.log(result)
  /// Run.Result<unknown, Commands>
  // {
  //   ok: true,
  //   data: { unblocked: true, taskId: 'task_2' },
  //   output: {
  //     text: 'unblocked: true\ntaskId: task_2',
  //     format: 'toon',
  //   },
  //   meta: { command: 'project unblock', duration: '14ms' },
  // }
}
```

CTA `run()` does not inherit output controls from the original command result. Pass the controls you want for the CTA run.

CTA objects have `command`, `cliCommand`, optional `description`, `args`, `options`, `raw`, and `run()`. Do not check for a `runnable` property.

## Errors

Failed command runs and malformed client responses throw `Client.ClientError`:

```ts
import { Client } from 'incur/client'

try {
  await client.run('project deploy', {
    args: { projectId: 'proj_web_2026' },
    options: { environment: 'production' },
  })
} catch (error) {
  if (error instanceof Client.ClientError) {
    console.log(error)
    /// Client.ClientError
    // Incur.ClientError: Login required before deploying.
    // {
    //   message: 'Login required before deploying.',
    //   code: 'NOT_AUTHENTICATED',
    //   status: 401,
    //   retryable: false,
    //   fieldErrors: undefined,
    //   meta: {
    //     command: 'project deploy',
    //     duration: '4ms',
    //     cta: {
    //       description: 'Authenticate before deploying.',
    //       commands: [
    //         {
    //           command: 'auth login',
    //           cliCommand: 'auth login',
    //           description: 'Log in to Acme.',
    //           args: {},
    //           options: {},
    //           raw: { command: 'auth login', description: 'Log in to Acme.' },
    //           run: [Function],
    //         },
    //       ],
    //     },
    //   },
    //   error: {
    //     code: 'NOT_AUTHENTICATED',
    //     message: 'Login required before deploying.',
    //     retryable: false,
    //   },
    //   data: {
    //     ok: false,
    //     error: {
    //       code: 'NOT_AUTHENTICATED',
    //       message: 'Login required before deploying.',
    //       retryable: false,
    //     },
    //     meta: {
    //       command: 'project deploy',
    //       duration: '4ms',
    //       cta: { ... },
    //     },
    //   },
    // }
  }
}
```

## Streaming

Commands implemented with `async *run` return `Run.StreamResponse<chunk, finalData, Commands>`.

```ts
const stream = await client.run('logs tail', {
  args: { service: 'checkout-api' },
})

for await (const chunk of stream) {
  console.log(chunk)
  /// LogLine
  // {
  //   timestamp: '2026-05-24T10:15:00Z',
  //   level: 'info',
  //   message: 'request completed',
  // }
}

const final = await stream.final

console.log(final)
/// Run.StreamFinal<unknown, Commands>
// {
//   ok: true,
//   data: { lines: 124 },
//   output: {
//     text: 'lines: 124',
//     format: 'toon',
//   },
//   meta: {
//     command: 'logs tail',
//     duration: '30s',
//   },
// }
```

Use `records()` when you need every stream record, including terminal error records:

```ts
const rawStream = await client.run('logs tail', {
  args: { service: 'checkout-api' },
})

for await (const record of rawStream.records()) {
  if (record.type === 'chunk') {
    console.log(record)
    /// Extract<Run.StreamRecord<LogLine, unknown, Commands>, { type: 'chunk' }>
    // {
    //   type: 'chunk',
    //   data: {
    //     timestamp: '2026-05-24T10:15:00Z',
    //     level: 'info',
    //     message: 'request completed',
    //   },
    //   output: {
    //     text: 'timestamp: 2026-05-24T10:15:00Z\nlevel: info\nmessage: request completed',
    //     format: 'toon',
    //   },
    // }
  }

  if (record.type === 'done') {
    console.log(record)
    /// Extract<Run.StreamRecord<LogLine, unknown, Commands>, { type: 'done' }>
    // {
    //   type: 'done',
    //   ok: true,
    //   data: { lines: 124 },
    //   output: { text: 'lines: 124', format: 'toon' },
    //   meta: { command: 'logs tail', duration: '30s' },
    // }
  }

  if (record.type === 'error') {
    console.log(record)
    /// Extract<Run.StreamRecord<LogLine, unknown, Commands>, { type: 'error' }>
    // {
    //   type: 'error',
    //   ok: false,
    //   error: {
    //     code: 'LOG_STREAM_DISCONNECTED',
    //     message: 'Log stream disconnected.',
    //     retryable: true,
    //   },
    //   meta: { command: 'logs tail', duration: '30s' },
    // }
  }
}
```

A stream can only be consumed once: use async iteration, `.records()`, or `.final` as the consumption mode. Streaming commands allow `selection` and `outputFormat`, but reject token pagination controls such as `outputTokenLimit`.

## Discovery Resources

Resource actions are read-only and available on both HTTP and memory clients:

```ts
const llms = await client.llms()
const llmsMd = await client.llms({ command: 'project', format: 'md' })
const full = await client.llmsFull()
const schema = await client.schema('project report')
const help = await client.help('project report')
const openapi = await client.openapi()
const skills = await client.skills.index()
const deploySkill = await client.skills.get('deploy')
const tools = await client.mcp.tools()

console.log(llms)
/// Resources.LlmsManifest<Commands>
// {
//   version: 'incur.v1',
//   commands: [
//     {
//       name: 'project report',
//       description: 'Summarize project progress.',
//     },
//     {
//       name: 'project status',
//       description: 'Show project status.',
//     },
//   ],
// }

console.log(llmsMd)
/// string
// '# acme project\n\n| Command | Description |\n|---------|-------------|\n| `acme project report <projectId>` | Summarize project progress. |'

console.log(full)
/// Resources.LlmsFullManifest<Commands>
// {
//   version: 'incur.v1',
//   commands: [
//     {
//       name: 'project report',
//       description: 'Summarize project progress.',
//       schema: {
//         args: {
//           type: 'object',
//           required: ['projectId'],
//           properties: { projectId: { type: 'string' } },
//         },
//         options: {
//           type: 'object',
//           properties: { includeClosed: { type: 'boolean' } },
//         },
//         output: {
//           type: 'object',
//           properties: { summary: { type: 'string' } },
//         },
//       },
//     },
//   ],
// }

console.log(schema)
/// Resources.CommandSchema<Commands>
// {
//   args: {
//     type: 'object',
//     required: ['projectId'],
//     properties: { projectId: { type: 'string' } },
//   },
//   options: {
//     type: 'object',
//     properties: { includeClosed: { type: 'boolean' } },
//   },
//   output: {
//     type: 'object',
//     properties: { summary: { type: 'string' } },
//   },
// }

console.log(help)
/// string
// 'Usage: acme project report <projectId> [--include-closed]\n\nSummarize project progress.'

console.log(openapi)
/// Resources.OpenApiDocument
// {
//   openapi: '3.1.0',
//   info: { title: 'acme', version: '1.0.0' },
//   paths: { ... },
// }

console.log(skills)
/// Resources.SkillsIndex
// {
//   skills: [
//     {
//       name: 'acme-project',
//       description: 'Project commands. Run `acme project --help` for usage details.',
//       files: ['SKILL.md'],
//     },
//   ],
// }

console.log(deploySkill)
/// string
// '---\nname: acme-deploy\ndescription: Deploy safely. Run `acme deploy --help` for usage details.\n---\n\n# acme deploy\n\nDeploy safely.'

console.log(tools)
/// Resources.McpToolsResponse<Commands>
// {
//   tools: [
//     {
//       name: 'project_report',
//       description: 'Summarize project progress.',
//       inputSchema: {
//         type: 'object',
//         properties: {
//           projectId: { type: 'string' },
//           includeClosed: { type: 'boolean' },
//         },
//         required: ['projectId'],
//       },
//       outputSchema: {
//         type: 'object',
//         properties: { summary: { type: 'string' } },
//       },
//     },
//   ],
// }
```

`llms()` and `llmsFull()` return structured data by default. Passing a non-JSON `format` returns a string.

Use command-group scopes where accepted:

```ts
await client.llmsFull({ command: 'project' })
await client.schema('project')
await client.help('project report')
```

Use discovery resources for docs, SDK tooling, UI generation, tests, and agent setup. Use `client.run()` for command execution.

## Memory-Only Local Actions

Memory clients expose local setup actions that HTTP clients do not expose:

```ts
const localSkills = await memoryClient.skills.list()

const syncedSkills = await memoryClient.skills.add({
  depth: 1,
  global: true,
})

const mcpRegistration = await memoryClient.mcp.add({
  agents: ['codex'],
})

console.log(localSkills)
/// Local.SkillsList
// {
//   skills: [
//     {
//       name: 'acme-project',
//       description: 'Project commands. Run `acme project --help` for usage details.',
//       installed: false,
//     },
//   ],
// }

console.log(syncedSkills)
/// Local.SyncedSkills
// {
//   skills: [
//     {
//       name: 'acme-project',
//       description: 'Project commands. Run `acme project --help` for usage details.',
//     },
//   ],
//   paths: ['/Users/alice/.config/agents/skills/acme-project'],
//   agents: [
//     {
//       agent: 'Codex',
//       path: '/Users/alice/.codex/skills/acme-project',
//     },
//   ],
// }

console.log(mcpRegistration)
/// Local.McpRegistration
// {
//   command: 'acme --mcp',
//   agents: [
//     {
//       agent: 'Codex',
//       path: '/Users/alice/.codex/config.toml',
//     },
//   ],
// }
```

These actions modify local agent configuration or local skill files. They are intentionally unavailable over HTTP, RPC, and MCP.

```ts
// Type error: HTTP clients do not expose local actions.
client.skills.add()
```

## Lower-Level Notes

Most code should use `HttpClient.create`, `MemoryClient.create`, and `client.run`. Reach for `Client.create` and transport factories when building reusable infrastructure around transports.

HTTP clients call `/_incur/rpc` for command execution and `/_incur/*` discovery endpoints for resources. Memory clients call the CLI in-process.

Fetch gateway commands mounted with `.command('api', { fetch })` are not part of the structured generated command map and cannot be called through typed structured RPC as ordinary commands. Call the served Fetch API routes directly for gateway routes.
