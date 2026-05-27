import * as local from './actions/local.js'
import * as resources from './actions/resources.js'
import * as run from './actions/run.js'
export { ClientError } from './ClientError.js'
import type {
  ActionClient,
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
  } satisfies ActionClient & { type: 'client' }

  return {
    ...client,
    ...actions(client),
  } as unknown as Client<commands, transport, defaults>
}

function actions(client: ActionClient) {
  const base = {
    ...run.actions(client),
    ...resources.actions(client),
  }

  if (!client.transport.local) return base
  const memory = local.actions(client)

  return {
    ...base,
    ...memory,
    skills: {
      ...base.skills,
      ...memory.skills,
    },
    mcp: {
      ...base.mcp,
      ...memory.mcp,
    },
  }
}
