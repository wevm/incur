import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import {
  objectSchemaToType,
  propertyKey,
  schemaHasProperties,
  schemaHasRequiredProperties,
  schemaToType,
} from './internal/ts.js'
import { importCli } from './internal/utils.js'

/** Imports a CLI from `input`, generates an incur client module, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await Cli.ready(cli)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a typed client module for a CLI. */
export function fromCli(cli: Cli.Cli): string {
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const name = pascalCase(cli.name)
  const entries = collectEntries(commands, [])
  const root = Cli.toRootDefinition.get(cli as unknown as Cli.Root)
  const tree = buildTree(entries)
  const clientTypeName = `${name}Client`
  const resultClientTypeName = `${name}ResultClient`
  const lines = ["import { Client } from 'incur'", '']

  lines.push(`export type ${clientTypeName} = ${renderType(tree, 'data')}`, '')
  lines.push(`export type ${resultClientTypeName} = ${renderType(tree, 'result')}`, '')

  if (root) {
    const rootEntry = commandEntry([], root)
    lines.push(`export type ${name}RootClient = ${methodType(rootEntry, 'data')}`, '')
    lines.push(`export type ${name}RootResultClient = ${methodType(rootEntry, 'result')}`, '')
  }

  lines.push(
    `export function create${name}Client(options: Client.create.Options): ${clientTypeName} {`,
    '  const context = Client.create(options)',
    ...renderCreateObject('client', tree, clientTypeName, 'data', [], '  '),
    '  return client',
    '}',
    '',
    `export function create${name}ResultClient(options: Client.create.Options): ${resultClientTypeName} {`,
    '  const context = Client.create(options)',
    ...renderCreateObject('client', tree, resultClientTypeName, 'result', [], '  '),
    '  return client',
    '}',
  )

  if (root) {
    const rootEntry = commandEntry([], root)
    lines.push(
      '',
      `export function create${name}RootClient(options: Client.create.Options): ${name}RootClient {`,
      '  const context = Client.create(options)',
      `  return (${renderMethod(rootEntry, [], 'data')}) as ${name}RootClient`,
      '}',
      '',
      `export function create${name}RootResultClient(options: Client.create.Options): ${name}RootResultClient {`,
      '  const context = Client.create(options)',
      `  return (${renderMethod(rootEntry, [], 'result')}) as ${name}RootResultClient`,
      '}',
    )
  }

  lines.push('')
  return lines.join('\n')
}

type Entry = {
  args?: z.ZodObject<any> | undefined
  options?: z.ZodObject<any> | undefined
  output?: z.ZodType | undefined
  path: string[]
}

type Node = {
  children: Map<string, Node>
  entry?: Entry | undefined
}

function collectEntries(commands: Map<string, any>, prefix: string[]): Entry[] {
  const result: Entry[] = []
  for (const [name, rawEntry] of commands) {
    const entry = '_alias' in rawEntry && rawEntry._alias ? commands.get(rawEntry.target) : rawEntry
    if (!entry) continue
    const path = [...prefix, name]

    if ('_group' in entry && entry._group) {
      result.push(...collectEntries(entry.commands, path))
      continue
    }

    if ('_fetch' in entry && entry._fetch) continue
    result.push(commandEntry(path, entry))
  }
  return result.sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')))
}

function commandEntry(path: string[], command: any): Entry {
  return {
    path,
    args: command.args,
    options: command.options,
    output: command.output,
  }
}

function buildTree(entries: Entry[]): Node {
  const root: Node = { children: new Map() }
  for (const entry of entries) {
    let node = root
    for (const segment of entry.path) {
      let child = node.children.get(segment)
      if (!child) {
        child = { children: new Map() }
        node.children.set(segment, child)
      }
      node = child
    }
    node.entry = entry
  }
  return root
}

function renderType(node: Node, mode: 'data' | 'result'): string {
  const fields: string[] = []
  for (const [key, child] of node.children) {
    const type = child.entry ? methodType(child.entry, mode) : renderType(child, mode)
    fields.push(`${propertyKey(key)}: ${type}`)
  }
  return fields.length === 0 ? '{}' : `{ ${fields.join('; ')} }`
}

function methodType(entry: Entry, mode: 'data' | 'result'): string {
  const args = schemaHasProperties(entry.args) ? objectSchemaToType(entry.args) : undefined
  const options = schemaHasProperties(entry.options) ? objectSchemaToType(entry.options) : undefined
  const output = entry.output ? schemaToType(entry.output) : 'unknown'
  const result = mode === 'data' ? output : `Client.Result<${output}>`
  const request = 'request?: Client.RequestOptions | undefined'

  if (args && options) {
    const optionsParam = schemaHasRequiredProperties(entry.options)
      ? `options: ${options}`
      : `options?: ${options} | undefined`
    return `(args: ${args}, ${optionsParam}, ${request}) => Promise<${result}>`
  }
  if (args) return `(args: ${args}, ${request}) => Promise<${result}>`
  if (options) {
    const optionsParam = schemaHasRequiredProperties(entry.options)
      ? `options: ${options}`
      : `options?: ${options} | undefined`
    return `(${optionsParam}, ${request}) => Promise<${result}>`
  }
  return `(${request}) => Promise<${result}>`
}

function renderCreateObject(
  name: string,
  node: Node,
  typeName: string,
  mode: 'data' | 'result',
  path: string[],
  prefix: string,
): string[] {
  const lines = [`${prefix}const ${name} = Client.object<${typeName}>()`]
  let index = 0
  for (const [key, child] of node.children) {
    const nextPath = [...path, key]
    if (child.entry) {
      lines.push(
        `${prefix}Client.define(${name}, ${propertyKey(key)}, (${renderMethod(child.entry, child.entry.path, mode)}) as ${propertyAccess(typeName, [key])})`,
      )
      continue
    }

    const childName = nextName(name, index++)
    const childType = propertyAccess(typeName, nextPath)
    lines.push(...renderCreateObject(childName, child, childType, mode, nextPath, prefix))
    lines.push(`${prefix}Client.define(${name}, ${propertyKey(key)}, ${childName})`)
  }
  return lines
}

function renderMethod(entry: Entry, path: string[], mode: 'data' | 'result'): string {
  const helper = mode === 'data' ? 'call' : 'result'
  const args = schemaHasProperties(entry.args)
  const options = schemaHasProperties(entry.options)
  const call = (input: string, request: string) =>
    `Client.${helper}(context, ${JSON.stringify(path)}, ${input}, ${request})`

  if (args && options) return `(args, options, request) => ${call('{ args, options }', 'request')}`
  if (args) return `(args, request) => ${call('{ args }', 'request')}`
  if (options) return `(options, request) => ${call('{ options }', 'request')}`
  return `(request) => ${call('{}', 'request')}`
}

function propertyAccess(typeName: string, path: string[]): string {
  return path.reduce((type, key) => `${type}[${propertyKey(key)}]`, typeName)
}

function nextName(name: string, index: number): string {
  return `${name}_${index}`
}

function pascalCase(value: string): string {
  const parts = value.match(/[A-Za-z0-9]+/g) ?? ['Client']
  const result = parts.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('')
  return /^\d/.test(result) ? `_${result}` : result
}
