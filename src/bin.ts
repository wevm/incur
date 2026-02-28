#!/usr/bin/env node
import path from 'node:path'
import { z } from 'zod'

import * as Cli from './Cli.js'
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
    dir: z.string().optional().describe('Project root directory'),
    entry: z.string().optional().describe('Entrypoint path (absolute)'),
    output: z.string().optional().describe('Output path (absolute)'),
  }),
  async run(c) {
    const dir = c.options.dir ?? '.'
    const entry = c.options.entry ?? dir
    const output = c.options.output ?? path.join(dir, 'incur.generated.ts')
    await Typegen.generate(entry, output)
    return { dir, entry, output }
  },
})

cli.serve()

export default cli
