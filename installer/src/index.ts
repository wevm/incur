const repositorySegment = /^[A-Za-z0-9_.-]+$/
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

/**
 * Redirects canonical repository paths to fixed GitHub installer assets.
 */
export default {
  fetch(request) {
    const route = resolve(request.url)
    if (!route) return notFound(request.method)

    if (request.method !== 'GET' && request.method !== 'HEAD')
      return methodNotAllowed(request.method)

    const headers = responseHeaders()
    headers.set(
      'Location',
      `https://github.com/${route.organization}/${route.repository}/releases/${route.releasePath}/${route.asset}`,
    )
    return new Response(null, { headers, status: 307 })
  },
} satisfies ExportedHandler

function resolve(requestUrl: string) {
  if (requestUrl.includes('?') || requestUrl.includes('#')) return undefined

  const segments = new URL(requestUrl).pathname.split('/')
  if (segments.length !== 3 && segments.length !== 4) return undefined

  const organization = segments[1]
  const repository = resolveRepository(segments[2])
  const selector = segments[3]
  if (!isRepositorySegment(organization, 39) || !repository) return undefined
  if (selector !== undefined && selector !== 'install.ps1') return undefined

  return {
    asset: selector === 'install.ps1' ? 'install.ps1' : 'install.sh',
    organization,
    releasePath: repository.releasePath,
    repository: repository.name,
  }
}

function resolveRepository(value: string | undefined) {
  if (value === undefined) return undefined

  const [name, version, extra] = value.split('@')
  if (extra !== undefined || !isRepositorySegment(name, 100)) return undefined
  if (version === undefined) return { name, releasePath: 'latest/download' }
  if (!stableVersion.test(version)) return undefined
  return { name, releasePath: `download/v${version}` }
}

function isRepositorySegment(value: string | undefined, length: number): value is string {
  if (value === undefined || value.length > length) return false
  if (value === '.' || value === '..') return false
  return repositorySegment.test(value)
}

function methodNotAllowed(method: string): Response {
  const headers = responseHeaders()
  headers.set('Allow', 'GET, HEAD')
  headers.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(method === 'HEAD' ? null : 'Method Not Allowed\n', {
    headers,
    status: 405,
  })
}

function notFound(method: string): Response {
  const headers = responseHeaders()
  headers.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(method === 'HEAD' ? null : 'Not Found\n', {
    headers,
    status: 404,
  })
}

function responseHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  })
}
