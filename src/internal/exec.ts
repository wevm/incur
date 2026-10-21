import spawn from 'cross-spawn'

/** Maximum bytes buffered from a command's output, matching `node:child_process` defaults. */
const maxBuffer = 1024 * 1024

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
    let buffered = 0
    let exceeded = false
    const collect = (stream: NodeJS.ReadableStream | null, append: (text: string) => void) => {
      // Decoding as a stream keeps a multibyte character intact when it spans two chunks.
      stream?.setEncoding('utf8')
      stream?.on('data', (chunk: string) => {
        buffered += Buffer.byteLength(chunk)
        if (buffered > maxBuffer) {
          exceeded = true
          child.kill()
          return
        }
        append(chunk)
      })
    }
    collect(child.stdout, (text) => {
      stdout += text
    })
    collect(child.stderr, (text) => {
      stderr += text
    })
    child.on('error', (error) => {
      reject(new Error(stderr.trim() || stdout.trim() || error.message))
    })
    child.on('close', (code) => {
      if (exceeded)
        reject(new Error(`Command wrote more than ${maxBuffer} bytes to stdout and stderr`))
      else if (code === 0) resolve({ stdout, stderr })
      else
        reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`))
    })
  })
}
