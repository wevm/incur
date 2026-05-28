import { Client, Resources } from 'incur/client'
import { expectTypeOf, test } from 'vitest'

type Commands = {
  'project report': { args: {}; options: {}; output: {} }
  'project deploy': { args: {}; options: {}; output: {} }
  'auth login': { args: {}; options: {}; output: {} }
}

test('resources conditional types preserve structured and rendered formats', () => {
  expectTypeOf<Resources.Result<{ commands: [] }, undefined>>().toEqualTypeOf<{ commands: [] }>()
  expectTypeOf<Resources.Result<{ commands: [] }, 'json'>>().toEqualTypeOf<{ commands: [] }>()
  expectTypeOf<Resources.Result<{ commands: [] }, 'md'>>().toEqualTypeOf<string>()
  expectTypeOf<Resources.Result<{ commands: [] }, 'yaml'>>().toEqualTypeOf<string>()
  expectTypeOf<Resources.Result<{ commands: [] }, 'jsonl'>>().toEqualTypeOf<string>()
  expectTypeOf<Resources.Result<{ commands: [] }, 'toon'>>().toEqualTypeOf<string>()
  expectTypeOf<Resources.Result<{ commands: [] }, 'md' | undefined>>().toEqualTypeOf<
    string | { commands: [] }
  >()
})

test('resources scopes narrow command names and reject invalid scopes', () => {
  expectTypeOf<Client.CommandScope<Commands>>().toEqualTypeOf<
    'auth' | 'auth login' | 'project' | 'project deploy' | 'project report'
  >()
  expectTypeOf<Resources.LlmsCommand<Commands>['name']>().toEqualTypeOf<keyof Commands>()
  expectTypeOf<Resources.LlmsCommand<Commands, 'project'>['name']>().toEqualTypeOf<
    'project deploy' | 'project report'
  >()
  expectTypeOf<
    Resources.LlmsCommand<Commands, 'project report'>['name']
  >().toEqualTypeOf<'project report'>()

  const client = undefined as unknown as Resources.Actions<Commands>
  client.schema('project')
  client.help('project report')
  client.llms({ command: 'auth', format: 'yaml' })
  // @ts-expect-error invalid resources scope.
  client.schema('missing')
  // @ts-expect-error invalid resources scope.
  client.help('project missing')
  // @ts-expect-error invalid llms format.
  client.llms({ format: 'html' })
})

test('resources request and response unions enforce resource-specific fields', () => {
  const skill = { resource: 'skill', name: 'deploy' } satisfies Resources.Request
  const openapi = { resource: 'openapi', format: 'yaml' } satisfies Resources.Request
  const body = { contentType: 'text/plain', body: 'ok' } satisfies Resources.Response
  const data = { contentType: 'application/json', data: { ok: true } } satisfies Resources.Response

  expectTypeOf(skill.resource).toEqualTypeOf<'skill'>()
  expectTypeOf(openapi.format).toEqualTypeOf<'yaml'>()
  expectTypeOf(body.body).toEqualTypeOf<string>()
  expectTypeOf(data.data).toEqualTypeOf<{ ok: boolean }>()
  // @ts-expect-error skill requests require a name.
  const missingSkill = { resource: 'skill' } satisfies Resources.Request
  void missingSkill
  // @ts-expect-error openapi supports only json or yaml formats.
  const invalidOpenapi = { resource: 'openapi', format: 'md' } satisfies Resources.Request
  void invalidOpenapi
  // @ts-expect-error invalid resource names are rejected.
  const invalidResource = { resource: 'docs' } satisfies Resources.Request
  void invalidResource
})
