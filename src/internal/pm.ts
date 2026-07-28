import * as fs from 'node:fs'

/** Detects the package manager from the current process environment and executable path. */
export function detectPackageManager(): 'bun' | 'npm' | 'pnpm' {
  const userAgent = process.env.npm_config_user_agent ?? ''
  const execPath = process.env.npm_execpath ?? ''
  const entry = (() => {
    if (!process.argv[1]) return ''
    try {
      return fs.realpathSync(process.argv[1])
    } catch {
      return process.argv[1]
    }
  })()
  if (userAgent.includes('pnpm')) return 'pnpm'
  if (userAgent.includes('bun')) return 'bun'
  if (userAgent.startsWith('npm/')) return 'npm'
  if (execPath.includes('pnpm')) return 'pnpm'
  if (execPath.includes('bun')) return 'bun'
  if (execPath.includes('npm')) return 'npm'
  if (entry.includes('/.pnpm/') || entry.includes('\\.pnpm\\')) return 'pnpm'
  if (entry.includes('/.bun/') || entry.includes('\\bun\\')) return 'bun'
  return 'npm'
}

/** Detects the package manager runner (`npx`, `pnpx`, `bunx`) from the current process. */
export function detectRunner(): string {
  const packageManager = detectPackageManager()
  if (packageManager === 'pnpm') return 'pnpx'
  if (packageManager === 'bun') return 'bunx'
  return 'npx'
}

/** Builds the package-manager-specific invocation for installing a package globally. */
export function globalInstall(name: string): globalInstall.Result {
  const packageManager = detectPackageManager()
  if (packageManager === 'pnpm')
    return { args: ['add', '--global', `${name}@latest`], command: 'pnpm' }
  if (packageManager === 'bun')
    return { args: ['add', '--global', `${name}@latest`], command: 'bun' }
  return { args: ['install', '--global', `${name}@latest`], command: 'npm' }
}

export declare namespace globalInstall {
  /** A package-manager command invocation. */
  type Result = {
    /** Command arguments. */
    args: string[]
    /** Package-manager executable. */
    command: string
  }
}
