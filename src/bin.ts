import path from 'node:path'
import { z } from 'zod'
import * as Cli from './Cli.js'
import * as Typegen from './Typegen.js'

const cli = Cli.create('clac', {
  description: 'CLI for clac',
  sync: {
    depth: 0,
    suggestions: ['generate clac types']
  }
}).command('gen', {
  description: 'Generate type definitions for development.',
  options: z.object({
    dir: z.string().optional().describe('Project root directory'),
    entry: z.string().optional().describe('Entrypoint path (absolute)'),
    output: z.string().optional().describe('Output path (absolute)'),
  }),
  async run({ options }) {
    const dir = options.dir ?? '.'
    const entry = options.entry ?? dir
    const output = options.output ?? path.join(dir, 'clac.generated.ts')
    await Typegen.generate(entry, output)
    return { dir, entry, output }
  },
}).serve()

export default cli
