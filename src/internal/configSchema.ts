import fs from 'node:fs/promises'
import type { z } from 'zod'

import * as Cli from '../Cli.js'
import * as Schema from '../Schema.js'
import { importCli } from './utils.js'

/** Returns `true` if the CLI has `config` enabled on `Cli.create()`. */
export function hasConfig(cli: Cli.Cli): boolean {
  return Cli.toConfigEnabled.get(cli) === true
}

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the JSON Schema, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await fs.writeFile(output, JSON.stringify(fromCli(cli), null, 2) + '\n')
}

/** Generates a JSON Schema describing the config file structure for a CLI. */
export function fromCli(cli: Cli.Cli): Record<string, unknown> {
  const commands = Cli.toCommands.get(cli)
  if (!commands) return { type: 'object' }

  const rootOptions = Cli.toRootOptions.get(cli)
  const node = buildNode(commands, rootOptions)
  const properties = (node.properties ?? {}) as Record<string, unknown>
  properties.$schema = { type: 'string' }
  node.properties = properties
  return node
}

/** Builds a JSON Schema node for a command level. */
function buildNode(
  commands: Map<string, any>,
  options?: z.ZodObject<any>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}

  // Add `options` property from the options schema
  if (options) {
    const optSchema = Schema.toJsonSchema(options)
    const props = optSchema.properties as Record<string, unknown> | undefined
    if (props && Object.keys(props).length > 0)
      properties.options = { type: 'object', additionalProperties: false, properties: props }
  }

  // Add `commands` property with subcommand namespaces
  const commandProps: Record<string, unknown> = {}
  for (const [name, entry] of commands) {
    if ('_group' in entry && entry._group) {
      commandProps[name] = buildNode(entry.commands, undefined)
    } else if (!('_fetch' in entry)) {
      const cmd = entry as { options?: z.ZodObject<any> }
      commandProps[name] = buildNode(new Map(), cmd.options)
    }
  }
  if (Object.keys(commandProps).length > 0)
    properties.commands = { type: 'object', additionalProperties: false, properties: commandProps }

  const node: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
  }
  if (Object.keys(properties).length > 0) node.properties = properties
  return node
}
