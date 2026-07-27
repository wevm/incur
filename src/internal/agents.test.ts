import { mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Agents from './agents.js'

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'clac-agents-'))
  const source = join(dir, 'source')
  mkdirSync(join(source, 'demo'), { recursive: true })
  writeFileSync(join(source, 'demo', 'SKILL.md'), 'name: demo\ndescription: d\n')
  return { dir, source }
}

const claude: Agents.Agent = {
  name: 'Claude Code',
  globalSkillsDir: '/unused',
  projectSkillsDir: '.claude/skills',
  universal: false,
  detect: () => true,
}

test('installs a skill as a real directory', () => {
  const { dir, source } = scaffold()

  Agents.install(source, { global: false, cwd: dir, agents: [claude] })

  const installed = join(dir, '.agents', 'skills', 'demo')
  expect(lstatSync(installed).isDirectory()).toBe(true)
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('name: demo')

  rmSync(dir, { recursive: true, force: true })
})

// An agent whose skills directory is a symlink to the canonical one names the same directory by a
// different path. Comparing the two as strings let the agent pass delete the skill just written and
// replace it with a link pointing at itself.
test('an agent directory aliased to the canonical one is left alone', () => {
  const { dir, source } = scaffold()
  const canonical = join(dir, '.agents', 'skills')
  mkdirSync(canonical, { recursive: true })
  mkdirSync(join(dir, '.claude'), { recursive: true })
  symlinkSync(canonical, join(dir, '.claude', 'skills'))

  // Something unrelated already living there must survive.
  mkdirSync(join(canonical, 'existing'), { recursive: true })
  writeFileSync(join(canonical, 'existing', 'SKILL.md'), 'name: existing\n')

  Agents.install(source, { global: false, cwd: dir, agents: [claude] })

  const installed = join(canonical, 'demo')
  expect(lstatSync(installed).isSymbolicLink()).toBe(false)
  expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('name: demo')
  expect(readFileSync(join(canonical, 'existing', 'SKILL.md'), 'utf8')).toContain('name: existing')

  rmSync(dir, { recursive: true, force: true })
})
