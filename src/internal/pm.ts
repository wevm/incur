import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

/**
 * Runs a package-manager command and resolves with its stdout. A failure rejects with the
 * command's trimmed stderr, else its stdout, else the spawn error.
 *
 * On Windows, npm, npx, pnpm, and pnpx are `.cmd` scripts that `execFile` cannot launch, so a
 * script found on `PATH` runs through `cmd.exe` with its arguments quoted the way Rust's and
 * Zig's standard libraries quote batch file arguments.
 */
export function exec(command: string, args: string[]): Promise<string> {
  const script = process.platform === 'win32' ? which(command) : undefined
  // Off Windows, or a command that is not on `PATH`: spawn it as is.
  if (!script) return execFile(command, args)
  // A native executable, such as `bun.exe`.
  if (!/\.(?:bat|cmd)$/i.test(script)) return execFile(script, args)
  // `cmd.exe` ends the command line at a line break, which would drop the arguments after it.
  if (args.some((arg) => /[\r\n]/.test(arg)))
    return Promise.reject(new Error(`spawn ${command} EINVAL`))
  const line = `""${script}"${args.map((arg) => ` ${quote(arg)}`).join('')}"`
  return execFile(process.env.ComSpec ?? 'cmd.exe', ['/e:ON', '/v:OFF', '/d', '/c', line], true)
}

/** @internal Runs `execFile` and surfaces the command's useful error output. */
function execFile(command: string, args: string[], verbatim = false): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      { windowsVerbatimArguments: verbatim },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
      },
    )
  })
}

/** @internal Finds `command` on `PATH` with each `PATHEXT` extension, as `cmd.exe` does, without searching the working directory. */
function which(command: string): string | undefined {
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const directory of (process.env.PATH ?? '').split(';')) {
    if (!directory) continue
    for (const extension of extensions) {
      const file = path.join(directory.replaceAll('"', ''), command + extension)
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file
    }
  }
  return undefined
}

/**
 * @internal Quotes a batch file argument as Rust's standard library does: quote anything but
 * known-safe characters, double embedded quotes and the backslashes before them, and turn `%`
 * into `%%cd:~,%` so `cmd.exe` expands no variables.
 */
function quote(arg: string): string {
  const body = arg.replace(/(\\*)"/g, '$1$1""').replaceAll('%', '%%cd:~,%')
  if (arg && !arg.endsWith('\\') && !/[^\w#$*+\-./:?@\\\u00a0-\uffff]/.test(arg)) return body
  return `"${body.replace(/(\\*)$/, '$1$1')}"`
}
