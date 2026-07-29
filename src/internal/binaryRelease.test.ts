import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = join(import.meta.dirname, '..', '..', 'release', 'scripts', 'prepare-release.sh')
const uploadScript = join(import.meta.dirname, '..', '..', 'release', 'scripts', 'upload.sh')

let bin: string
let commit: string
let directory: string
let output: string
let repository: string
let state: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'incur-binary-release-'))
  bin = join(directory, 'bin')
  output = join(directory, 'output')
  repository = join(directory, 'repository')
  state = join(directory, 'state')
  await mkdir(bin)
  await mkdir(repository)
  await mkdir(state)
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ name: '@example/demo', version: '1.2.3' }),
  )
  await exec('git', ['init', '--quiet'], { cwd: repository })
  await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: repository })
  await exec('git', ['config', 'user.name', 'Test'], { cwd: repository })
  await exec('git', ['add', 'package.json'], { cwd: repository })
  await exec('git', ['commit', '--quiet', '--message', 'fixture'], { cwd: repository })
  commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()

  const gh = join(bin, 'gh')
  await writeFile(gh, fakeGh)
  await chmod(gh, 0o755)
})

afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

describe.skipIf(process.platform === 'win32')('prepare-release.sh', () => {
  test('uses the latest published release for the package version', async () => {
    await writeFile(join(state, 'tag-commit'), commit)
    await writeRelease({ draft: false })

    await run()

    await expect(outputs()).resolves.toEqual({
      commit,
      release_id: '17',
      release_tag: '@example/demo@1.2.3',
      version: '1.2.3',
    })
    await expect(calls()).resolves.toContainEqual(['api', 'repos/wevm/demo/releases/latest'])
    await expect(calls()).resolves.not.toContainEqual(expect.arrayContaining(['release', 'create']))
  })

  test('uses an explicit matching release tag', async () => {
    await writeFile(join(state, 'tag-commit'), commit)
    await writeRelease({ draft: true, tag: 'v1.2.3' })

    await run({ REQUESTED_RELEASE_TAG: 'v1.2.3' })

    await expect(outputs()).resolves.toMatchObject({
      commit,
      release_id: '17',
      release_tag: 'v1.2.3',
    })
    await expect(calls()).resolves.toContainEqual(['api', 'repos/wevm/demo/releases/tags/v1.2.3'])
  })

  test('resolves an existing tag instead of requiring the source commit', async () => {
    const taggedCommit = commit
    await writeFile(join(state, 'tag-commit'), taggedCommit)
    await writeRelease({ draft: false })
    await writeFile(join(repository, 'README.md'), 'fixture\n')
    await exec('git', ['add', 'README.md'], { cwd: repository })
    await exec('git', ['commit', '--quiet', '--message', 'new source'], { cwd: repository })

    await run()

    await expect(outputs()).resolves.toMatchObject({ commit: taggedCommit })
  })

  test('rejects a release for another package version', async () => {
    await writeFile(join(state, 'tag-commit'), commit)
    await writeRelease({ draft: false, tag: '@example/demo@1.2.4' })

    await expect(run()).rejects.toMatchObject({
      stderr: 'Release tag @example/demo@1.2.4 does not identify @example/demo 1.2.3.\n',
    })
  })

  test('rejects an immutable published release', async () => {
    await writeFile(join(state, 'tag-commit'), commit)
    await writeRelease({ draft: false, immutable: true })

    await expect(run()).rejects.toMatchObject({
      stderr: 'The published release is immutable and cannot accept binary assets.\n',
    })
    await expect(calls()).resolves.not.toContainEqual(expect.arrayContaining(['release', 'create']))
  })

  test('does not treat GitHub API failures as missing resources', async () => {
    await writeFile(join(state, 'release-error'), '')

    await expect(run()).rejects.toMatchObject({
      stderr: 'gh: Service Unavailable (HTTP 503)\n',
    })
    await expect(calls()).resolves.not.toContainEqual(expect.arrayContaining(['release', 'create']))
  })

  test('rejects pull request merge refs', async () => {
    await expect(run({ SOURCE_REF: 'refs/pull/12/merge' })).rejects.toMatchObject({
      stderr: 'Run binary releases from a trusted push or manual workflow, not a pull request.\n',
    })
    await expect(calls()).resolves.not.toContainEqual(expect.arrayContaining(['release', 'create']))
  })
})

describe.skipIf(process.platform === 'win32')('upload.sh', () => {
  test.each([
    { draft: true, state: 'draft' },
    { draft: false, state: 'published' },
  ])('appends assets without changing the $state release state', async ({ draft }) => {
    await writeFile(join(state, 'tag-commit'), commit)
    await writeRelease({ draft })
    const assets = await writeAssets()

    await runUpload()

    await expect(calls()).resolves.toContainEqual([
      'release',
      'upload',
      '@example/demo@1.2.3',
      ...assets,
      '--repo',
      'wevm/demo',
    ])
    await expect(calls()).resolves.not.toContainEqual(expect.arrayContaining(['release', 'edit']))
  })

  test('does not upload to a release that became immutable', async () => {
    await writeFile(join(state, 'tag-commit'), commit)
    await writeRelease({ draft: false, immutable: true })
    await writeAssets()

    await expect(runUpload()).rejects.toMatchObject({
      stderr: 'The release became immutable before upload.\n',
    })
    await expect(calls()).resolves.not.toContainEqual(expect.arrayContaining(['release', 'upload']))
  })
})

async function calls() {
  const value = await readFile(join(state, 'calls'), 'utf8')
  return value
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}

async function outputs() {
  const value = await readFile(output, 'utf8')
  return Object.fromEntries(
    value
      .trim()
      .split('\n')
      .map((line) => line.split('=', 2)),
  )
}

function run(env: NodeJS.ProcessEnv = {}) {
  return exec('bash', [script], {
    cwd: repository,
    env: {
      ...process.env,
      FAKE_GH_STATE: state,
      GH_TOKEN: 'test',
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'wevm/demo',
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      ...env,
    },
  })
}

function runUpload(env: NodeJS.ProcessEnv = {}) {
  return exec('bash', [uploadScript], {
    cwd: repository,
    env: {
      ...process.env,
      BINARY_NAME: 'demo',
      BINARY_OUTPUT: join(directory, 'assets'),
      EXPECTED_COMMIT: commit,
      EXPECTED_RELEASE_ID: '17',
      FAKE_GH_STATE: state,
      GH_TOKEN: 'test',
      GITHUB_REPOSITORY: 'wevm/demo',
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      RELEASE_TAG: '@example/demo@1.2.3',
      ...env,
    },
  })
}

async function writeAssets() {
  const directory_ = join(directory, 'assets')
  const names = [
    'demo-darwin-arm64.gz',
    'demo-darwin-x64.gz',
    'demo-linux-arm64-glibc.gz',
    'demo-linux-arm64-musl.gz',
    'demo-linux-x64-glibc-baseline.gz',
    'demo-linux-x64-musl-baseline.gz',
    'demo-windows-arm64.exe.gz',
    'demo-windows-x64-baseline.exe.gz',
    'SHA256SUMS',
    'install.ps1',
    'install.sh',
  ]
  await mkdir(directory_)
  await Promise.all(names.map((name) => writeFile(join(directory_, name), 'fixture')))
  return names.map((name) => join(directory_, name))
}

function writeRelease(options: {
  draft: boolean
  immutable?: boolean | undefined
  tag?: string | undefined
}) {
  return writeFile(
    join(state, 'release.json'),
    JSON.stringify({
      assets: [],
      draft: options.draft,
      id: 17,
      immutable: options.immutable ?? false,
      prerelease: false,
      tag_name: options.tag ?? '@example/demo@1.2.3',
    }),
  )
}

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const state = process.env.FAKE_GH_STATE
const calls = path.join(state, 'calls')
const release = path.join(state, 'release.json')
const tagCommit = path.join(state, 'tag-commit')

fs.appendFileSync(calls, JSON.stringify(args) + '\\n')

if (args[0] === 'api' && args[1] === 'repos/wevm/demo') {
  process.stdout.write('public\\n')
  process.exit(0)
}

if (
  args[0] === 'api' &&
  (args[1] === 'repos/wevm/demo/releases/latest' ||
    args[1].startsWith('repos/wevm/demo/releases/tags/'))
) {
  if (fs.existsSync(path.join(state, 'release-error'))) {
    process.stderr.write('gh: Service Unavailable (HTTP 503)\\n')
    process.exit(1)
  }
  if (!fs.existsSync(release)) {
    process.stderr.write('gh: Not Found (HTTP 404)\\n')
    process.exit(1)
  }
  const value = JSON.parse(fs.readFileSync(release, 'utf8'))
  if (
    args[1].startsWith('repos/wevm/demo/releases/tags/') &&
    args[1].slice('repos/wevm/demo/releases/tags/'.length) !== value.tag_name
  ) {
    process.stderr.write('gh: Not Found (HTTP 404)\\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(value) + '\\n')
  process.exit(0)
}

if (args[0] === 'api' && args[1].startsWith('repos/wevm/demo/git/ref/tags/')) {
  if (fs.existsSync(path.join(state, 'tag-error'))) {
    process.stderr.write('gh: Service Unavailable (HTTP 503)\\n')
    process.exit(1)
  }
  if (!fs.existsSync(tagCommit)) {
    process.stderr.write('gh: Not Found (HTTP 404)\\n')
    process.exit(1)
  }
  process.stdout.write('{}\\n')
  process.exit(0)
}

if (args[0] === 'api' && args[1].startsWith('repos/wevm/demo/commits/')) {
  if (!fs.existsSync(tagCommit)) process.exit(1)
  process.stdout.write(fs.readFileSync(tagCommit, 'utf8') + '\\n')
  process.exit(0)
}

if (args[0] === 'release' && args[1] === 'upload') process.exit(0)

process.stderr.write('Unexpected gh call: ' + JSON.stringify(args) + '\\n')
process.exit(1)
`
