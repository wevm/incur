import { detectRunner } from './pm.js'

test('detects pnpm from user agent', () => {
  const saved = process.env.npm_config_user_agent
  process.env.npm_config_user_agent = 'pnpm/10.0.0 node/v22.0.0'
  expect(detectRunner()).toBe('pnpm dlx')
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
  expect(detectRunner()).toBe('pnpm dlx')
  process.env.npm_config_user_agent = savedAgent
  process.env.npm_execpath = savedExec
})

test('falls back to npx', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  delete process.env.npm_execpath
  expect(detectRunner()).toBe('npx')
  process.env.npm_config_user_agent = savedAgent
  process.env.npm_execpath = savedExec
})
