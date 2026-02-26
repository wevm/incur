/** Detects the package manager runner (`npx`, `pnpx`, `bunx`) from the current process environment. */
export function detectRunner(): string {
  const userAgent = process.env.npm_config_user_agent ?? ''
  const execPath = process.env.npm_execpath ?? ''
  if (userAgent.includes('pnpm') || execPath.includes('pnpm')) return 'pnpm dlx'
  if (userAgent.includes('bun') || execPath.includes('bun')) return 'bunx'
  return 'npx'
}
