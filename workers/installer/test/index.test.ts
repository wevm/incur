import { exports } from 'cloudflare:workers'
import { describe, expect, test } from 'vitest'

const origin = 'https://incur.app'

describe('fetch', () => {
  test.each([
    ['/wevm/frog', 'https://github.com/wevm/frog/releases/latest/download/install.sh'],
    ['/wevm/frog/install.ps1', 'https://github.com/wevm/frog/releases/latest/download/install.ps1'],
    ['/wevm/frog@1.2.3', 'https://github.com/wevm/frog/releases/download/v1.2.3/install.sh'],
    [
      '/wevm/frog@0.0.0/install.ps1',
      'https://github.com/wevm/frog/releases/download/v0.0.0/install.ps1',
    ],
    [
      '/Mixed-Org/Repo_1.2-rc',
      'https://github.com/Mixed-Org/Repo_1.2-rc/releases/latest/download/install.sh',
    ],
    [
      '/Mixed-Org/Repo_1.2-rc@10.20.30',
      'https://github.com/Mixed-Org/Repo_1.2-rc/releases/download/v10.20.30/install.sh',
    ],
    [
      '/does-not-exist/also-missing',
      'https://github.com/does-not-exist/also-missing/releases/latest/download/install.sh',
    ],
    [
      '/wevm/install.ps1',
      'https://github.com/wevm/install.ps1/releases/latest/download/install.sh',
    ],
    [
      '/wevm/install.ps1/install.ps1',
      'https://github.com/wevm/install.ps1/releases/latest/download/install.ps1',
    ],
    [
      '/wevm/install.ps1@1.2.3/install.ps1',
      'https://github.com/wevm/install.ps1/releases/download/v1.2.3/install.ps1',
    ],
    ['/wevm/tool.ps1', 'https://github.com/wevm/tool.ps1/releases/latest/download/install.sh'],
    [
      '/wevm/tool.ps1/install.ps1',
      'https://github.com/wevm/tool.ps1/releases/latest/download/install.ps1',
    ],
  ])('redirects %s to its fixed installer asset', async (path, location) => {
    await expectRedirect(await request(path), location)
  })

  test('supports the maximum repository segment lengths', async () => {
    const organization = 'o'.repeat(39)
    const repository = 'r'.repeat(100)
    await expectRedirect(
      await request(`/${organization}/${repository}`),
      `https://github.com/${organization}/${repository}/releases/latest/download/install.sh`,
    )
    await expectRedirect(
      await request(`/${organization}/${repository}@1.2.3`),
      `https://github.com/${organization}/${repository}/releases/download/v1.2.3/install.sh`,
    )
  })

  test.each([
    '/wevm/frog',
    '/wevm/frog/install.ps1',
    '/wevm/frog@1.2.3',
    '/wevm/frog@1.2.3/install.ps1',
  ])('returns the same bodyless redirect for HEAD %s', async (path) => {
    const get = await request(path)
    const head = await request(path, { method: 'HEAD' })

    expect(await summarize(head)).toEqual(await summarize(get))
  })

  test.each([
    '/',
    '/wevm',
    '/wevm/',
    '/wevm//frog',
    '/wevm/frog/',
    '/wevm/frog/extra',
    '/a/b/c/d',
    '//evil.example/repo',
    '/wevm/frog/INSTALL.PS1',
    '/wevm/frog/install.ps1.ps1',
    '/wevm/frog/install.sh',
    '/wevm/frog/install.ps1/',
    '/wevm/frog/install.ps1/extra',
    '/wevm/frog@1.2.3/install.sh',
    '/wevm/frog@1.2.3/install.ps1/extra',
    '/wevm%2Fattacker/frog',
    '/wevm/frog%2Finstall.ps1',
    '/wevm/frog/%2Finstall.ps1',
    '/wevm/%252Ffrog',
    '/wevm%5Cattacker/frog',
    '/wevm/frog%5Cevil',
    '/wevm/frog/%5Cinstall.ps1',
    '/w%C3%ABvm/frog',
    '/wevm/fr%C3%B6g',
    '/wevm/frog%00',
    '/wevm/frog%09',
    '/wevm/frog%0A',
    '/wevm/frog%0D',
    '/wevm/frog%0D%0ALocation:%20https:%2F%2Fevil.example',
    '/wevm/frog%20',
    '/wevm/frog~',
    '/wevm/frog:',
    '/wevm/frog@evil.example',
    '/wevm/@1.2.3',
    '/wevm/frog@',
    '/wevm/frog@v1.2.3',
    '/wevm/frog@V1.2.3',
    '/wevm/frog@1',
    '/wevm/frog@1.2',
    '/wevm/frog@1.2.3.4',
    '/wevm/frog@01.2.3',
    '/wevm/frog@1.02.3',
    '/wevm/frog@1.2.03',
    '/wevm/frog@-1.2.3',
    '/wevm/frog@1.-2.3',
    '/wevm/frog@1.2.-3',
    '/wevm/frog@1.2.3-alpha',
    '/wevm/frog@1.2.3+build',
    '/wevm/frog@1.2.3@evil.example',
    '/wevm/frog@@1.2.3',
    '/wevm/frog@1.x',
    '/wevm/frog@*',
    '/wevm/frog@^1.2.3',
    '/wevm/frog@１.2.3',
    '/wevm/frog%401.2.3',
    '/wevm/frog@1.2.3%20',
    '/wevm/frog@1.2.3%2Fevil',
    '/wevm/frog@1.2.3%5Cevil',
    '/wevm/frog@1.2.3%252Fevil',
    '/wevm/frog@1.2.3%00',
    '/wevm/frog@1.2.3%0D%0ALocation:%20https:%2F%2Fevil.example',
    '/wevm/frog;',
    '/wevm/frog+',
    '/wevm/frog=',
    '/wevm/frog%3Fadmin',
    '/wevm/frog%23admin',
    '/wevm/frog?x',
    '/wevm/frog?x=1',
    '/wevm/frog?redirect=https://evil.example',
    '/wevm/frog?%0D%0AX-Evil=1',
    `/${'o'.repeat(40)}/frog`,
    `/wevm/${'r'.repeat(101)}`,
  ])('returns 404 without a redirect for invalid path %s', async (path) => {
    await expectNotFound(await request(path), 'Not Found\n')
  })

  test('returns a bodyless 404 for HEAD on an invalid path', async () => {
    await expectNotFound(await request('/invalid', { method: 'HEAD' }), '')
  })

  test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'returns 405 for %s on a valid route',
    async (method) => {
      await expectMethodNotAllowed(await request('/wevm/frog/install.ps1', { method }))
      await expectMethodNotAllowed(await request('/wevm/frog@1.2.3', { method }))
    },
  )

  test.each([
    ['POST', '/bad'],
    ['OPTIONS', '/wevm/frog/extra'],
    ['POST', '/wevm/frog?x=1'],
    ['POST', '/wevm/frog@v1.2.3'],
  ])('returns 404 before method handling for %s %s', async (method, path) => {
    await expectNotFound(await request(path, { method }), 'Not Found\n')
  })

  test('ignores request origins and forwarding headers', async () => {
    const response = await exports.default.fetch('https://attacker.invalid/wevm/frog', {
      headers: {
        Forwarded: 'host=evil.example;proto=http',
        Origin: 'https://evil.example',
        Referer: 'https://evil.example/',
        'X-Forwarded-Host': 'evil.example',
        'X-Original-URL': 'https://evil.example/install.sh',
        'X-Rewrite-URL': 'https://evil.example/install.ps1',
      },
      redirect: 'manual',
    })

    await expectRedirect(
      response,
      'https://github.com/wevm/frog/releases/latest/download/install.sh',
    )
  })
})

async function expectMethodNotAllowed(response: Response) {
  expect(await summarize(response)).toEqual({
    accessControlAllowOrigin: null,
    allow: 'GET, HEAD',
    body: 'Method Not Allowed\n',
    cacheControl: 'no-store',
    contentType: 'text/plain; charset=utf-8',
    location: null,
    referrerPolicy: 'no-referrer',
    setCookie: null,
    status: 405,
    xContentTypeOptions: 'nosniff',
    xRobotsTag: 'noindex, nofollow, noarchive',
  })
}

async function expectNotFound(response: Response, body: string) {
  expect(await summarize(response)).toEqual({
    accessControlAllowOrigin: null,
    allow: null,
    body,
    cacheControl: 'no-store',
    contentType: 'text/plain; charset=utf-8',
    location: null,
    referrerPolicy: 'no-referrer',
    setCookie: null,
    status: 404,
    xContentTypeOptions: 'nosniff',
    xRobotsTag: 'noindex, nofollow, noarchive',
  })
}

async function expectRedirect(response: Response, location: string) {
  const destination = new URL(location)
  expect(await summarize(response)).toEqual({
    accessControlAllowOrigin: null,
    allow: null,
    body: '',
    cacheControl: 'no-store',
    contentType: null,
    location,
    referrerPolicy: 'no-referrer',
    setCookie: null,
    status: 307,
    xContentTypeOptions: 'nosniff',
    xRobotsTag: 'noindex, nofollow, noarchive',
  })
  expect({
    hash: destination.hash,
    hostname: destination.hostname,
    password: destination.password,
    port: destination.port,
    protocol: destination.protocol,
    search: destination.search,
    username: destination.username,
  }).toEqual({
    hash: '',
    hostname: 'github.com',
    password: '',
    port: '',
    protocol: 'https:',
    search: '',
    username: '',
  })
  expect(destination.pathname).toMatch(
    /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/(?:latest\/download|download\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/install\.(?:ps1|sh)$/,
  )
}

async function request(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`${origin}${path}`, {
    redirect: 'manual',
    ...init,
  })
}

async function summarize(response: Response) {
  return {
    accessControlAllowOrigin: response.headers.get('access-control-allow-origin'),
    allow: response.headers.get('allow'),
    body: await response.text(),
    cacheControl: response.headers.get('cache-control'),
    contentType: response.headers.get('content-type'),
    location: response.headers.get('location'),
    referrerPolicy: response.headers.get('referrer-policy'),
    setCookie: response.headers.get('set-cookie'),
    status: response.status,
    xContentTypeOptions: response.headers.get('x-content-type-options'),
    xRobotsTag: response.headers.get('x-robots-tag'),
  }
}
