import type * as Formatter from '../Formatter.js'
import type * as Client from './Client.js'
import type * as Rpc from './Rpc.js'

/** Command args type. */
export type Args<commands, command extends Client.CommandId<commands>> = commands[command] extends {
  args: infer args
}
  ? args
  : unknown

/** Command options type. */
export type Options<
  commands,
  command extends Client.CommandId<commands>,
> = commands[command] extends {
  options: infer options
}
  ? options
  : unknown

/** Command output data type. */
export type Data<commands, command extends Client.CommandId<commands>> = commands[command] extends {
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

/** Run input for a command. */
export type Input<commands, command extends Client.CommandId<commands>> = Field<
  'args',
  Args<commands, command>
> &
  Field<'options', Options<commands, command>> &
  (commands[command] extends { stream: true }
    ? Omit<Client.Defaults, 'outputTokenCount' | 'outputTokenLimit' | 'outputTokenOffset'>
    : Client.Defaults)

/** Run input parameter tuple. */
export type InputParameters<
  commands,
  command extends Client.CommandId<commands>,
  input extends Input<commands, command> | undefined,
> =
  RequiredKeys<Input<commands, command>> extends never
    ? [input?: StrictInput<input, Input<commands, command>> | undefined]
    : [input: StrictInput<input, Input<commands, command>> & Input<commands, command>]

/** Rejects keys outside an expected input shape. */
export type StrictInput<input, shape> = input extends undefined
  ? undefined
  : input & { [key in Exclude<keyof input, keyof shape>]: never } & {
      [key in keyof input & keyof shape]: key extends 'args' | 'options'
        ? StrictField<input[key], shape[key]>
        : input[key]
    }

/** Rejects keys outside expected `args` or `options` objects. */
export type StrictField<value, shape> =
  IsUnknown<shape> extends true
    ? value
    : NonNullable<shape> extends object
      ? value & { [key in Exclude<keyof value, keyof NonNullable<shape>>]: never }
      : value

/** Returns true when a type is exactly unknown. */
export type IsUnknown<type> = unknown extends type
  ? [keyof type] extends [never]
    ? true
    : false
  : false

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
export type Return<
  commands,
  command extends Client.CommandId<commands>,
  input extends Input<commands, command> | undefined,
  defaults extends Client.Defaults,
> = commands[command] extends { stream: true }
  ? StreamResponse<EffectiveRunOutput<Data<commands, command>, input, defaults>, unknown, commands>
  : Result<EffectiveRunOutput<Data<commands, command>, input, defaults>, commands>

/** Run action set. */
export type Actions<commands, defaults extends Client.Defaults> = {
  run<
    const command extends Client.CommandId<commands>,
    const input extends Input<commands, command> | undefined = undefined,
  >(
    command: command,
    ...input: InputParameters<commands, command, input>
  ): Promise<Return<commands, command, input, defaults>>
}

/** Successful non-streaming command result. */
export type Result<data, commands = Client.Commands> = {
  /** Success discriminator. */
  ok: true
  /** Structured command data. */
  data: data
  /** Rendered output text and pagination controls. */
  output?: Output<data, commands> | undefined
  /** Command metadata. */
  meta: Meta<commands>
}

/** Rendered command output. */
export type Output<data, commands = Client.Commands> = {
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
  next?: (() => Promise<Result<data, commands>>) | undefined
}

/** Client metadata. */
export type Meta<commands = Client.Commands> = {
  /** Canonical command id. */
  command: string
  /** Wall-clock duration. */
  duration: string
  /** Normalized call-to-action metadata. */
  cta?: CtaBlock<commands> | undefined
}

/** CTA block. */
export type CtaBlock<commands = Client.Commands> = {
  /** CTA block description. */
  description?: string | undefined
  /** CTA commands. */
  commands: Cta<commands>[]
}

/** CTA command. */
export type Cta<commands = Client.Commands> = {
  /** Suggested command id. */
  command: string
  /** CLI-ready command text. */
  cliCommand: string
  /** CTA description. */
  description?: string | undefined
  /** Structured args when provided by the server. */
  args?: Record<string, unknown> | undefined
  /** Structured options when provided by the server. */
  options?: Record<string, unknown> | undefined
  /** Raw source CTA. */
  raw: unknown
  /** Runs the suggested command. Invalid suggestions fail like normal client runs. */
  run<const options extends Client.Defaults | undefined = undefined>(
    options?: options,
  ): Promise<
    Result<
      EffectiveOutput<
        unknown,
        options extends { selection: infer selection } ? selection : undefined
      >,
      commands
    >
  >
}

/** Stream response wrapper. */
export type StreamResponse<
  chunk,
  finalData = unknown,
  commands = Client.Commands,
> = AsyncIterable<chunk> & {
  /** Terminal stream result. */
  final: Promise<StreamFinal<finalData, commands>>
  /** Iterates over chunk and terminal records. */
  records(): AsyncIterable<StreamRecord<chunk, finalData, commands>>
}

/** Successful terminal stream result. */
export type StreamFinal<finalData = unknown, commands = Client.Commands> = {
  /** Success discriminator. */
  ok: true
  /** Terminal structured data. */
  data?: finalData | undefined
  /** Terminal rendered output text. */
  output?: Output<finalData, commands> | undefined
  /** Terminal metadata. */
  meta: Meta<commands>
}

/** Stream output attached to a chunk. */
export type StreamOutput = {
  /** Rendered chunk text. */
  text: string
  /** Rendered chunk format. */
  format?: Formatter.Format | undefined
}

/** Normalized stream record. */
export type StreamRecord<chunk, finalData = unknown, commands = Client.Commands> =
  | { type: 'chunk'; data: chunk; output?: StreamOutput | undefined }
  | {
      type: 'done'
      ok: true
      data?: finalData | undefined
      output?: Output<finalData, commands> | undefined
      meta: Meta<commands>
    }
  | { type: 'error'; ok: false; error: Rpc.Error; meta: Meta<commands> }
