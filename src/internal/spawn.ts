import * as fs from 'node:fs'
import * as path from 'node:path'

const metaChars = /([()\][%!^"`<>&|;, *?])/g

/**
 * Resolves how to spawn `command` with `args` without `shell: true`. On Windows, package runners
 * such as `npx` and `pnpx` are `.cmd` scripts that `execFile` cannot launch (and Node refuses to
 * spawn directly since CVE-2024-27980), so they run through `cmd.exe` with each argument escaped.
 */
export function resolveCommand(
  command: string,
  args: string[],
  options: resolveCommand.Options = {},
): resolveCommand.Result {
  const { env = process.env, platform = process.platform } = options
  if (platform !== 'win32') return { args, command, windowsVerbatimArguments: false }

  const file = which(command, env)
  // Not found or a native executable (e.g. `bunx.exe`): spawn it directly.
  if (!file || !/\.(?:bat|cmd)$/i.test(file))
    return { args, command: file ?? command, windowsVerbatimArguments: false }

  // `cmd.exe` parses the line once, then the script parses its `%*` expansion again.
  const line = [file.replace(metaChars, '^$1'), ...args.map((arg) => escape(arg))].join(' ')
  return {
    args: ['/d', '/s', '/c', `"${line}"`],
    command: getEnv(env, 'COMSPEC') ?? 'cmd.exe',
    windowsVerbatimArguments: true,
  }
}

export declare namespace resolveCommand {
  /** Options for resolving a command. */
  type Options = {
    /** Environment used to search `PATH` and `PATHEXT`. Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv | undefined
    /** Platform to resolve for. Defaults to `process.platform`. */
    platform?: NodeJS.Platform | undefined
  }

  /** A spawnable invocation. */
  type Result = {
    /** Arguments to pass to `command`. */
    args: string[]
    /** Executable to spawn. */
    command: string
    /** Value for the `windowsVerbatimArguments` spawn option. */
    windowsVerbatimArguments: boolean
  }
}

/** @internal Finds `command` on `PATH` using `PATHEXT`, as `cmd.exe` would, skipping the working directory. */
function which(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (/[\\/]/.test(command)) return undefined
  const dirs = (getEnv(env, 'PATH') ?? '').split(';').filter(Boolean)
  const exts = (getEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of dirs)
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"(.*)"$/, '$1'), command + ext)
      try {
        if (fs.statSync(file).isFile()) return file
      } catch {}
    }
  return undefined
}

/** @internal Reads an environment variable case-insensitively, as Windows does. */
function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

/** @internal Quotes an argument for the C runtime, then caret-escapes it for both `cmd.exe` passes. */
function escape(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(metaChars, '^$1').replace(metaChars, '^$1')
}
