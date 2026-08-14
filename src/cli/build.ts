import { z } from 'zod'

import * as Cli from '../Cli.js'
import * as BinaryBuild from '../internal/binaryBuild.js'

export default Cli.command({
  description: 'Build standalone binaries.',
  args: z.object({
    entry: z.string().describe('CLI entrypoint file or project directory'),
  }),
  options: z.object({
    installer: z.boolean().optional().describe('Generate initial-install scripts'),
    name: z.string().optional().describe('CLI name override'),
    output: z.string().optional().describe('Output directory'),
    repository: z.string().optional().describe('Public GitHub repository (owner/name)'),
    tag: z.string().optional().describe('Exact GitHub release tag for generated installers'),
    target: z.array(z.string()).optional().describe('Target to build (repeatable)'),
    version: z.string().optional().describe('CLI version override'),
  }),
  run(c) {
    return BinaryBuild.build({
      entry: c.args.entry,
      installer: c.options.installer,
      name: c.options.name,
      output: c.options.output,
      repository: c.options.repository,
      tag: c.options.tag,
      targets: c.options.target,
      version: c.options.version,
    })
  },
})
