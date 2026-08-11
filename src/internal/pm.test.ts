import { detectPackageManager, detectRunner, globalInstall } from './pm.js'

test('detects pnpm from user agent', () => {
  const saved = process.env.npm_config_user_agent
  process.env.npm_config_user_agent = 'pnpm/10.0.0 node/v22.0.0'
  expect(detectRunner()).toBe('pnpx')
  process.env.npm_config_user_agent = saved
})

test('detects bun from user agent', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedExec = process.env.npm_execpath
  process.env.npm_config_user_agent = 'bun/1.0.0'
  delete process.env.npm_execpath
  expect(detectRunner()).toBe('bunx')
  process.env.npm_config_user_agent = savedAgent
  process.env.npm_execpath = savedExec
})

test('detects pnpm from exec path', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  process.env.npm_execpath = '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs'
  expect(detectRunner()).toBe('pnpx')
  process.env.npm_config_user_agent = savedAgent
  process.env.npm_execpath = savedExec
})

test('falls back to npx', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedArgv = process.argv[1]
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  delete process.env.npm_execpath
  process.argv[1] = '/usr/local/bin/my-cli'
  expect(detectRunner()).toBe('npx')
  process.env.npm_config_user_agent = savedAgent
  process.argv[1] = savedArgv!
  process.env.npm_execpath = savedExec
})

test('detects pnpm from the installed package path', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedArgv = process.argv[1]
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  delete process.env.npm_execpath
  process.argv[1] = '/Users/test/Library/pnpm/global/5/.pnpm/frog@1.0.0/node_modules/frog/bin.js'
  expect(detectPackageManager()).toBe('pnpm')
  process.env.npm_config_user_agent = savedAgent
  process.argv[1] = savedArgv!
  process.env.npm_execpath = savedExec
})

test('builds global install commands for the detected package manager', () => {
  const saved = process.env.npm_config_user_agent

  process.env.npm_config_user_agent = 'npm/11.0.0 node/v22.0.0'
  expect(globalInstall('frog')).toEqual({
    args: ['install', '--global', 'frog@latest'],
    command: 'npm',
  })

  process.env.npm_config_user_agent = 'pnpm/10.0.0 node/v22.0.0'
  expect(globalInstall('frog')).toEqual({
    args: ['add', '--global', 'frog@latest'],
    command: 'pnpm',
  })

  process.env.npm_config_user_agent = 'bun/1.0.0'
  expect(globalInstall('frog')).toEqual({
    args: ['add', '--global', 'frog@latest'],
    command: 'bun',
  })

  process.env.npm_config_user_agent = saved
})
