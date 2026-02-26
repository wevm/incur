import { Cli, z } from 'clac'

const cli = Cli.create('npm', {
  version: '10.9.2',
  description: 'The package manager for JavaScript.',
  sync: {
    suggestions: [
      'install react as a dependency',
      'check for outdated packages',
      'audit my repo',
    ]
  }
})

cli.command('install', {
  description: 'Install a package',
  args: z.object({
    package: z.string().optional().describe('Package name to install'),
  }),
  options: z.object({
    saveDev: z.boolean().optional().describe('Save as dev dependency'),
    saveExact: z.boolean().optional().describe('Save exact version'),
    global: z.boolean().optional().describe('Install globally'),
  }),
  alias: { saveDev: 'D', global: 'g', saveExact: 'E' },
  output: z.object({
    added: z.number().describe('Number of packages added'),
    removed: z.number().describe('Number of packages removed'),
    changed: z.number().describe('Number of packages changed'),
    packages: z.number().describe('Total packages in node_modules'),
  }),
  examples: [
    { args: { package: 'express' }, description: 'Install a package' },
    {
      args: { package: 'vitest' },
      options: { saveDev: true },
      description: 'Install as dev dependency',
    },
    { options: { global: true }, args: { package: 'tsx' }, description: 'Install globally' },
  ],
  run({ args }) {
    if (!args.package) return { added: 120, removed: 0, changed: 0, packages: 450 }
    return { added: 1, removed: 0, changed: 0, packages: 451 }
  },
})

cli.command('info', {
  description: 'View registry info for a package',
  args: z.object({
    package: z.string().describe('Package name'),
  }),
  output: z.object({
    name: z.string(),
    version: z.string().describe('Latest version'),
    description: z.string(),
    license: z.string(),
    homepage: z.string(),
  }),
  examples: [{ args: { package: 'express' }, description: 'View info for express' }],
  run({ args }) {
    return {
      name: args.package,
      version: '4.21.2',
      description: 'Fast, unopinionated, minimalist web framework',
      license: 'MIT',
      homepage: 'https://expressjs.com/',
    }
  },
})

cli.command('init', {
  description: 'Create a package.json file',
  options: z.object({
    yes: z.boolean().describe('Skip prompts and use defaults'),
    scope: z.string().optional().describe('Package scope'),
  }),
  alias: { yes: 'y' },
  output: z.object({
    created: z.string().describe('Path to created package.json'),
  }),
  examples: [{ options: { yes: true }, description: 'Create with defaults' }],
  run() {
    return { created: './package.json' }
  },
})

cli.command('publish', {
  description: 'Publish a package to the registry',
  env: z.object({
    NPM_TOKEN: z.string().optional().describe('Authentication token'),
    NPM_REGISTRY: z.string().default('https://registry.npmjs.org').describe('Registry URL'),
  }),
  options: z.object({
    tag: z.string().default('latest').describe('Distribution tag'),
    access: z.enum(['public', 'restricted']).default('public').describe('Package access level'),
    dryRun: z.boolean().describe('Report what would be published'),
    otp: z.string().optional().describe('One-time password for 2FA'),
  }),
  output: z.object({
    name: z.string(),
    version: z.string(),
    tag: z.string(),
  }),
  examples: [
    { description: 'Publish with latest tag' },
    { options: { tag: 'beta' }, description: 'Publish as beta' },
    { options: { dryRun: true }, description: 'Dry run' },
  ],
  run({ options }) {
    return { name: 'my-package', version: '1.0.0', tag: options.tag }
  },
})

cli.command('run', {
  description: 'Run a script defined in package.json',
  args: z.object({
    script: z.string().describe('Script name to run'),
  }),
  output: z.object({
    script: z.string(),
    exitCode: z.number(),
  }),
  examples: [
    { args: { script: 'test' }, description: 'Run tests' },
    { args: { script: 'build' }, description: 'Run build' },
  ],
  run({ args }) {
    return { script: args.script, exitCode: 0 }
  },
})

cli.command('uninstall', {
  description: 'Remove a package',
  args: z.object({
    package: z.string().describe('Package name to remove'),
  }),
  options: z.object({
    global: z.boolean().describe('Remove global package'),
  }),
  alias: { global: 'g' },
  output: z.object({
    removed: z.number(),
    packages: z.number().describe('Remaining packages'),
  }),
  examples: [{ args: { package: 'express' }, description: 'Remove a package' }],
  run() {
    return { removed: 1, packages: 449 }
  },
})

cli.command('outdated', {
  description: 'Check for outdated packages',
  options: z.object({
    global: z.boolean().describe('Check global packages'),
    long: z.boolean().describe('Show extended information'),
  }),
  alias: { global: 'g', long: 'l' },
  output: z.object({
    packages: z.array(
      z.object({
        name: z.string(),
        current: z.string(),
        wanted: z.string(),
        latest: z.string(),
      }),
    ),
  }),
  examples: [
    { description: 'Check for outdated packages' },
    { options: { global: true }, description: 'Check global packages' },
  ],
  run() {
    return {
      packages: [
        { name: 'express', current: '4.18.0', wanted: '4.21.2', latest: '4.21.2' },
        { name: 'typescript', current: '5.3.0', wanted: '5.7.3', latest: '5.7.3' },
      ],
    }
  },
})

cli.serve()

export default cli
