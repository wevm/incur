#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as ConfigSchema from './internal/configSchema.js'
import { importCli } from './internal/utils.js'
import * as Typegen from './Typegen.js'

const cli = Cli.create('incur', {
  description: 'CLI for incur',
  sync: {
    depth: 1,
    include: ['_root'],
    suggestions: ['build a cli with incur', 'generate incur types'],
  },
}).command('gen', {
  description: 'Generate type definitions for development.',
  options: z.object({
    configSchema: z
      .boolean()
      .optional()
      .describe('Generate config JSON Schema (auto-detected by default)'),
    dir: z.string().optional().describe('Project root directory'),
    entry: z.string().optional().describe('Entrypoint path (absolute)'),
    output: z.string().optional().describe('Output path (absolute)'),
  }),
  async run(c) {
    const dir = c.options.dir ?? '.'
    const entry = c.options.entry ?? dir
    const output = c.options.output ?? path.join(dir, 'incur.generated.ts')

    const cli = await importCli(entry)
    await fs.writeFile(output, Typegen.fromCli(cli))

    const result: Record<string, unknown> = { dir, entry, output }

    const configSchema = c.options.configSchema ?? ConfigSchema.hasConfig(cli)
    if (configSchema) {
      const schemaOutput = path.join(path.dirname(output), 'config.schema.json')
      await fs.writeFile(schemaOutput, JSON.stringify(ConfigSchema.fromCli(cli), null, 2) + '\n')
      result.configSchema = schemaOutput
    }

    return result
  },
})

cli.serve()

export default cli
