import { Local } from 'incur/client'
import { expectTypeOf, test } from 'vitest'

test('local methods expose precise option and result types', async () => {
  const local = undefined as unknown as Local.Methods

  expectTypeOf(await local.skills.add()).toEqualTypeOf<Local.SyncedSkills>()
  expectTypeOf(await local.skills.list()).toEqualTypeOf<Local.SkillsList>()
  expectTypeOf(await local.mcp.add()).toEqualTypeOf<Local.McpRegistration>()

  await local.skills.add({ depth: 2, global: undefined })
  await local.skills.list({ depth: undefined })
  await local.mcp.add({ agents: ['codex'], command: undefined, global: false })
  // @ts-expect-error depth must be a number.
  await local.skills.add({ depth: '2' })
  // @ts-expect-error global must be a boolean.
  await local.skills.add({ global: 'yes' })
  // @ts-expect-error agents must be an array of strings.
  await local.mcp.add({ agents: [1] })
  // @ts-expect-error command must be a string.
  await local.mcp.add({ command: 123 })
  // @ts-expect-error extra option keys are rejected.
  await local.skills.list({ depth: 1, extra: true })
})
