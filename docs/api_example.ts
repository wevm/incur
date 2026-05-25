import { create } from 'incur'
import {
  ClientError,
  createClient,
  createHttpClient,
  createMemoryClient,
  httpTransport,
  memoryTransport,
} from 'incur/client'

import type { Commands } from './generated/incur-client.js'

/**
 * Client
 */
const client = createHttpClient<Commands>({
  baseUrl: 'https://ops.acme.test',
  // Optional, defaults to globalThis.fetch.
  fetch,

  // Defaults for every client.run(). Per-call options override these.
  // output* options affect result.output.text but not the (full) result.data.
  outputFormat: 'toon', // --format toon
})

// which is exactly the same as:
const _clientViaTransport = createClient<Commands>({
  transport: httpTransport({
    baseUrl: 'https://ops.acme.test',
  }),
  outputFormat: 'toon',
})

// Or create an in-process memory client.
const cli = create({ name: 'acme' }) // ...
// Memory clients run in-process, so explicit env injection is allowed here.
const memoryClient = createMemoryClient(cli, {
  env: { ACME_TOKEN: 'dev_secret_123' },
})

// identical to:
const _memoryClientViaTransport = createClient<Commands>({
  transport: memoryTransport(cli, {
    env: { ACME_TOKEN: 'dev_secret_123' },
  }),
})

/**
 * Running
 */
// `acme project report proj_web_2026 --include-closed=false --filter-output summary items[0:3] nextCursor --format md --token-count --token-limit 24 --full-output`
const report = await client.run('project report', {
  args: { projectId: 'proj_web_2026' },
  options: { includeClosed: false },

  // Applies first to structured data (report.data), so report.data is typed as unknown.
  selection: ['summary', 'items[0:3]', 'nextCursor'],

  // output* options apply only to report.output.
  // They format/count/page report.output.text; they never change report.data.
  outputFormat: 'md',
  outputTokenCount: true,
  outputTokenLimit: 24,
})

console.log(report)
/// ClientRunResult<unknown>
// {
//   ok: true,
//   data: {
//     summary: 'Website refresh is on track',
//     items: [
//       { id: 'task_1', title: 'Finalize copy', status: 'done' },
//       { id: 'task_2', title: 'QA checkout flow', status: 'blocked' },
//       { id: 'task_3', title: 'Publish launch checklist', status: 'open' }
//     ],
//     nextCursor: 'task_4'
//   },
//   output: {
//     text: '## Website refresh is on track\n\n- done: Finalize copy\n- blocked: QA checkout flow',
//     format: 'md',
//     tokenCount: 37,
//     tokenLimit: 24,
//     tokenOffset: 0,
//     next: [Function]
//   },
//   meta: {
//     command: 'project report',
//     duration: '18ms',
//     cta: { ... }
//   }
// }

console.log(typeof report.data) // unknown

if (report.output?.next) {
  const nextPage = await report.output.next()
  console.log(nextPage?.output?.text)
  // '- open: Publish launch checklist'
}

// `acme project status proj_web_2026 --full-output`
const status = await client.run('project status', {
  args: { projectId: 'proj_web_2026' },
})

console.log(status)
/// ClientRunResult<ProjectStatus>
// ...

/**
 * CTA
 */
const cta = report.meta.cta?.commands[0]
console.log(cta)
/// ClientCta<Commands>
// {
//   command: 'project unblock',
//   cliCommand: 'acme project unblock task_2',
//   description: 'Unblock the blocked checkout QA task.',
//   args: { taskId: 'task_2' },
//   options: {},
//   runnable: true,
//   run: [Function],
//   raw: {
//     command: 'project unblock',
//     args: { taskId: 'task_2' },
//     options: {},
//     description: 'Unblock the blocked checkout QA task.'
//   }
// }

if (cta?.runnable) {
  console.log(cta)
  /// ClientCta<Commands, 'project unblock'>
  // ...
  const unblock = await cta.run({
    // Equivalent to:
    // client.run('project unblock', {
    //   args: { taskId: 'task_2' },
    //   options: {},
    //   outputFormat: 'toon',
    // })
    //
    // CTA run() does not inherit output controls from the original report run.
    outputFormat: 'toon',
  })

  console.log(unblock)
  /// ClientRunResult<ProjectUnblock>
  // ...
}

/**
 * Errors
 */
try {
  // acme project deploy proj_web_2026 production --full-output
  await client.run('project deploy', {
    args: { projectId: 'proj_web_2026', environment: 'production' },
  })
} catch (error) {
  if (error instanceof ClientError) {
    console.log(error)
    /// ClientError
    // ClientError: Login required before deploying.
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
    //           cliCommand: 'acme auth login',
    //           description: 'Log in to Acme.',
    //           args: {},
    //           options: {},
    //           runnable: true,
    //           run: [Function],
    //           raw: { command: 'auth login', description: 'Log in to Acme.' }
    //         }
    //       ]
    //     }
    //   },
    //   error: {
    //     code: 'NOT_AUTHENTICATED',
    //     message: 'Login required before deploying.',
    //     retryable: false
    //   },
    //   data: {
    //     ok: false,
    //     error: {
    //       code: 'NOT_AUTHENTICATED',
    //       message: 'Login required before deploying.',
    //       retryable: false
    //     },
    //     meta: {
    //       command: 'project deploy',
    //       duration: '4ms',
    //       cta: { ... }
    //     }
    //   }
    // }

    // Needs to be typed explicitly
    const clientError = error as ClientError<Commands>
    console.log(clientError)
    /// ClientError<Commands>
    // ...
  }
}

/**
 * Streaming
 */
// `acme logs tail checkout-api --format toon`
const stream = await client.run('logs tail', {
  args: { service: 'checkout-api' },
})

for await (const chunk of stream) {
  console.log(chunk)
  /// Logline
  // { timestamp: '2026-05-24T10:15:00Z', level: 'info', message: 'request completed' }
}

console.log(await stream.final)
/// ClientStreamFinal<unknown, Commands>
// {
//   ok: true,
//   data: { lines: 124 },
//   meta: { command: 'logs tail', duration: '30s' }
// }

// A stream can only be consumed once: either for await (...) or records().
const rawStream = await client.run('logs tail', {
  args: { service: 'checkout-api' },
})

// records() yields every stream record, including error records.
// It does not throw when an error record arrives.
for await (const record of rawStream.records()) {
  console.log(record)
  /// ClientStreamRecord<LogLine, unknown, Commands>
  // ...
  if (record.type === 'chunk') {
    console.log(record.data)
    // ...
  }

  if (record.type === 'done') {
    console.log(record.data)
    /// string | undefined
    // { lines: 124 }
    console.log(record.meta)
    /// ClientMeta<Commands>
    // { command: 'logs tail', duration: '30s' }
  }

  if (record.type === 'error') {
    console.log(record.error)
    /// ClientRpcError
    // { code: 'LOG_STREAM_DISCONNECTED', message: 'Log stream disconnected.' }
  }
}

/**
 * DiscoveryActions
 *
 * These actions are read-only and available on both HttpClient and MemoryClient:
 * - client.llms(options?): Promise<LlmsManifest | string>
 *   Compact LLM manifest; structured by default, string with format.
 *
 * - client.llmsFull(options?): Promise<LlmsFullManifest | string>
 *   Full LLM manifest; structured by default, string with format.
 *
 * - client.schema(command?): Promise<CommandSchema>
 *   JSON Schema for root or command args/env/options/output.
 *
 * - client.help(command?): Promise<string>
 *   CLI help text for root or command.
 *
 * - client.openapi(): Promise<OpenApiDocument>
 *   Parsed OpenAPI JSON document.
 *
 * - client.skills.index(): Promise<SkillsIndex>
 *   Structured generated skills index.
 *
 * - client.skills.get(name): Promise<string>
 *   Generated SKILL.md markdown.
 *
 * - client.mcp.tools(): Promise<McpToolsResponse<Commands>>
 *   Structured MCP tool descriptors.
 *
 * LocalActions
 *
 * These actions are available only on MemoryClient. They are not exposed by
 * HttpClient, HTTP routes, RPC, or MCP tools:
 * - memoryClient.skills.add(options?): Promise<SyncedSkills>
 *   Sync generated skill files to local agent skill directories.
 *
 * - memoryClient.skills.list(options?): Promise<SkillsList>
 *   List generated skills with local install status.
 *
 * - memoryClient.mcp.add(options?): Promise<McpRegistration>
 *   Register this CLI as a local MCP server with supported agents.
 */
const llmsFull = await client.llmsFull({ command: 'project' })
console.log(llmsFull.commands[0])
/// LlmsFullManifest<Commands, 'project'>['commands'][number]
// {
//   name: 'project report',
//   description: 'Summarize project progress.',
//   schema: {
//     args: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } },
//     options: { type: 'object', properties: { includeClosed: { type: 'boolean' } } },
//     output: { type: 'object', properties: { summary: { type: 'string' } } }
//   }
// }

// Discovery methods are not command runs, so they use `format`.
// `format` changes the discovery response itself from typed data to text.
const llmsMd = await client.llms({ command: 'project', format: 'md' })
console.log(llmsMd)
/// string
// '# Project commands\n\n- `project report` - Summarize project progress.\n- `project status` - Show project status.'

const schema = await client.schema('project report')
console.log(schema.args)
// CommandSchema<Commands, 'project report'>['args']
// { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' } } }

const help = await client.help('project report')
console.log(help)
// string
// 'Usage: acme project report <projectId> [--include-closed]\n\nSummarize project progress.'

const openapi = await client.openapi()
console.log(openapi.info)
// OpenApiDocument['info']
// { title: 'Acme CLI API', version: '1.0.0' }

const skills = await client.skills.index()
console.log(skills.skills[0])
// SkillsIndex['skills'][number]
// { name: 'deploy', description: 'Deploy safely with preflight checks.', files: ['SKILL.md'] }

const deploySkill = await client.skills.get('deploy')
console.log(deploySkill)
// string
// '# Deploy\n\nRun preflight checks, inspect the deployment plan, then deploy.'

const localSkills = await memoryClient.skills.list()
console.log(localSkills.skills[0])
/// SkillsList['skills'][number]
// ...

const syncedSkills = await memoryClient.skills.add({
  depth: 1,
  global: true,
})
console.log(syncedSkills.skills[0])
/// SyncedSkills['skills'][number]
// { name: 'deploy', description: 'Deploy safely with preflight checks.' }

// You can't use local actions on a http client.
client.skills.add()
// Type error: LocalActions exist only on MemoryClient.

const mcpTools = await client.mcp.tools()
console.log(mcpTools.tools[0])
// McpToolsResponse<Commands>['tools'][number]
// {
//   name: 'project_report',
//   description: 'Summarize project progress.',
//   inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } },
//   outputSchema: { type: 'object', properties: { summary: { type: 'string' } } }
// }

const mcpRegistration = await memoryClient.mcp.add({
  agents: ['codex'],
})
console.log(mcpRegistration)
/// McpRegistration
// {command: 'pnpm acme --mcp', agents: ['Codex']}
