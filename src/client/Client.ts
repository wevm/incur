import * as local from './actions/local.js'
import * as resources from './actions/resources.js'
import { run } from './actions/run.js'
export { ClientError } from './ClientError.js'
import type {
  Client,
  ClientBase,
  ClientCta,
  ClientCtaBlock,
  ClientCtaRunOptions,
  ClientDefaults,
  ClientMeta,
  ClientOutput,
  ClientRpcEnvelope,
  ClientRpcError,
  ClientRpcMeta,
  ClientRunResult,
  ClientStreamFinal,
  ClientStreamOutput,
  ClientStreamRecord,
  ClientStreamResponse,
  CommandArgs,
  CommandData,
  CommandId,
  CommandOptions,
  CommandScope,
  Commands,
  CommandsMap,
  CreateOptions,
  EffectiveOutput,
  EffectiveRunOutput,
  LlmsAction,
  LlmsFullAction,
  LlmsFullManifest,
  LlmsManifest,
  LocalActions,
  McpToolsResponse,
  OpenApiDocument,
  OutputOptions,
  Register,
  ResourcesActions,
  ResourcesFormat,
  ResourcesResult,
  ResolvedTransport,
  RunActions,
  RunInput,
  RunInputParameters,
  RunReturn,
  SkillsIndex,
  StrictInput,
  Transport,
} from './types.js'

export type {
  Client,
  ClientBase,
  ClientCta,
  ClientCtaBlock,
  ClientCtaRunOptions,
  ClientDefaults,
  ClientMeta,
  ClientOutput,
  ClientRpcEnvelope,
  ClientRpcError,
  ClientRpcMeta,
  ClientRunResult,
  ClientStreamFinal,
  ClientStreamOutput,
  ClientStreamRecord,
  ClientStreamResponse,
  CommandArgs,
  CommandData,
  CommandId,
  CommandOptions,
  CommandScope,
  Commands,
  CommandsMap,
  CreateOptions,
  EffectiveOutput,
  EffectiveRunOutput,
  LlmsAction,
  LlmsFullAction,
  LlmsFullManifest,
  LlmsManifest,
  LocalActions,
  McpToolsResponse,
  OpenApiDocument,
  OutputOptions,
  Register,
  ResourcesActions,
  ResourcesFormat,
  ResourcesResult,
  ResolvedTransport,
  RunActions,
  RunInput,
  RunInputParameters,
  RunReturn,
  SkillsIndex,
  StrictInput,
  Transport,
}

/** Creates a typed client from a transport factory. */
export function create<
  const commands = Commands,
  const transport extends Transport = Transport,
  const defaults extends ClientDefaults = {},
>(options: CreateOptions<transport, defaults>): Client<commands, transport, defaults> {
  const { transport, ...defaults } = options
  const resolved = transport()
  const { config, ...capabilities } = resolved
  const client = {
    defaults,
    transport: { ...config, ...capabilities },
    type: 'client',
  } as unknown as Client<commands, transport, defaults>

  return attachActions(client) as Client<commands, transport, defaults>
}

function attachActions<const client extends object>(client: client): client {
  Object.assign(client, {
    run(command: string, input?: unknown) {
      return run(client as never, command, input as never)
    },
    llms(options?: unknown) {
      return resources.llms(client as never, options as never)
    },
    llmsFull(options?: unknown) {
      return resources.llmsFull(client as never, options as never)
    },
    schema(command?: string | undefined) {
      return resources.schema(client as never, command)
    },
    help(command?: string | undefined) {
      return resources.help(client as never, command)
    },
    openapi() {
      return resources.openapi(client as never)
    },
    skills: {
      index() {
        return resources.skillsIndex(client as never)
      },
      get(name: string) {
        return resources.skill(client as never, name)
      },
    },
    mcp: {
      tools() {
        return resources.mcpTools(client as never)
      },
    },
  })

  if ('transport' in client && 'local' in (client as { transport: object }).transport) {
    Object.assign((client as unknown as { skills: object }).skills, {
      add(options?: unknown) {
        return local.skillsAdd(client as never, options as never)
      },
      list(options?: unknown) {
        return local.skillsList(client as never, options as never)
      },
    })
    Object.assign((client as unknown as { mcp: object }).mcp, {
      add(options?: unknown) {
        return local.mcpAdd(client as never, options as never)
      },
    })
  }

  return client
}
