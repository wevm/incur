#!/usr/bin/env node
import * as Cli from '../Cli.js'

const cli = Cli.create('incur', {
  description: 'CLI for incur',
  sync: {
    depth: 1,
    include: ['_root'],
    suggestions: ['build a cli with incur', 'generate incur types'],
  },
})

await cli.fs().serve()

export default cli
