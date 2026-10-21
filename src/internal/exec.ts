import spawn from 'cross-spawn'

/**
 * Runs a command and collects its output.
 *
 * Resolves `.cmd` and `.bat` shims, which `node:child_process` cannot launch
 * directly on Windows because command scripts require a shell.
 */
export function execFile(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      reject(new Error(stderr.trim() || stdout.trim() || error.message))
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else
        reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`))
    })
  })
}
