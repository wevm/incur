import type * as Cli from '../Cli.js'
import type * as Formatter from '../Formatter.js'
import type {
  McpAddOptions,
  McpRegistration,
  Runtime as LocalRuntime,
  SkillsAddOptions,
  SkillsList,
  SkillsListOptions,
  SyncedSkills,
} from './Local.js'
import type {
  Envelope as RpcFullEnvelope,
  Meta as RpcMeta,
  Output as RpcOutput,
  Request as RpcRequest,
  Response as RpcResponse,
  StreamRecord as RpcStreamRecord,
  StreamResponse as RpcStreamResponse,
} from './Rpc.js'
import type {
  Request as ResourcesRequest,
  Response as ResourcesResponse,
} from './Resources.js'
import type { HttpTransport } from './transports/HttpTransport.js'
import type { MemoryTransport } from './transports/MemoryTransport.js'

/** Type-safe client registration interface populated by generated client maps. */
// biome-ignore lint/suspicious/noEmptyInterface: populated via declaration merging
export interface Register {}

/** Default command map registered for typed clients. */
export type Commands = Register extends { commands: infer commands extends CommandsMap }
  ? commands
  : {}

/** Command map entry shape. */
export type CommandEntry = {
  /** Structured positional arguments. */
  args: unknown
  /** Structured named options. */
  options: unknown
  /** Structured command output. */
  output?: unknown | undefined
  /** Whether the command streams chunk outputs. */
  stream?: true | undefined
}

/** Command map shape used by typed clients. */
export type CommandsMap = Record<string, CommandEntry>

/** Supported client transports. */
export type Transport = HttpTransport | MemoryTransport

/** Resolved transport value attached to a client. */
export type ResolvedTransport<transport extends Transport> = ReturnType<transport>['config'] &
  Omit<ReturnType<transport>, 'config'>

/** Client defaults used by run actions. */
export type ClientDefaults = {
  /** Rendered output format for command output text. */
  outputFormat?: Formatter.Format | undefined
  /** Structured output selection paths. */
  selection?: string[] | undefined
  /** Whether token metadata should be included. */
  outputTokenCount?: boolean | undefined
  /** Maximum rendered output tokens. */
  outputTokenLimit?: number | undefined
  /** Rendered output token offset. */
  outputTokenOffset?: number | undefined
}

/** Base client fields. */
export type ClientBase<transport extends Transport, defaults extends ClientDefaults> = {
  /** Defaults applied by actions before transport requests. */
  defaults: defaults
  /** Resolved transport metadata and capabilities. */
  transport: ResolvedTransport<transport>
  /** Client discriminator. */
  type: 'client'
  /** Unique client id. */
  uid: string
}

/** Typed client instance. */
export type Client<
  commands = Commands,
  transport extends Transport = Transport,
  defaults extends ClientDefaults = {},
> = ClientBase<transport, defaults> &
  RunActions<commands, transport, defaults> &
  DiscoveryActions<commands, transport> &
  ([transport] extends [MemoryTransport] ? LocalActions : {})

/** HTTP client instance. */
export type HttpClient<commands = Commands, defaults extends ClientDefaults = {}> = Client<
  commands,
  HttpTransport,
  defaults
>

/** Memory client instance. */
export type MemoryClient<commands = Commands, defaults extends ClientDefaults = {}> = Client<
  commands,
  MemoryTransport,
  defaults
>

/** Options for `createClient`. */
export type CreateClientOptions<
  transport extends Transport,
  defaults extends ClientDefaults,
> = defaults &
  ClientDefaults & {
    /** Transport factory to resolve. */
    transport: transport
  }

/** Canonical command id. */
export type CommandId<commands> = keyof commands & string

/** Command prefix usable by discovery actions. */
export type CommandPrefix<command extends string> = command extends `${infer head} ${infer tail}`
  ? head | `${head} ${CommandPrefix<tail>}`
  : never

/** Command or command-group scope usable by discovery actions. */
export type CommandScope<commands> = CommandId<commands> | CommandPrefix<CommandId<commands>>

/** Command args type. */
export type CommandArgs<commands, command extends CommandId<commands>> = commands[command] extends {
  args: infer args
}
  ? args
  : unknown

/** Command options type. */
export type CommandOptions<
  commands,
  command extends CommandId<commands>,
> = commands[command] extends { options: infer options } ? options : unknown

/** Command output data type. */
export type CommandData<commands, command extends CommandId<commands>> = commands[command] extends {
  output: infer output
}
  ? output
  : unknown

/** Required keys in an object-like type. */
export type RequiredKeys<type> = type extends object
  ? {
      [key in keyof type]-?: {} extends Pick<type, key> ? never : key
    }[keyof type]
  : never

/** Conditional input field. */
export type Field<name extends string, value> =
  RequiredKeys<value> extends never
    ? { [key in name]?: value | undefined }
    : { [key in name]: value }

/** Output controls for command runs. */
export type OutputOptions = ClientDefaults

/** Run input for a command. */
export type RunInput<commands, command extends CommandId<commands>> = Field<
  'args',
  CommandArgs<commands, command>
> &
  Field<'options', CommandOptions<commands, command>> &
  (commands[command] extends { stream: true }
    ? Omit<OutputOptions, 'outputTokenCount' | 'outputTokenLimit' | 'outputTokenOffset'>
    : OutputOptions)

/** Run input parameter tuple. */
export type RunInputParameters<
  commands,
  command extends CommandId<commands>,
  input extends RunInput<commands, command> | undefined,
> =
  RequiredKeys<RunInput<commands, command>> extends never
    ? [input?: StrictInput<input, RunInput<commands, command>> | undefined]
    : [input: StrictInput<input, RunInput<commands, command>> & RunInput<commands, command>]

/** Rejects keys outside an expected input shape. */
export type StrictInput<input, shape> = input extends undefined
  ? undefined
  : input & { [key in Exclude<keyof input, keyof shape>]: never }

/** Effective output type after selection controls. */
export type EffectiveOutput<output, selection> = [selection] extends [undefined] ? output : unknown

/** Effective run output type after input/default selection controls. */
export type EffectiveRunOutput<output, input, defaults> = EffectiveOutput<
  output,
  input extends { selection: infer selection }
    ? selection
    : defaults extends { selection: infer selection }
      ? selection
      : undefined
>

/** Run return type. */
export type RunReturn<
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

/** Run action set. */
export type RunActions<commands, _transport extends Transport, defaults extends ClientDefaults> = {
  run<
    const command extends CommandId<commands>,
    const input extends RunInput<commands, command> | undefined = undefined,
  >(
    command: command,
    ...input: RunInputParameters<commands, command, input>
  ): Promise<RunReturn<commands, command, input, defaults>>
}

/** Successful non-streaming command result. */
export type ClientRunResult<data, commands = Commands> = {
  /** Success discriminator. */
  ok: true
  /** Structured command data. */
  data: data
  /** Rendered output text and pagination controls. */
  output?: ClientOutput<data, commands> | undefined
  /** Command metadata. */
  meta: ClientMeta<commands>
}

/** Rendered command output. */
export type ClientOutput<data, commands = Commands> = {
  /** Rendered text. */
  text: string
  /** Rendered format. */
  format?: Formatter.Format | undefined
  /** Full rendered token count. */
  tokenCount?: number | undefined
  /** Requested token limit. */
  tokenLimit?: number | undefined
  /** Requested token offset. */
  tokenOffset?: number | undefined
  /** Fetches the next output page for the same command. */
  next?: (() => Promise<ClientRunResult<data, commands>>) | undefined
}

/** Client metadata. */
export type ClientMeta<commands = Commands> = {
  /** Canonical command id. */
  command: string
  /** Wall-clock duration. */
  duration: string
  /** Normalized call-to-action metadata. */
  cta?: ClientCtaBlock<commands> | undefined
}

/** CTA block. */
export type ClientCtaBlock<commands = Commands> = {
  /** CTA block description. */
  description?: string | undefined
  /** CTA commands. */
  commands: ClientCta<commands>[]
}

/** CTA command. */
export type ClientCta<commands = Commands> =
  | ClientRunnableCta<commands, CommandId<commands>>
  | ClientUnresolvedCta

/** Runnable CTA command. */
export type ClientRunnableCta<commands, command extends CommandId<commands>> = {
  /** Canonical command id. */
  command: command
  /** CLI-ready command text. */
  cliCommand: string
  /** CTA description. */
  description?: string | undefined
  /** Structured args. */
  args?: CommandArgs<commands, command> | undefined
  /** Structured options. */
  options?: CommandOptions<commands, command> | undefined
  /** Raw source CTA. */
  raw: unknown
  /** Runnable discriminator. */
  runnable: true
  run<const options extends ClientCtaRunOptions | undefined = undefined>(
    options?: options,
  ): Promise<CtaRunReturn<commands, command, options>>
}

/** Unresolved CTA command. */
export type ClientUnresolvedCta = {
  /** CLI-ready command text when one could be derived. */
  cliCommand?: string | undefined
  /** CTA description. */
  description?: string | undefined
  /** Raw source CTA. */
  raw: unknown
  /** Runnable discriminator. */
  runnable: false
  /** Reason the CTA could not be converted into a typed run action. */
  unresolvedReason: 'unknown-command' | 'invalid-input' | 'unstructured'
}

/** CTA run output controls. */
export type ClientCtaRunOptions = OutputOptions

/** CTA run return type. */
export type CtaRunReturn<
  commands,
  command extends CommandId<commands>,
  options extends ClientCtaRunOptions | undefined,
> = RunReturn<commands, command, options & RunInput<commands, command>, {}>

/** Stream response wrapper. */
export type ClientStreamResponse<
  chunk,
  finalData = unknown,
  commands = Commands,
> = AsyncIterable<chunk> & {
  /** Terminal stream result. */
  final: Promise<ClientStreamFinal<finalData, commands>>
  /** Iterates over chunk and terminal records. */
  records(): AsyncIterable<ClientStreamRecord<chunk, finalData, commands>>
}

/** Successful terminal stream result. */
export type ClientStreamFinal<finalData = unknown, commands = Commands> = {
  /** Success discriminator. */
  ok: true
  /** Terminal structured data. */
  data?: finalData | undefined
  /** Terminal metadata. */
  meta: ClientMeta<commands>
}

/** Stream output attached to a chunk. */
export type ClientStreamOutput = {
  /** Rendered chunk text. */
  text: string
  /** Rendered chunk format. */
  format?: Formatter.Format | undefined
}

/** Normalized stream record. */
export type ClientStreamRecord<chunk, finalData = unknown, commands = Commands> =
  | { type: 'chunk'; data: chunk; output?: ClientStreamOutput | undefined }
  | { type: 'done'; ok: true; data?: finalData | undefined; meta: ClientMeta<commands> }
  | { type: 'error'; ok: false; error: ClientRpcError; meta: ClientMeta<commands> }

/** Discovery format. */
export type DiscoveryFormat = 'md' | 'json' | 'yaml' | 'toon'

/** Discovery result for a structured type and format option. */
export type DiscoveryResult<structured, format> = [format] extends [undefined]
  ? structured
  : undefined extends format
    ? structured | string
    : string

/** LLM manifest. */
export type LlmsManifest<
  commands = Commands,
  scope extends CommandScope<commands> | undefined = undefined,
> = {
  /** Manifest version. */
  version: string
  /** Available commands. */
  commands: LlmsCommand<commands, scope>[]
}

/** Full LLM manifest. */
export type LlmsFullManifest<
  commands = Commands,
  scope extends CommandScope<commands> | undefined = undefined,
> = LlmsManifest<commands, scope>

/** LLM command entry. */
export type LlmsCommand<
  commands = Commands,
  scope extends CommandScope<commands> | undefined = undefined,
> = {
  /** Command name. */
  name: scope extends undefined
    ? CommandId<commands>
    : Extract<CommandId<commands>, `${scope}` | `${scope} ${string}`>
  /** Command description. */
  description?: string | undefined
  /** Command schemas. */
  schema?: CommandSchema<commands, CommandId<commands>> | undefined
}

/** JSON-ish command schema. */
export type CommandSchema<_commands = Commands, _command extends string = string> = Record<
  string,
  unknown
> & {
  /** Args schema. */
  args?: Record<string, unknown> | undefined
  /** Options schema. */
  options?: Record<string, unknown> | undefined
  /** Env schema. */
  env?: Record<string, unknown> | undefined
  /** Output schema. */
  output?: Record<string, unknown> | undefined
}

/** OpenAPI document. */
export type OpenApiDocument = Record<string, unknown> & {
  /** OpenAPI version. */
  openapi?: string | undefined
  /** OpenAPI info object. */
  info?: Record<string, unknown> | undefined
}

/** Skills index. */
export type SkillsIndex = {
  /** Generated skills. */
  skills: { name: string; description: string; files: string[] }[]
}

/** Local skills list. */
export type SkillsList = {
  /** Listed skills. */
  skills: unknown[]
}

/** MCP tool descriptor response. */
export type McpToolsResponse<_commands = Commands> = {
  /** MCP tools. */
  tools: Record<string, unknown>[]
}

/** Discovery action set. */
export type DiscoveryActions<commands, _transport extends Transport> = {
  llms: LlmsAction<commands>
  llmsFull: LlmsFullAction<commands>
  schema(command?: CommandScope<commands> | undefined): Promise<CommandSchema<commands>>
  help(command?: CommandScope<commands> | undefined): Promise<string>
  openapi(): Promise<OpenApiDocument>
  skills: {
    index(): Promise<SkillsIndex>
    get(name: string): Promise<string>
  }
  mcp: {
    tools(): Promise<McpToolsResponse<commands>>
  }
}

/** Compact LLM discovery action. */
export type LlmsAction<commands> = {
  <
    const scope extends CommandScope<commands> | undefined = undefined,
    const format extends DiscoveryFormat | undefined = undefined,
  >(
    options?: { command?: scope | undefined; format?: format | undefined } | undefined,
  ): Promise<DiscoveryResult<LlmsManifest<commands, scope>, format>>
}

/** Full LLM discovery action. */
export type LlmsFullAction<commands> = {
  <
    const scope extends CommandScope<commands> | undefined = undefined,
    const format extends DiscoveryFormat | undefined = undefined,
  >(
    options?: { command?: scope | undefined; format?: format | undefined } | undefined,
  ): Promise<DiscoveryResult<LlmsFullManifest<commands, scope>, format>>
}

/** Memory-only local actions. */
export type LocalActions = {
  skills: {
    add(options?: SkillsAddOptions | undefined): Promise<SyncedSkills>
    list(options?: SkillsListOptions | undefined): Promise<SkillsList>
  }
  mcp: {
    add(options?: McpAddOptions | undefined): Promise<McpRegistration>
  }
}

/** Public RPC envelope alias. */
export type ClientRpcEnvelope = RpcFullEnvelope

/** Public RPC metadata alias. */
export type ClientRpcMeta = RpcMeta

/** Public RPC output alias. */
export type ClientRpcOutput = RpcOutput

/** Public RPC error object. */
export type ClientRpcError = Extract<RpcFullEnvelope, { ok: false }>['error']

/** Client implementation shape used by actions. */
export type ActionClient = {
  defaults: ClientDefaults
  transport: {
    request(request: RpcRequest): Promise<RpcResponse | RpcStreamResponse>
    discover(request: ResourcesRequest): Promise<ResourcesResponse>
    local?: LocalRuntime | undefined
  } & ResolvedTransport<Transport>
}

/** CLI value accepted by memory clients. */
export type AnyCli = Cli.Cli<any, any, any>

export type {
  McpAddOptions,
  McpRegistration,
  RpcRequest,
  RpcResponse,
  RpcStreamRecord,
  RpcStreamResponse,
  SkillsAddOptions,
  SkillsList,
  SkillsListOptions,
  SyncedSkills,
}
