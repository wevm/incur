# TypeScript Client Spec

This document specifies the target TypeScript client architecture for incur. It is written as a final-state contract: every section describes the API, runtime, protocol, and type behavior that exists after implementation.

The design follows the same core model as viem:

- transports own the execution mechanics;
- clients hold a transport and defaults;
- actions are typed wrappers over client transport capabilities;
- convenience clients are thin compositions over `createClient`;
- transport capabilities determine which actions are present.

## Overview

The TypeScript client has three layers:

1. **Transports** perform work.
   - `HttpTransport` serializes requests to incur HTTP routes.
   - `MemoryTransport` executes against an in-process CLI instance.

2. **Clients** hold a transport and client defaults.
   - `createClient({ transport, ...defaults })` is the primitive.
   - `createHttpClient(options)` wraps `createClient({ transport: httpTransport(...) })`.
   - `createMemoryClient(cli, options)` wraps `createClient({ transport: memoryTransport(...) })`.

3. **Actions** expose the typed API.
   - `RunActions` execute CLI commands.
   - `DiscoveryActions` expose read-only discovery.
   - `LocalActions` expose local setup/admin commands, and exist only on memory clients.

Minimal example:

```ts
const http = createHttpClient<Commands>({
  baseUrl: 'https://ops.acme.test',
})

const memory = createMemoryClient<Commands>(cli, {
  env: { ACME_TOKEN: 'dev_secret_123' },
})
```

Equivalent primitive form:

```ts
const http = createClient<Commands>({
  transport: httpTransport({ baseUrl: 'https://ops.acme.test' }),
})

const memory = createClient<Commands>({
  transport: memoryTransport(cli, {
    env: { ACME_TOKEN: 'dev_secret_123' },
  }),
})
```

## Package Surface

Client APIs are exported from `incur/client`.

```ts
import {
  ClientError,
  createClient,
  createHttpClient,
  createMemoryClient,
  httpTransport,
  memoryTransport,
} from 'incur/client'

import type {
  Client,
  ClientRpcEnvelope,
  ClientRpcError,
  ClientRpcMeta,
  HttpClient,
  HttpTransport,
  MemoryClient,
  MemoryTransport,
} from 'incur/client'
```

The root `incur` export remains available for low-level framework APIs. The client subpath keeps runtime/client concepts separate from CLI construction.

The client creation APIs are exported only from `incur/client`. The root `incur` module must not export `createClient`, `createHttpClient`, `createMemoryClient`, `httpTransport`, or `memoryTransport`.

Generated command types are importable as normal TypeScript types from the generated file:

```ts
import type { Commands } from './generated/incur-client.js'
```

The generated file also augments client typing so projects can omit the explicit generic when they want global generated commands. See [Generated Command Maps](#generated-command-maps).

## Rejected Shapes

These shapes are not part of the TypeScript client contract:

- no curried command client such as `client('project report')(input)`;
- no HTTP-only `createClient({ baseUrl })`;
- no client creation APIs exported from root `incur`;
- no data-only command result API;
- no bare async iterable stream return without `final` and `records()`;
- no chunk-only stream terminal behavior;
- no stream terminal records without full metadata;
- no RPC alias command identity;
- no local setup/admin actions over HTTP, RPC, or MCP.

## Client Model

`createClient` creates a typed client by resolving a transport and attaching action sets.

```ts
type Client<
  commands = Commands,
  transport extends Transport = Transport,
  defaults extends ClientDefaults = {},
> = ClientBase<transport, defaults> &
  RunActions<commands, transport, defaults> &
  DiscoveryActions<commands, transport> &
  ([transport] extends [MemoryTransport] ? LocalActions : {})
```

Use a non-distributive conditional for `LocalActions`. A client whose transport type is the broad union `Transport` must not expose local actions just because one union member is `MemoryTransport`.

```ts
type HttpClient<commands = Commands, defaults extends ClientDefaults = {}> = Client<
  commands,
  HttpTransport,
  defaults
>

type MemoryClient<commands = Commands, defaults extends ClientDefaults = {}> = Client<
  commands,
  MemoryTransport,
  defaults
>
```

Client base:

```ts
type ClientBase<transport extends Transport, defaults extends ClientDefaults> = {
  defaults: defaults
  transport: ResolvedTransport<transport>
  type: 'client'
  uid: string
}
```

`defaults` are used by actions. They are not sent to transports as opaque state; actions merge defaults into typed request objects before calling transport methods.

Client defaults:

```ts
type ClientDefaults = {
  outputFormat?: Formatter.Format | undefined
  selection?: string[] | undefined
  outputTokenCount?: boolean | undefined
  outputTokenLimit?: number | undefined
  outputTokenOffset?: number | undefined
}
```

Factory types:

```ts
type CreateClientOptions<
  transport extends Transport,
  defaults extends ClientDefaults,
> = defaults & {
  transport: transport
}

declare function createClient<
  const commands = Commands,
  const transport extends Transport = Transport,
  const defaults extends ClientDefaults = {},
>(options: CreateClientOptions<transport, defaults>): Client<commands, transport, defaults>

declare function createHttpClient<
  const commands = Commands,
  const defaults extends ClientDefaults = {},
>(options: HttpTransportOptions & defaults): HttpClient<commands, defaults>

declare function createMemoryClient<
  const commands extends Cli.CommandsMap,
  const defaults extends ClientDefaults = {},
>(
  cli: Cli.Cli<commands, any, any, any>,
  options?: (MemoryTransportOptions & defaults) | undefined,
): MemoryClient<commands, defaults>

declare function createMemoryClient<
  const commands = Commands,
  const defaults extends ClientDefaults = {},
>(
  cli: Cli.Any,
  options?: (MemoryTransportOptions & defaults) | undefined,
): MemoryClient<commands, defaults>
```

`createMemoryClient(cli)` infers the command map from `cli` when the CLI value carries a concrete `Cli.Cli<commands, ...>` type. Passing an explicit generic overrides inference:

```ts
const inferred = createMemoryClient(cli)
const explicit = createMemoryClient<Commands>(cli)
```

Explicit generics are useful when the CLI value is widened, when a generated command map is preferred, or when a permissive command map is intentionally used.

Permissive clients are supported through an explicit unknown command map:

```ts
type UnknownCommands = Record<
  string,
  {
    args: unknown
    options: unknown
    output: unknown
  }
>

const client = createHttpClient<UnknownCommands>({ baseUrl })

await client.run('runtime-only command', {
  args: { any: 'value' },
  options: { shape: ['accepted'] },
})
```

This is an escape hatch. It disables command-name and input-shape inference for the chosen client instance only.

Convenience factories are thin wrappers:

```ts
function createHttpClient<const commands = Commands, const defaults extends ClientDefaults = {}>(
  options: HttpTransportOptions & defaults,
) {
  const { baseUrl, fetch, headers, ...defaults } = options
  return createClient<commands, HttpTransport, defaults>({
    ...defaults,
    transport: httpTransport({ baseUrl, fetch, headers }),
  })
}

function createMemoryClient<const commands = Commands, const defaults extends ClientDefaults = {}>(
  cli: Cli.Any,
  options: MemoryTransportOptions & defaults = {} as MemoryTransportOptions & defaults,
) {
  const { env, ...defaults } = options
  return createClient<commands, MemoryTransport, defaults>({
    ...defaults,
    transport: memoryTransport(cli, { env }),
  })
}
```

## Transport Model

Transports are factories. `createClient` invokes the transport factory and stores the resolved transport on the client.

This mirrors viem's pattern: transport constructors such as `httpTransport(...)` return a transport factory, and `createClient` resolves that factory with client runtime context.

```ts
type Transport = HttpTransport | MemoryTransport

type TransportType = 'http' | 'memory'

type TransportContext = {
  uid: string
}

type TransportConfig<type extends TransportType> = {
  key: string
  name: string
  type: type
}

type TransportCapabilities = Record<string, unknown>

type TransportFactory<
  type extends TransportType,
  capabilities extends TransportCapabilities,
> = (context: TransportContext) => { config: TransportConfig<type> } & capabilities
```

Resolved transport:

```ts
type ResolvedTransport<transport extends Transport> = ReturnType<transport>['config'] &
  Omit<ReturnType<transport>, 'config'>
```

HTTP transport:

```ts
type HttpTransport = TransportFactory<
  'http',
  {
    baseUrl: URL
    request(request: RpcRequest): Promise<RpcResponse | RpcStreamResponse>
    discover(request: DiscoveryRequest): Promise<DiscoveryResponse>
  }
>

type HttpTransportOptions = {
  baseUrl: string | URL
  fetch?: typeof globalThis.fetch | undefined
  headers?: HeadersInit | undefined
}

declare function httpTransport(options: HttpTransportOptions): HttpTransport
```

`httpTransport` uses `options.fetch ?? globalThis.fetch`. If no fetch implementation exists, transport creation throws `ClientError`. Fetch and network rejections are wrapped in `ClientError` with message `RPC request failed` and the original error as `cause`.

Memory transport:

```ts
type MemoryTransport = TransportFactory<
  'memory',
  {
    request(request: RpcRequest): Promise<RpcResponse | RpcStreamResponse>
    discover(request: DiscoveryRequest): Promise<DiscoveryResponse>
    local: LocalActionTransportApi
  }
>

type MemoryTransportOptions = {
  env?: Record<string, string | undefined> | undefined
}

declare function memoryTransport(
  cli: Cli.Any,
  options?: MemoryTransportOptions | undefined,
): MemoryTransport
```

Local transport capability:

```ts
type LocalActionTransportApi = {
  skills: {
    add(options?: SkillsAddOptions | undefined): Promise<SyncedSkills>
    list(options?: SkillsListOptions | undefined): Promise<SkillsList>
  }
  mcp: {
    add(options?: McpAddOptions | undefined): Promise<McpRegistration>
  }
}
```

Transport responsibilities:

- `HttpTransport.request()` calls `POST /_incur/rpc`.
- `MemoryTransport.request()` calls the shared in-process command execution runtime.
- `HttpTransport.discover()` calls HTTP discovery routes.
- `MemoryTransport.discover()` calls shared in-process discovery builders.
- `MemoryTransport.local` calls shared local setup/admin builders.

HTTP transport serialization rules:

- `baseUrl` is normalized so `https://api.example.com`, `https://api.example.com/`, and `https://api.example.com/v1` produce `/_incur/rpc` under that base path.
- omitted `args` serialize as `{}`.
- omitted `options` serialize as `{}`.
- command requests use `POST`.
- request headers include `content-type: application/json`.
- request headers include `accept: application/json, application/x-ndjson`.
- custom `headers` are merged into discovery and RPC requests without removing required protocol headers unless a custom header intentionally overrides the same key.

HTTP transport stream parsing rules:

- match the response media type by essence; `application/x-ndjson; charset=utf-8` is NDJSON.
- parse records separated by `\n`.
- accept records split across network chunks.
- ignore blank lines.
- accept a final record without a trailing newline.
- throw `ClientError` for invalid JSON records.
- throw `ClientError` for malformed records.
- throw `ClientError` when a streaming response has no body.
- throw `ClientError` when the stream ends before a terminal `done` or `error` record.
- cancel the underlying reader when the consumer stops early.

Memory transport execution rules:

- memory request execution never calls `cli.fetch()`.
- memory request execution uses the same shared command runtime as HTTP RPC.
- memory request execution accepts explicit `env` from `MemoryTransportOptions`.
- memory request execution does not apply CLI config-file defaults.
- memory streams call `return()` on the command generator when the consumer stops early.

Actions do not duplicate transport work. Actions build typed request objects, call transport capabilities, and normalize results for the public client API.

## Action Model

Actions are transport consumers. They are implemented as standalone functions that accept a client, then exposed as methods on client instances.

```ts
async function run(client, command, input) {
  const request = toRpcRequest(command, input, client.defaults)
  const response = await client.transport.request(request)
  return normalizeRunResponse(client, request, response)
}
```

The public method form is a bound action:

```ts
await client.run('project report', {
  args: { projectId: 'proj_web_2026' },
})
```

Action composition:

```ts
type RunActions<commands, transport extends Transport, defaults extends ClientDefaults> = {
  run<
    const command extends CommandId<commands>,
    const input extends RunInput<commands, command> | undefined = undefined,
  >(
    command: command,
    ...input: RunInputParameters<commands, command, input>
  ): Promise<RunReturn<commands, command, input, defaults>>
}

type DiscoveryActions<commands, transport extends Transport> = {
  llms: LlmsAction<commands>
  llmsFull: LlmsFullAction<commands>
  schema: SchemaAction<commands>
  help: HelpAction<commands>
  openapi(): Promise<OpenApiDocument>
  skills: {
    index(): Promise<SkillsIndex>
    get(name: string): Promise<string>
  }
  mcp: {
    tools(): Promise<McpToolsResponse<commands>>
  }
}

type LocalActions = {
  skills: {
    add(options?: SkillsAddOptions | undefined): Promise<SyncedSkills>
    list(options?: SkillsListOptions | undefined): Promise<SkillsList>
  }
  mcp: {
    add(options?: McpAddOptions | undefined): Promise<McpRegistration>
  }
}
```

Memory clients merge `LocalActions` into the same `skills` and `mcp` namespaces used by discovery:

```ts
const memory = createMemoryClient<Commands>(cli)

await memory.skills.index()
await memory.skills.get('deploy')
await memory.skills.list()
await memory.skills.add()

await memory.mcp.tools()
await memory.mcp.add()
```

HTTP clients do not expose local actions:

```ts
const http = createHttpClient<Commands>({ baseUrl })

await http.skills.index()
await http.mcp.tools()

await http.skills.add()
//                ^ type error
```

## Run Actions

`client.run(command, input)` executes a leaf command by canonical command ID.

Canonical command IDs are CLI token paths joined by single spaces:

```ts
await client.run('project report', {
  args: { projectId: 'proj_web_2026' },
  options: { includeClosed: false },
})
```

Aliases are accepted by CLI argv parsing but are not generated command IDs. Typed clients use canonical command IDs only.

Aliases are CLI-only for typed client purposes. `client.run()` is typed against canonical command IDs, generated command maps omit aliases, and RPC requests produced by typed clients always send canonical IDs. A raw RPC request that sends an alias is not part of the typed client contract and must not be required for client correctness.

Root command IDs:

- a root CLI created with `Cli.create('status', { run })` has command ID `'status'`;
- a root CLI mounted on a parent keeps its own command ID, such as `'status'`, not `'app status'`;
- a router CLI mounted as a command group prefixes its leaf command IDs, such as `'project list'`;
- nested command groups flatten with single spaces, such as `'project deploy create'`.

Run input:

```ts
type CommandArgs<commands, command extends CommandId<commands>> = commands[command] extends {
  args: infer args
}
  ? args
  : unknown

type CommandOptions<commands, command extends CommandId<commands>> = commands[command] extends {
  options: infer options
}
  ? options
  : unknown

type CommandData<commands, command extends CommandId<commands>> = commands[command] extends {
  output: infer output
}
  ? output
  : unknown

type RunInput<commands, command extends CommandId<commands>> = Field<
  'args',
  CommandArgs<commands, command>
> &
  Field<'options', CommandOptions<commands, command>> &
  OutputOptions
```

Required args/options determine whether the input argument itself is required.

```ts
type RunInputParameters<
  commands,
  command extends CommandId<commands>,
  input extends RunInput<commands, command> | undefined,
> =
  RequiredKeys<RunInput<commands, command>> extends never
    ? [input?: input | undefined]
    : [input: input & RunInput<commands, command>]
```

Run return:

```ts
type RunReturn<
  commands,
  command extends CommandId<commands>,
  input extends RunInput<commands, command> | undefined,
  defaults extends ClientDefaults,
> = commands[command] extends { stream: true }
  ? ClientStreamResponse<
      EffectiveRunOutput<CommandData<commands, command>, input, defaults>,
      unknown,
      commands
    >
  : ClientRunResult<EffectiveRunOutput<CommandData<commands, command>, input, defaults>, commands>
```

Non-streaming commands return a full success result. Command failures throw `ClientError`.

```ts
type ClientRunResult<data, commands = Commands> = {
  ok: true
  data: data
  output?: ClientOutput<data, commands> | undefined
  meta: ClientMeta<commands>
}
```

There is no public data-only run API. Consumers use the field they need:

```ts
const result = await client.run('status')

result.data
result.output?.text
result.meta
```

## Output Controls

Output controls are set as client defaults or per-run options.

```ts
const client = createHttpClient<Commands>({
  baseUrl,
  outputFormat: 'toon',
  selection: ['items[0:10]'],
  outputTokenLimit: 1_000,
})

await client.run('project report', {
  args: { projectId: 'proj_web_2026' },
  outputFormat: 'md',
  outputTokenLimit: 24,
})
```

Options:

```ts
type OutputOptions = {
  outputFormat?: Formatter.Format | undefined
  selection?: string[] | undefined
  outputTokenCount?: boolean | undefined
  outputTokenLimit?: number | undefined
  outputTokenOffset?: number | undefined
}
```

Rules:

- `selection` applies to structured `data`.
- `outputFormat`, `outputTokenCount`, `outputTokenLimit`, and `outputTokenOffset` apply to `output`.
- Output controls never mutate `data`.
- Any effective `selection` changes returned `data` to `unknown`.
- Literal `selection: undefined` clears a client-level selection.
- Omitting `selection` preserves a client-level selection.
- A `string[] | undefined` variable is conservatively treated as selected data.
- Token controls imply formatted output. If no `outputFormat` is effective, use `toon`.
- `output.next()` reruns the same command with the next `outputTokenOffset`.

Type behavior:

```ts
type EffectiveRunOutput<output, input, defaults> = EffectiveOutput<
  output,
  input extends { selection: infer selection }
    ? selection
    : defaults extends { selection: infer selection }
      ? selection
      : undefined
>

type EffectiveOutput<output, selection> = [selection] extends [undefined] ? output : unknown
```

Client output:

```ts
type ClientOutput<data, commands = Commands> = {
  text: string
  format?: Formatter.Format | undefined
  tokenCount?: number | undefined
  tokenLimit?: number | undefined
  tokenOffset?: number | undefined
  next?: (() => Promise<ClientRunResult<data, commands>>) | undefined
}
```

Streaming commands accept `selection` and `outputFormat`. They reject `outputTokenCount`, `outputTokenLimit`, and `outputTokenOffset` because stream pagination requires an aggregate buffering design that this API does not define.

## CTA Model

CTAs are normalized under `meta.cta`.

```ts
type ClientMeta<commands = Commands> = {
  command: string
  duration: string
  cta?: ClientCtaBlock<commands> | undefined
}

type ClientCtaBlock<commands = Commands> = {
  description?: string | undefined
  commands: ClientCta<commands>[]
}
```

CTA commands preserve raw data and expose CLI-ready text:

```ts
type ClientCta<commands = Commands> =
  | ClientRunnableCta<commands, CommandId<commands>>
  | ClientUnresolvedCta

type ClientRunnableCta<commands, command extends CommandId<commands>> = {
  command: command
  cliCommand: string
  description?: string | undefined
  args?: CommandArgs<commands, command> | undefined
  options?: CommandOptions<commands, command> | undefined
  raw: unknown
  runnable: true
  run<const options extends ClientCtaRunOptions | undefined = undefined>(
    options?: options,
  ): Promise<CtaRunReturn<commands, command, options>>
}

type ClientUnresolvedCta = {
  cliCommand?: string | undefined
  description?: string | undefined
  raw: unknown
  runnable: false
  unresolvedReason: 'unknown-command' | 'invalid-input' | 'unstructured'
}
```

`cta.run()` is equivalent to:

```ts
client.run(cta.command, {
  args: cta.args,
  options: cta.options,
  ...ctaRunOptions,
})
```

CTA `run()` inherits client defaults. It does not inherit output controls from the command that produced the CTA.

CTA formatting rules:

- `cliCommand` is CLI-ready text.
- `cliCommand` includes the CLI/root command prefix exactly once.
- string CTAs are interpreted relative to the current CLI name when needed.
- structured CTA `args` render as positional values.
- structured CTA `args` with value `true` render as placeholders, such as `<projectId>`.
- structured CTA `options` render as `--key value` flags.
- structured CTA `options` with value `true` render as placeholders, such as `--project-id <projectId>`.
- `raw` preserves the original CTA value without normalization.

## Streaming

Streaming commands return a stream object, not a bare async iterable.

```ts
const stream = await client.run('logs tail', {
  args: { service: 'checkout-api' },
})

for await (const chunk of stream) {
  console.log(chunk)
}

const final = await stream.final
```

Shape:

```ts
type ClientStreamResponse<
  chunk,
  finalData = unknown,
  commands = Commands,
> = AsyncIterable<chunk> & {
  final: Promise<ClientStreamFinal<finalData, commands>>
  records: () => AsyncIterable<ClientStreamRecord<chunk, finalData, commands>>
}

type ClientStreamFinal<finalData = unknown, commands = Commands> = {
  ok: true
  data?: finalData | undefined
  meta: ClientMeta<commands>
}

type ClientStreamRecord<chunk, finalData = unknown, commands = Commands> =
  | { type: 'chunk'; data: chunk; output?: ClientStreamOutput | undefined }
  | { type: 'done'; ok: true; data?: finalData | undefined; meta: ClientMeta<commands> }
  | { type: 'error'; ok: false; error: ClientRpcError; meta: ClientMeta<commands> }
```

Rules:

- A stream is single-consumer.
- Default async iteration yields `chunk.data`.
- Default async iteration throws `ClientError` when the terminal record is `error`.
- `records()` yields normalized records and does not throw for command error records.
- `final` resolves for terminal `done`.
- `final` rejects with `ClientError` for terminal `error`.
- Every stream has exactly one terminal `done` or `error` record.

## Discovery Actions

Discovery actions are read-only and available on both HTTP and memory clients.

```ts
await client.llms()
await client.llmsFull()
await client.schema('project report')
await client.help('project report')
await client.openapi()
await client.skills.index()
await client.skills.get('deploy')
await client.mcp.tools()
```

Format behavior:

- Omitted `format` returns structured data.
- Literal `format` returns formatted text.
- `format: 'json'` returns JSON text.
- Omit `format` to receive parsed structured data.

Discovery formats:

```ts
type DiscoveryFormat = 'md' | 'json' | 'yaml' | 'toon'

type DiscoveryResult<structured, format> = [format] extends [undefined]
  ? structured
  : undefined extends format
    ? structured | string
    : string
```

Command scopes:

```ts
type CommandId<commands> = keyof commands & string

type CommandPrefix<command extends string> = command extends `${infer head} ${infer tail}`
  ? head | `${head} ${CommandPrefix<tail>}`
  : never

type CommandScope<commands> = CommandId<commands> | CommandPrefix<CommandId<commands>>
```

Discovery request kinds:

```ts
type DiscoveryRequest =
  | { kind: 'llms'; command?: string | undefined; format?: DiscoveryFormat | undefined }
  | { kind: 'llmsFull'; command?: string | undefined; format?: DiscoveryFormat | undefined }
  | { kind: 'schema'; command?: string | undefined }
  | { kind: 'help'; command?: string | undefined }
  | { kind: 'openapi' }
  | { kind: 'skillsIndex' }
  | { kind: 'skill'; name: string }
  | { kind: 'mcpTools' }
```

`client.skills.index()` and `client.skills.get(name)` are generated-skill discovery APIs. They do not report local install status and do not install skills.

`client.mcp.tools()` returns the MCP tool descriptors the CLI exposes through MCP `tools/list`. It does not register MCP servers.

## OpenAPI Discovery Documents

`client.openapi()` returns the OpenAPI document generated from the CLI command tree.

Generation rules:

- aliases are omitted;
- command groups are omitted as operations and only contribute their leaf commands;
- raw fetch gateways are omitted;
- root commands are included under their root command ID;
- mounted root CLIs keep their own command ID;
- mounted router CLI leaf commands are flattened;
- operation IDs are stable and derived from command IDs;
- command descriptions map to operation summaries;
- command args become path parameters where possible;
- optional args create path variants so shorter paths remain valid;
- `get` and `delete` commands use query parameters for options;
- other commands use JSON request bodies for options;
- command output schemas become success response schemas;
- error responses use the standard incur error envelope;
- response bodies use the same full envelope shape as RPC and direct HTTP command APIs.

Generated OpenAPI documents are discovery output. They do not change the RPC command protocol, and they do not expose local setup/admin actions.

## Local Actions

Local actions are available only on `MemoryClient`.

```ts
const memory = createMemoryClient<Commands>(cli)

await memory.skills.list()
await memory.skills.add({ depth: 1, global: true })
await memory.mcp.add({ agents: ['codex'] })
```

Local actions are not exposed by:

- `HttpClient`;
- HTTP routes;
- `POST /_incur/rpc`;
- MCP tools.

Local action options:

```ts
type SkillsAddOptions = {
  depth?: number | undefined
  global?: boolean | undefined
}

type SkillsListOptions = {
  depth?: number | undefined
}

type McpAddOptions = {
  agents?: string[] | undefined
  command?: string | undefined
  global?: boolean | undefined
}
```

Local action payloads:

```ts
type SyncedSkills = {
  agents: SkillAgentInstall[]
  paths: string[]
  skills: SyncedSkill[]
}

type SkillsList = {
  skills: ListedSkill[]
}

type McpRegistration = {
  agents: string[]
  command: string
}
```

Option names are TypeScript-shaped:

- use `global?: boolean | undefined`, not `noGlobal`;
- use `agents?: string[] | undefined`, not repeated `--agent`;
- use `command?: string | undefined`, not `--command` / `-c`.

Local action mapping:

- `memory.skills.add()` maps to CLI `skills add`;
- `memory.skills.list()` maps to CLI `skills list`;
- `memory.mcp.add()` maps to CLI `mcp add`.

Local action defaults:

- `memory.skills.add()` uses the same default depth as CLI `skills add`: configured sync depth when available, otherwise `1`.
- `memory.skills.add({ depth })` maps to CLI `--depth`.
- `memory.skills.add({ global: false })` maps to CLI `--no-global`.
- `memory.skills.add({ global: true })` maps to global installation behavior.
- `memory.skills.list()` uses the same default depth as CLI `skills list`.
- `memory.skills.list({ depth })` maps to CLI `skills list --depth`.
- `memory.mcp.add()` defaults `global` to `true`.
- `memory.mcp.add({ global: false })` maps to project/local registration behavior.
- `memory.mcp.add({ agents })` maps to repeated CLI `--agent` values.
- `memory.mcp.add({ command })` maps to CLI `--command` / `-c`.

Shell completions remain CLI-only and are not local actions.

## RPC Protocol

The RPC protocol is the command execution wire contract used by `HttpTransport.request()`.

HTTP endpoint:

```http
POST /_incur/rpc
```

Request:

```ts
type RpcRequest = {
  command: string
  args?: Record<string, unknown> | undefined
  options?: Record<string, unknown> | undefined
  outputFormat?: Formatter.Format | undefined
  selection?: string[] | undefined
  outputTokenCount?: boolean | undefined
  outputTokenLimit?: number | undefined
  outputTokenOffset?: number | undefined
}
```

Response:

```ts
type RpcResponse = RpcFullEnvelope

type RpcFullEnvelope =
  | {
      ok: true
      data: unknown
      output?: RpcOutput | undefined
      meta: RpcMeta
    }
  | {
      ok: false
      error: ClientRpcError
      output?: RpcOutput | undefined
      meta: RpcMeta
    }

type RpcMeta = {
  command: string
  duration: string
  cta?: RpcCtaBlock | undefined
}

type RpcOutput = {
  text: string
  format?: Formatter.Format | undefined
  tokenCount?: number | undefined
  tokenLimit?: number | undefined
  tokenOffset?: number | undefined
  nextOffset?: number | undefined
}
```

Validation:

- request body must be JSON object;
- `command` must be a non-empty string;
- `args` and `options` must be objects when present;
- `selection` must be omitted or a non-empty array of non-empty strings;
- unsupported output-control combinations return `400 VALIDATION_ERROR`;
- unknown command returns `404 COMMAND_NOT_FOUND`;
- fetch gateways return `400 FETCH_GATEWAY_UNSUPPORTED`.

Command normalization:

- `command` is trimmed before validation.
- empty trimmed command returns `400 VALIDATION_ERROR`.
- canonical command IDs use single spaces between tokens.
- clients generated from command maps send canonical IDs.
- the shared runtime returns canonical resolved command IDs in `meta.command`.

Structured parsing:

- RPC uses structured parsing, distinct from CLI argv, direct HTTP path/query/body routing, and MCP flat params.
- `args` are validated only against the command args schema.
- `options` are validated only against the command options schema.
- path segments are never decoded into args for RPC.
- query strings are never decoded into options for RPC.
- MCP flat-param splitting is not used for RPC.

Streaming request uses the same endpoint and request body. Clients advertise support for both response shapes with `Accept: application/json, application/x-ndjson`.

Content negotiation:

- non-streaming command results return JSON envelopes;
- streaming command results return NDJSON records;
- `Accept` advertises supported response types but does not convert a streaming command into a non-streaming response or a non-streaming command into NDJSON;
- validation errors before stream creation return JSON envelopes even when the client accepts NDJSON.

Streaming response media type:

```http
application/x-ndjson
```

Records:

```ts
type RpcStreamRecord<chunk = unknown, finalData = unknown> =
  | { type: 'chunk'; data: chunk; output?: RpcStreamOutput | undefined }
  | { type: 'done'; ok: true; data?: finalData | undefined; meta: RpcMeta }
  | { type: 'error'; ok: false; error: ClientRpcError; meta: RpcMeta }

type RpcStreamOutput = {
  text: string
  format?: Formatter.Format | undefined
}
```

Rules:

- validation errors before stream start return normal JSON envelopes;
- once a stream starts, every line is one JSON record;
- every stream ends with exactly one terminal `done` or `error`;
- the HTTP transport must match media type essence and ignore parameters such as `charset=utf-8`;
- a `done` record always includes full `RpcMeta`, including `command` and `duration`;
- an `error` record always includes full `RpcMeta`, including `command` and `duration`;
- terminal stream CTAs are preserved in `meta.cta`;
- server-side HTTP cancellation calls `return()` on the command stream;
- middleware after-hooks for streaming commands run after the stream is consumed or cancelled.

Direct command HTTP routes keep equivalent streaming behavior where applicable:

- async generator command chunks are emitted as NDJSON;
- terminal `c.ok(..., { cta })` metadata is preserved;
- terminal `c.error()` results become terminal error records;
- thrown stream errors become terminal error records;
- response cancellation closes the command stream.

## HTTP Discovery Routes

`HttpTransport.discover()` uses read-only HTTP routes.

Existing routes:

```http
GET /openapi.json
GET /openapi.yml
GET /openapi.yaml
GET /.well-known/openapi.json
GET /.well-known/skills/index.json
GET /.well-known/skills/{name}/SKILL.md
POST /mcp
```

Client discovery routes:

```http
GET /_incur/llms
GET /_incur/llms-full
GET /_incur/schema?command=project%20report
GET /_incur/help?command=project%20report
GET /_incur/mcp/tools
GET /_incur/skills
GET /_incur/skill?name=deploy
```

Mapping:

```ts
client.llms() // GET /_incur/llms
client.llmsFull() // GET /_incur/llms-full
client.schema(command) // GET /_incur/schema?command=...
client.help(command) // GET /_incur/help?command=...
client.openapi() // GET /openapi.json
client.skills.index() // GET /_incur/skills
client.skills.get(name) // GET /_incur/skill?name=...
client.mcp.tools() // GET /_incur/mcp/tools
```

Discovery error behavior:

- invalid query params return `400 VALIDATION_ERROR`;
- unknown commands return `404 COMMAND_NOT_FOUND`;
- unknown safe skill names return `404 SKILL_NOT_FOUND`;
- errors use JSON envelopes with `ok: false`, `error`, and discovery `meta`.

Discovery metadata:

```ts
type DiscoveryMeta = {
  route: string
  duration?: string | undefined
  requestId?: string | undefined
  helpRoute?: string | undefined
}
```

## Shared Runtime Builders

HTTP routes and memory transports must share runtime logic. They differ only in transport serialization and process boundary.

Shared command runtime:

```ts
type ExecuteClientCommand = (
  cli: RuntimeCliContext,
  request: RpcRequest,
) => Promise<RpcResponse | RpcStreamResponse>
```

Responsibilities:

- validate request shape;
- resolve canonical command IDs;
- reject command groups and fetch gateways where appropriate;
- call `Command.execute()`;
- use structured args/options parsing;
- call execution with `agent: true`;
- call execution with empty `argv`;
- call execution with explicit JSON/full-output semantics;
- do not decode path/query/MCP flat params for RPC;
- preserve validation `fieldErrors`;
- preserve root command identity;
- apply selection;
- format output;
- compute token metadata;
- create pagination offsets;
- preserve CTA metadata;
- emit streaming records;
- return canonical metadata;
- close command streams on cancellation.

Shared discovery runtime:

```ts
type DiscoverClientResource = (
  cli: RuntimeCliContext,
  request: DiscoveryRequest,
) => Promise<DiscoveryResponse>
```

Responsibilities:

- build `llms`;
- build `llmsFull`;
- build `schema`;
- build `help`;
- build `openapi`;
- build `skills.index`;
- build `skills.get`;
- build `mcp.tools`.

Shared local runtime:

```ts
type LocalRuntime = {
  skills: {
    add(options?: SkillsAddOptions | undefined): Promise<SyncedSkills>
    list(options?: SkillsListOptions | undefined): Promise<SkillsList>
  }
  mcp: {
    add(options?: McpAddOptions | undefined): Promise<McpRegistration>
  }
}
```

Implementation modules keep these boundaries explicit:

- command graph traversal and resolution;
- command execution and output shaping;
- discovery builders;
- local setup/admin wrappers;
- HTTP serialization;
- TS client actions.

## Generated Command Maps

Generated command maps drive client typing.

```ts
export type Commands = {
  'project report': {
    args: { projectId: string }
    options: { includeClosed?: boolean | undefined }
    output: ProjectReport
  }
  'logs tail': {
    args: { service: string }
    options: {}
    output: LogLine
    stream: true
  }
}

declare module 'incur' {
  interface Register {
    commands: Commands
  }
}

declare module 'incur/client' {
  interface Register {
    commands: Commands
  }
}
```

Generated files are normal TypeScript modules. They export `Commands` so callers can import it directly, and they augment both root and client modules so default command registration works in either import style.

Rules:

- command IDs are canonical command paths joined by spaces;
- aliases are excluded;
- command groups are excluded from run command IDs;
- mounted sub-CLI commands are flattened into canonical IDs;
- `output` is omitted when no output schema exists;
- missing `output` infers `unknown`;
- streaming commands include `stream: true`;
- streaming command `output` is the chunk type;
- each generated command property has JSDoc that names the generated command;
- object keys that are not valid TypeScript identifiers are quoted;
- command keys are emitted with `JSON.stringify`-compatible escaping;
- optional properties include `| undefined` for `exactOptionalPropertyTypes`;
- unsupported schemas throw a typegen error instead of silently emitting `unknown`.

Streaming detection:

- a command is streaming when its handler is declared as an async generator function, `async *run`;
- generated type maps mark streaming commands with `stream: true`;
- generated type maps use the declared command `output` schema as the stream chunk type;
- commands that return an async generator from a non-generator `run()` are not part of the typed streaming contract;
- authors should use `async *run` whenever generated clients need streaming-aware types.

Typegen schema support:

- object schemas;
- optional object properties;
- string, number, integer, boolean, null, void, undefined, never, and unknown;
- literals and enums;
- unions emitted from JSON Schema `anyOf`;
- arrays, including arrays of union items;
- records, including enum-key records when JSON Schema property names allow it;
- tuples and rest tuples;
- nested objects;
- object catchalls widened into compatible index signatures;
- non-object top-level output schemas.

Unsupported typegen inputs:

- schemas that cannot be converted to JSON Schema;
- transforms whose output type cannot be represented from JSON Schema;
- any schema where typegen cannot produce a stable TypeScript type.

Unsupported inputs throw `TypegenError` with a clear message.

OpenAPI-mounted fetch gateways participate in generated command maps when they are mounted with an OpenAPI spec. Raw fetch gateways are excluded.

Generated OpenAPI command map rules:

- command IDs are `${mountName} ${operationName}`;
- `operationId` defines `operationName`;
- when `operationId` is absent, `operationName` is derived from method and path;
- path parameters become command `args`;
- query parameters become command `options`;
- JSON request body object properties become command `options`;
- JSON success response schema becomes command `output`;
- absent success response schema means missing `output`, which infers `unknown`;
- path-level parameters are merged with operation-level parameters;
- required path parameters are required args;
- required query parameters are required options;
- request body properties are required only when the OpenAPI request body is required and the schema property is required;
- only JSON request and response bodies are projected into command types.

Type tests must cover:

- `createClient` preserving transport type;
- `createHttpClient` exposing no local actions;
- `createMemoryClient` exposing local actions;
- broad `Transport` exposing no local actions;
- required input for required args/options;
- optional input for optional args/options;
- selected data becoming `unknown`;
- `selection: undefined` clearing default selection;
- streaming return shape;
- discovery overloads;
- CTA runnable typing;
- generated file module augmentation;
- memory client inference from `Cli.Cli<commands>`;
- explicit command-map overrides;
- permissive unknown command maps;
- root command IDs;
- mounted root CLI IDs;
- mounted router CLI IDs;
- OpenAPI-mounted command IDs and input/output inference;
- exact optional property emission;
- non-object output schemas;
- unsupported schema failure.

## OpenAPI-Mounted Commands

OpenAPI-mounted fetch handlers turn OpenAPI operations into incur command entries.

```ts
const cli = create('acme').command('api', {
  fetch: app.fetch,
  openapi: spec,
})

const client = createMemoryClient(cli)

await client.run('api getUser', {
  args: { id: 123 },
})
```

Runtime generation rules:

- `$ref` pointers are dereferenced before commands are generated.
- OpenAPI methods include standard HTTP methods and OpenAPI 3.2 `query`.
- path-level parameters are applied to every operation under that path.
- operation-level parameters are merged with path-level parameters.
- `operationId` is the command leaf name when present.
- fallback names are derived from method and path.
- `basePath` prefixes generated request paths.
- path parameter values are URL-encoded when requests are built.
- query parameters are written to `URLSearchParams`.
- JSON request body object properties are flattened into options.
- only `application/json` request bodies are flattened.
- the first `200` response is preferred for output schema inference.
- if no `200` response exists, the first `2xx` response is used.
- only `application/json` response schemas are converted to output schemas.
- failed HTTP responses return command errors with `HTTP_${status}` codes.

Parameter coercion:

- path and query numbers use numeric coercion.
- path and query booleans accept only `true` and `false` string values as booleans.
- other string values remain invalid and fail schema validation.
- body properties do not receive path/query string coercion.

Generated OpenAPI command maps and runtime OpenAPI commands must match: every generated command ID must be callable through the shared command runtime, HTTP RPC, memory transport, and MCP tool generation when the operation is otherwise MCP-compatible.

## Error Handling

Command failures throw `ClientError`.

```ts
class ClientError extends Error {
  data: unknown
  error: unknown
  status?: number | undefined
  meta?: ClientMeta | DiscoveryMeta | undefined
  code?: string | undefined
  retryable?: boolean | undefined
  fieldErrors?: ClientRpcFieldError[] | undefined
}
```

RPC payload types:

```ts
type ClientRpcMeta = {
  command?: string | undefined
  cta?: unknown | undefined
  duration?: string | undefined
}

type ClientRpcError = {
  code: string
  fieldErrors?: ClientRpcFieldError[] | undefined
  message: string
  retryable?: boolean | undefined
}

type ClientRpcSuccessEnvelope = {
  data?: unknown | undefined
  meta?: ClientRpcMeta | undefined
  ok: true
}

type ClientRpcEnvelope =
  | ClientRpcSuccessEnvelope
  | {
      error: ClientRpcError
      meta?: ClientRpcMeta | undefined
      ok: false
    }
```

Rules:

- `run()` returns success results only;
- failed command envelopes are preserved in `ClientError.data`;
- normalized metadata is available at `ClientError.meta`;
- error CTAs live under `ClientError.meta?.cta`;
- do not add `ClientError.cta`;
- copy `code`, `retryable`, and `fieldErrors` when available;
- preserve HTTP status for HTTP transport failures;
- malformed transport responses throw `ClientError` with diagnostic `data`.

## Explicit Non-Support

HTTP env injection is not supported. HTTP commands read server-side environment.

CLI config defaults are not applied by TS clients. Clients send explicit `args` and `options`.

Shell completions are CLI-only. Programmatic command discovery uses `DiscoveryActions`.

HTTP clients, HTTP routes, RPC, and MCP tools do not expose local setup/admin actions:

- no HTTP `skills add`;
- no HTTP `skills list`;
- no HTTP `mcp add`;
- no MCP tool for these commands.

MCP tools expose command-map leaf commands and MCP tool discovery. MCP registration remains CLI or memory-client local setup.
