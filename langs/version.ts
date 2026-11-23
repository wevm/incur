/**
 * Keeps every language port on the TypeScript package's version. Writes the version from
 * `package.json` into each port's manifest, lockfile, and install instructions, or with `--check`
 * fails when any of them differs.
 *
 * Usage: `node langs/version.ts [--check]` from the repository root. `changeset:version` runs it.
 */
import * as fs from 'node:fs'

const check = process.argv.includes('--check')
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }

/** Each file and the patterns whose single capture group holds a version. */
const targets: [file: string, patterns: RegExp[]][] = [
  [
    'langs/rust/Cargo.toml',
    [
      /\[workspace\.package\][^[]*?\nversion = "([^"]+)"/,
      /incur-macros = \{[^}]*version = "=([^"]+)"/,
    ],
  ],
  [
    'langs/rust/Cargo.lock',
    [/\nname = "incur"\nversion = "([^"]+)"/, /\nname = "incur-macros"\nversion = "([^"]+)"/],
  ],
  ['langs/python/pyproject.toml', [/\[project\][^[]*?\nversion = "([^"]+)"/]],
  ['langs/python/uv.lock', [/\nname = "incur"\nversion = "([^"]+)"/]],
  ['langs/zig/build.zig.zon', [/\n {4}\.version = "([^"]+)"/]],
  ['langs/zig/README.md', [/download\/incur@([^/]+)\//, /incur-zig-([^/]+)\.tar\.gz/]],
]

const stale: string[] = []
for (const [file, patterns] of targets) {
  let text = fs.readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (!match) throw new Error(`${file}: no version matches ${pattern}`)
    if (match[1] === version) continue
    stale.push(`${file}: ${match[1]}`)
    const start = match.index + match[0].lastIndexOf(match[1]!)
    text = text.slice(0, start) + version + text.slice(start + match[1]!.length)
  }
  if (!check) fs.writeFileSync(file, text)
}

if (check && stale.length > 0) {
  console.error(
    `Language port versions differ from package.json (${version}):\n${stale.join('\n')}`,
  )
  console.error('Run `node langs/version.ts` to align them.')
  process.exit(1)
}
