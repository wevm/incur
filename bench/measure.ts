import { encode as toonEncode } from '@toon-format/toon'
import { encodingForModel } from 'js-tiktoken'
import fs from 'node:fs/promises'
import path from 'node:path'

import { Cli, Help, Schema, Skill } from '../src/index.js'
import cli from './cli.js'

const enc = encodingForModel('gpt-4o')

function countTokens(text: string): number {
  return enc.encode(text).length
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// ── Command tree traversal ───────────────────────────────────────────────────

type CommandEntry = any

function isGroup(entry: CommandEntry): boolean {
  return '_group' in entry && entry._group
}

function collectLeaves(
  commands: Map<string, CommandEntry>,
  prefix: string[],
): { path: string[]; entry: CommandEntry }[] {
  const result: { path: string[]; entry: CommandEntry }[] = []
  for (const [name, entry] of commands) {
    const p = [...prefix, name]
    if (isGroup(entry)) result.push(...collectLeaves(entry.commands, p))
    else result.push({ path: p, entry })
  }
  return result
}

function collectSkillCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
  groups: Map<string, string>,
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  for (const [name, entry] of commands) {
    const p = [...prefix, name]
    if (isGroup(entry)) {
      if (entry.description) groups.set(p.join(' '), entry.description)
      result.push(...collectSkillCommands(entry.commands, p, groups))
    } else {
      const cmd: Skill.CommandInfo = { name: p.join(' ') }
      if (entry.description) cmd.description = entry.description
      if (entry.args) cmd.args = entry.args
      if (entry.env) cmd.env = entry.env
      if (entry.options) cmd.options = entry.options
      if (entry.output) cmd.output = entry.output
      if (entry.examples) cmd.examples = entry.examples
      result.push(cmd)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

// ── A: MCP measurement ──────────────────────────────────────────────────────

function buildToolSchema(entry: CommandEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const schema of [entry.args, entry.options]) {
    if (!schema) continue
    const json = Schema.toJsonSchema(schema)
    Object.assign(properties, (json.properties as any) ?? {})
    required.push(...((json.required as string[]) ?? []))
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

function measureMcp(commands: Map<string, CommandEntry>) {
  const leaves = collectLeaves(commands, [])
  const tools = leaves.map(({ path: p, entry }) => ({
    name: p.join('_'),
    ...(entry.description ? { description: entry.description } : {}),
    inputSchema: buildToolSchema(entry),
  }))

  const perCommand: Record<string, number> = {}
  for (const tool of tools) perCommand[tool.name] = countTokens(JSON.stringify(tool))

  const sessionStart = countTokens(JSON.stringify(tools))
  const perCall = countTokens(
    '{"name":"compute_instance_create","arguments":{"name":"web-1","zone":"us-east1-b"}}',
  )
  const perResponseEnvelope = countTokens(
    '{"type":"tool_result","tool_use_id":"toolu_01A09q90qw90lq917835lq9"}',
  )

  return { sessionStart, perCall, perResponseEnvelope, perCommand, toolCount: tools.length }
}

// ── B: One-file Skill measurement ───────────────────────────────────────────

function measureOneFileSkill(commands: Map<string, CommandEntry>, cliName: string) {
  const groups = new Map<string, string>()
  const cmds = collectSkillCommands(commands, [], groups)
  const files = Skill.split(cliName, cmds, 0, groups)
  const content = files[0]!.content
  const end = content.indexOf('\n---', 4)
  const listing = countTokens(end === -1 ? content : content.slice(0, end + 4))
  const discovery = countTokens(content)
  const perCall = countTokens(`cloud compute instance create web-1 --zone us-east1-b`)
  return { listing, discovery, perCall, content }
}

// ── C: incur measurement ────────────────────────────────────────────────────

function measureIncur(commands: Map<string, CommandEntry>, cliName: string) {
  const groups = new Map<string, string>()
  const cmds = collectSkillCommands(commands, [], groups)
  const files = Skill.split(cliName, cmds, 1, groups)

  let listing = 0
  for (const file of files) {
    const end = file.content.indexOf('\n---', 4)
    const fm = end === -1 ? file.content : file.content.slice(0, end + 4)
    listing += countTokens(fm)
  }

  const perHelp: Record<string, number> = {}
  for (const cmd of cmds) {
    const help = Help.formatCommand(`${cliName} ${cmd.name}`, cmd)
    perHelp[cmd.name] = countTokens(help)
  }
  const helpValues = Object.values(perHelp)
  const helpAvg = Math.round(helpValues.reduce((a, b) => a + b, 0) / helpValues.length)

  const perCall = countTokens(`cloud compute instance create web-1 --zone us-east1-b`)

  return { listing, perCall, perHelp, helpAvg, files }
}

// ── Output format measurement ────────────────────────────────────────────────

function generateFixtures(): { name: string; data: Record<string, unknown> }[] {
  return [
    {
      name: 'instance-list (25 rows)',
      data: {
        instances: Array.from({ length: 25 }, (_, i) => ({
          name: `web-server-${i + 1}`,
          zone: ['us-east1-b', 'us-west1-a', 'eu-west1-c', 'asia-east1-a'][i % 4],
          machineType: ['e2-medium', 'n1-standard-4', 'e2-small', 'n2-standard-8'][i % 4],
          status: ['RUNNING', 'RUNNING', 'STOPPED', 'RUNNING'][i % 4],
          networkIP: `10.0.${i}.2`,
          createdAt: `2025-0${(i % 9) + 1}-15T08:30:00Z`,
        })),
        nextPageToken: 'eyJwYWdlIjogMn0=',
      },
    },
    {
      name: 'instance-create (nested)',
      data: {
        id: '8847291053',
        name: 'api-gateway-prod',
        status: 'RUNNING',
        zone: 'us-east1-b',
        machineType: 'n2-standard-8',
        createdAt: '2025-06-15T14:22:10Z',
        disks: [
          { name: 'boot', sizeGb: 50, type: 'pd-ssd', boot: true },
          { name: 'data-vol', sizeGb: 500, type: 'pd-balanced', boot: false },
        ],
        networkInterfaces: [
          {
            network: 'production-vpc',
            networkIP: '10.128.0.15',
            accessConfigs: [{ type: 'ONE_TO_ONE_NAT', natIP: '34.75.22.119' }],
          },
          { network: 'internal-vpc', networkIP: '10.200.0.8', accessConfigs: [] },
        ],
        labels: {
          environment: 'production',
          team: 'platform',
          service: 'api-gateway',
          cost_center: 'eng-infra',
        },
        metadata: {
          'startup-script':
            '#!/bin/bash\napt-get update && apt-get install -y nginx\nsystemctl start nginx',
          'enable-oslogin': 'true',
        },
      },
    },
    {
      name: 'service-list (50 rows)',
      data: {
        services: Array.from({ length: 50 }, (_, i) => ({
          name: `svc-${['auth', 'api', 'web', 'worker', 'cron', 'cache', 'search', 'notify', 'billing', 'analytics'][i % 10]}-${Math.floor(i / 10) + 1}`,
          environment: ['production', 'staging', 'dev'][i % 3],
          region: ['us-east1', 'eu-west1', 'asia-east1'][i % 3],
          status: ['SERVING', 'SERVING', 'SERVING', 'DEPLOYING', 'SERVING'][i % 5],
          replicas: [3, 2, 1, 5, 4][i % 5],
          image: `gcr.io/myproject/svc:v${Math.floor(i / 5) + 1}.${i % 5}.0`,
          cpu: ['500m', '1', '250m', '2', '1'][i % 5],
          memory: ['512Mi', '1Gi', '256Mi', '2Gi', '1Gi'][i % 5],
          url: `https://svc-${i + 1}.run.app`,
          lastDeployed: `2025-06-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:30:00Z`,
        })),
      },
    },
    {
      name: 'db-instance-create (deep nested)',
      data: {
        name: 'analytics-primary',
        engine: 'postgres',
        version: '16.2',
        tier: 'db-highmem-8',
        region: 'us-east1',
        status: 'RUNNING',
        connectionName: 'myproject:us-east1:analytics-primary',
        ipAddresses: [
          { type: 'PRIMARY', address: '10.128.5.20' },
          { type: 'OUTGOING', address: '34.75.100.55' },
        ],
        settings: {
          backupEnabled: true,
          backupWindow: '03:00-04:00',
          maintenanceWindow: 'Sun:05:00',
          storageGb: 1000,
          ha: true,
          flags: {
            max_connections: '500',
            shared_buffers: '4GB',
            effective_cache_size: '12GB',
            work_mem: '256MB',
            maintenance_work_mem: '1GB',
            random_page_cost: '1.1',
            log_min_duration_statement: '200',
          },
        },
        replicas: [
          {
            name: 'analytics-read-1',
            region: 'us-west1',
            tier: 'db-standard-4',
            status: 'RUNNING',
            lag: '0.2s',
          },
          {
            name: 'analytics-read-2',
            region: 'eu-west1',
            tier: 'db-standard-4',
            status: 'RUNNING',
            lag: '45ms',
          },
          {
            name: 'analytics-read-3',
            region: 'asia-east1',
            tier: 'db-standard-2',
            status: 'RUNNING',
            lag: '120ms',
          },
        ],
        users: [
          { name: 'admin', role: 'cloudsqlsuperuser', databases: ['analytics', 'staging'] },
          { name: 'app_read', role: 'reader', databases: ['analytics'] },
          { name: 'app_write', role: 'writer', databases: ['analytics'] },
          { name: 'etl_service', role: 'writer', databases: ['analytics', 'staging'] },
        ],
        createdAt: '2025-01-10T09:15:00Z',
      },
    },
  ]
}

function measureOutput() {
  const fixtures = generateFixtures()
  const results: { name: string; json: number; toon: number; jsonStr: string; toonStr: string }[] =
    []
  for (const { name, data } of fixtures) {
    const jsonStr = JSON.stringify(data, null, 2)
    const toonStr = toonEncode(data)
    results.push({ name, json: countTokens(jsonStr), toon: countTokens(toonStr), jsonStr, toonStr })
  }
  return results
}

// ── Report generation ────────────────────────────────────────────────────────

async function main() {
  const commands = Cli.toCommands.get(cli as any)!
  const cliName = cli.name

  const groups = new Map<string, string>()
  const cmds = collectSkillCommands(commands, [], groups)

  const mcp = measureMcp(commands)
  const oneFile = measureOneFileSkill(commands, cliName)
  const incur = measureIncur(commands, cliName)
  const output = measureOutput()

  const totalCommands = mcp.toolCount
  const INPUT_PRICE = 1.75 / 1_000_000
  const OUTPUT_PRICE = 14 / 1_000_000

  let totalJsonOut = 0
  let totalToonOut = 0
  for (const o of output) {
    totalJsonOut += o.json
    totalToonOut += o.toon
  }
  const avgJsonResponse = Math.round(totalJsonOut / output.length)
  const avgToonResponse = Math.round(totalToonOut / output.length)

  // ── Scenario computation ────────────────────────────────────────────

  const callsPerSession = 5
  const uniqueCmds = 3

  const bkA = {
    session: mcp.sessionStart,
    discovery: 0,
    invocation: callsPerSession * mcp.perCall,
    response: callsPerSession * (avgJsonResponse + mcp.perResponseEnvelope),
  }
  const bkB = {
    session: oneFile.listing,
    discovery: oneFile.discovery,
    invocation: callsPerSession * oneFile.perCall,
    response: callsPerSession * avgJsonResponse,
  }
  const bkC = {
    session: incur.listing,
    discovery: uniqueCmds * incur.helpAvg,
    invocation: callsPerSession * incur.perCall,
    response: callsPerSession * avgToonResponse,
  }

  // Session start, discovery, response = input tokens; invocation = output tokens
  const cost = (bk: typeof bkA) =>
    (bk.session + bk.discovery + bk.response) * INPUT_PRICE + bk.invocation * OUTPUT_PRICE
  const costA = cost(bkA)
  const costB = cost(bkB)
  const costC = cost(bkC)
  const usd4 = (n: number) => `$${n.toFixed(4)}`

  // ── Helpers ────────────────────────────────────────────────────────────

  const truncate = (text: string, max: number) => {
    const ls = text.split('\n')
    if (ls.length <= max) return text
    return ls.slice(0, max).join('\n') + `\n… (${ls.length - max} more lines)`
  }

  function renderTable(headers: string[], rows: string[][], separators: number[] = []): string[] {
    const cols = headers.length
    const widths = Array.from({ length: cols }, (_, i) =>
      Math.max(headers[i]!.length, ...rows.map((r) => r[i]!.length)),
    )
    const hr = (l: string, m: string, r: string) =>
      l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r
    const fmtRow = (cells: string[]) =>
      '│' +
      cells
        .map((c, i) => (i === 0 ? ` ${c.padEnd(widths[i]!)} ` : ` ${c.padStart(widths[i]!)} `))
        .join('│') +
      '│'

    const result = [hr('┌', '┬', '┐'), fmtRow(headers), hr('├', '┼', '┤')]
    for (let i = 0; i < rows.length; i++) {
      result.push(fmtRow(rows[i]!))
      if (separators.includes(i)) result.push(hr('├', '┼', '┤'))
    }
    result.push(hr('└', '┴', '┘'))
    return result
  }

  function renderSnippet(text: string, maxLines: number, maxLineLen = 120): string[] {
    const content = truncate(text, maxLines)
    const result = ['┌─']
    for (const line of content.split('\n')) {
      const trimmed = line.length > maxLineLen ? line.slice(0, maxLineLen) + '…' : line
      result.push(`│  ${trimmed}`)
    }
    result.push('└─')
    return result
  }

  // ── Build report ───────────────────────────────────────────────────────

  const lines: string[] = []
  const out = (s: string) => lines.push(s)

  // Title
  out(`# clac · Token Cost Benchmark`)
  out('')
  out(`> ${totalCommands} commands · GPT-5.3 Codex · $1.75/1M input · $14/1M output`)
  out('')

  // Per-session breakdown
  out(`## Per-Session Breakdown (${callsPerSession} calls, ${uniqueCmds} unique commands)`)
  out('')
  out('```')

  const pct = (...vals: number[]) => {
    const max = Math.max(...vals)
    const min = vals[vals.length - 1]!
    if (max === 0 || min === 0) return '—'
    if (min === max) return '—'
    return `↓${(max / min).toFixed(1)}×`
  }
  const hdr = ['', 'MCP + JSON', 'One Skill + JSON', 'incur', 'incur vs best']
  for (const l of renderTable(
    hdr,
    [
      [
        'Session start',
        fmt(bkA.session),
        fmt(bkB.session),
        fmt(bkC.session),
        pct(bkA.session, bkB.session, bkC.session),
      ],
      [
        'Discovery',
        fmt(bkA.discovery),
        fmt(bkB.discovery),
        fmt(bkC.discovery),
        pct(bkA.discovery, bkB.discovery, bkC.discovery),
      ],
      [
        `Invocation (×${callsPerSession})`,
        fmt(bkA.invocation),
        fmt(bkB.invocation),
        fmt(bkC.invocation),
        pct(bkA.invocation, bkB.invocation, bkC.invocation),
      ],
      [
        `Response (×${callsPerSession})`,
        fmt(bkA.response),
        fmt(bkB.response),
        fmt(bkC.response),
        pct(bkA.response, bkB.response, bkC.response),
      ],
      ['Cost', usd4(costA), usd4(costB), usd4(costC), pct(costA, costB, costC)],
    ],
    [3],
  ))
    out(l)
  out('```')
  out('')

  // ── Token Examples ──────────────────────────────────────────────────

  // Session start (input)
  out('## Session Start (input tokens)')
  out('')

  const mcpJson = JSON.stringify(
    collectLeaves(commands, []).map(({ path: p, entry }) => ({
      name: p.join('_'),
      ...(entry.description ? { description: entry.description } : {}),
      inputSchema: buildToolSchema(entry),
    })),
    null,
    2,
  )
  out(
    `**MCP** — ${fmt(mcp.sessionStart)} tokens (JSON tool schemas, all ${totalCommands} commands)`,
  )
  out('')
  for (const l of renderSnippet(mcpJson, 6)) out(l)
  out('')

  const oneFileFm = (() => {
    const end = oneFile.content.indexOf('\n---', 4)
    return end === -1 ? oneFile.content : oneFile.content.slice(0, end + 4)
  })()
  out(`**One Skill** — ${fmt(oneFile.listing)} tokens (frontmatter, 1 file)`)
  out('')
  for (const l of renderSnippet(oneFileFm, 6)) out(l)
  out('')

  const fmOnly = incur.files
    .map((f) => {
      const end = f.content.indexOf('\n---', 4)
      return end === -1 ? f.content : f.content.slice(0, end + 4)
    })
    .join('\n\n')
  out(`**incur** — ${fmt(incur.listing)} tokens (frontmatter, ${incur.files.length} files)`)
  out('')
  for (const l of renderSnippet(fmOnly, 6)) out(l)
  out('')

  // Discovery (input)
  out('## Discovery (input tokens)')
  out('')

  out(`**MCP** — 0 tokens (all schemas loaded at session start)`)
  out('')

  out(
    `**One Skill** — ${fmt(oneFile.discovery)} tokens (reads full markdown, all ${totalCommands} commands)`,
  )
  out('')
  for (const l of renderSnippet(oneFile.content, 6)) out(l)
  out('')

  const sampleHelp = Help.formatCommand(`${cliName} ${cmds[0]!.name}`, cmds[0]!)
  out(`**incur** — ~${fmt(incur.helpAvg)} tokens avg (runs \`--help\` per unique command)`)
  out('')
  for (const l of renderSnippet(sampleHelp, 8)) out(l)
  out('')

  // Invocation (output)
  out('## Invocation (output tokens)')
  out('')

  const mcpCall =
    '{"name":"compute_instance_create","arguments":{"name":"web-1","zone":"us-east1-b"}}'
  const cliCall = 'cloud compute instance-create web-1 --zone us-east1-b'
  out(`**MCP** — ${fmt(mcp.perCall)} tokens (JSON tool call)`)
  out('')
  for (const l of renderSnippet(mcpCall, 1)) out(l)
  out('')

  out(`**One Skill / incur** — ${fmt(incur.perCall)} tokens (plain text)`)
  out('')
  for (const l of renderSnippet(cliCall, 1)) out(l)
  out('')

  // Response (input)
  const sampleOut = output[0]!
  const pctSmaller = Math.round(((sampleOut.json - sampleOut.toon) / sampleOut.json) * 100)
  out(`## Response (input tokens) — ${sampleOut.name}`)
  out('')

  out(`**MCP / One Skill** — ${fmt(sampleOut.json)} tokens (JSON)`)
  out('')
  for (const l of renderSnippet(sampleOut.jsonStr, 8)) out(l)
  out('')

  out(`**incur** — ${fmt(sampleOut.toon)} tokens (TOON, ↓${pctSmaller}%)`)
  out('')
  for (const l of renderSnippet(sampleOut.toonStr, 8)) out(l)
  out('')

  // ── Write output ──────────────────────────────────────────────────────

  const report = lines.join('\n') + '\n'
  process.stdout.write(report)

  const resultsDir = path.join(import.meta.dirname!, 'results')
  await fs.mkdir(resultsDir, { recursive: true })
  await fs.writeFile(path.join(resultsDir, 'report.md'), report)
  await fs.writeFile(
    path.join(resultsDir, 'data.json'),
    JSON.stringify(
      {
        config: {
          commands: totalCommands,
          model: 'gpt-5.3-codex',
          inputPrice: 1.75,
          outputPrice: 14,
        },
        mcp: { sessionStart: mcp.sessionStart, perCall: mcp.perCall, perCommand: mcp.perCommand },
        oneFileSkill: {
          listing: oneFile.listing,
          discovery: oneFile.discovery,
          perCall: oneFile.perCall,
        },
        incur: { listing: incur.listing, helpAvg: incur.helpAvg, perCall: incur.perCall },
        output: output.map((o) => ({ name: o.name, json: o.json, toon: o.toon })),
      },
      null,
      2,
    ) + '\n',
  )
}

main()
