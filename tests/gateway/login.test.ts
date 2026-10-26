import { afterEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { TOKEN, ORIGIN, NATIVE_COOKIE, fixture, send, login, cookie } from './gateway-helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup(...args: Parameters<typeof fixture>) {
  const f = await fixture(...args)
  cleanup.push(() => f.close())
  return f
}

describe('independent gateway authentication', () => {
  it('never contacts an unprotected upstream for anonymous paths, native credentials or forged forwarding headers', async () => {
    const f = await setup()
    for (const path of [
      '/',
      '/api',
      '/unknown/future/api',
      '/plugins/events',
      '/plugins/??a/client.js,b/client.js&rev=1',
      '/assets/app.js',
      '/?token=native-private-launch',
    ]) {
      const reply = await send(f.gateway, path, {
        headers: {
          cookie: NATIVE_COOKIE,
          'x-forwarded-for': '127.0.0.1',
          'x-forwarded-host': '127.0.0.1',
          authorization: 'Bearer ' + TOKEN,
        },
      })
      expect(reply.status).toBe(401)
    }
    const redirect = await send(f.gateway, '/unknown', { headers: { accept: 'text/html' } })
    expect(redirect.status).toBe(303)
    expect(redirect.headers.location).toBe('/lan')
    expect(f.seen).toEqual([])
  })

  it('gives the browser only an independent cookie and protects every forwarded request', async () => {
    const f = await setup()
    const form = await send(f.gateway, '/lan')
    expect(form.status).toBe(200)
    expect(form.body).not.toContain('<script')
    expect(form.headers['content-security-policy']).toContain("default-src 'none'")
    // no-referrer makes browser POST Origin null, breaking strict same-origin form admission.
    expect(form.headers['referrer-policy']).toBe('same-origin')
    const head = await send(f.gateway, '/lan/', { method: 'HEAD' })
    expect(head.body).toBe('')
    expect((await login(f.gateway, 'incorrect-token-32-bytes-minimum-test')).status).toBe(401)
    const signed = await login(f.gateway)
    expect(signed.status).toBe(303)
    expect(signed.headers['set-cookie']![0]).toMatch(/HttpOnly; SameSite=Strict/)
    expect(JSON.stringify(signed)).not.toContain('native-private')
    const session = cookie(signed)
    const path = '/plugins/??a/client.js,b/client.js&rev=2'
    const reply = await send(f.gateway, path, {
      headers: {
        cookie: session + '; evil=not-forwarded',
        origin: ORIGIN,
        forwarded: 'for=evil',
        'x-forwarded-for': 'evil',
        connection: 'keep-alive, x-secret',
        'x-secret': 'hidden',
      },
    })
    expect(reply.status).toBe(200)
    expect(reply.body).toBe('unprotected-upstream')
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['cache-control']).toBe('no-store')
    expect(f.seen[0]!.url).toBe(path)
    expect(f.seen[0]!.headers.cookie).toBe(NATIVE_COOKIE)
    expect(f.seen[0]!.headers.host).toBe(new URL(f.upstreamUrl).host)
    expect(f.seen[0]!.headers.origin).toBe(new URL(f.upstreamUrl).origin)
    for (const header of ['forwarded', 'x-forwarded-for', 'x-secret'])
      expect(f.seen[0]!.headers[header]).toBeUndefined()
  })

  it('renders shared native theme tokens without public assets, scripts or upstream access', async () => {
    const f = await setup({
      appearance: {
        preference: 'dark',
        tokens: { '--dsw-alias-brand-primary': { light: '#315c46', dark: '#99ccb1' } },
      },
    })
    const page = await send(f.gateway, '/lan')
    expect(page.body).toContain('color-scheme:dark')
    expect(page.body).toContain('--dsw-alias-brand-primary:#99ccb1')
    expect(page.body).not.toMatch(/<script|<link|<img/)
    expect(f.seen).toEqual([])
    const signed = cookie(await login(f.gateway))
    const connected = await send(f.gateway, '/lan', { headers: { cookie: signed } })
    expect(connected.body).toContain('action="/lan/logout"')
    expect(connected.body).not.toContain('action="/lan/login"')
    expect(connected.body).not.toContain(TOKEN)
  })

  it('rejects hostile authorities, cross-origin requests and absolute proxy targets before reaching upstream', async () => {
    const f = await setup()
    const session = cookie(await login(f.gateway))
    for (const headers of [
      { host: 'evil.test' },
      { origin: 'https://gateway.test:19388' },
      { origin: 'http://evil.test' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
    ] as Record<string, string>[]) {
      expect(
        (await send(f.gateway, '/unprotected', { headers: { cookie: session, ...headers } }))
          .status,
      ).toBe(403)
    }
    for (const path of ['http://evil.test/secret', '//evil.test/secret', '/bad\\path'])
      expect((await send(f.gateway, path, { headers: { cookie: session } })).status).toBe(400)
    expect(
      (
        await send(f.gateway, '/api/change', {
          method: 'POST',
          headers: { cookie: session },
          body: 'change',
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await send(f.gateway, '/api', {
          method: 'TRACE',
          headers: { cookie: session, origin: ORIGIN },
        })
      ).status,
    ).toBe(405)
    expect(f.seen).toEqual([])
  })

  it('reserves management paths for local settings even after LAN login', async () => {
    const f = await setup()
    const session = cookie(await login(f.gateway))
    for (const path of [
      '/api/dsh-plusplus/lan/manage',
      '/api/%64sh-plusplus/lan/manage',
      '/api/other/../dsh-plusplus/lan/manage',
      '/api%2Fdsh-plusplus%2Flan%2Fmanage',
    ]) {
      expect((await send(f.gateway, path, { headers: { cookie: session } })).status).toBe(403)
    }
    expect(f.seen).toEqual([])
  })

  it('forwards authenticated DSH++ feature requests while keeping LAN management local', async () => {
    const f = await setup()
    const path = '/api/dsh-plusplus/archived-sessions'
    expect(
      (await send(f.gateway, path, { method: 'POST', headers: { origin: ORIGIN }, body: '{}' }))
        .status,
    ).toBe(401)
    expect(f.seen).toEqual([])
    const session = cookie(await login(f.gateway))
    expect(
      (
        await send(f.gateway, path, {
          method: 'POST',
          headers: { cookie: session, origin: ORIGIN, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(200)
    expect(f.seen.at(-1)?.url).toBe(path)
  })

  it('revokes on logout and re-login and refuses duplicated or forged session cookies', async () => {
    const f = await setup()
    const old = cookie(await login(f.gateway))
    const current = cookie(await login(f.gateway, TOKEN, old))
    expect((await send(f.gateway, '/', { headers: { cookie: old } })).status).toBe(401)
    expect(
      (await send(f.gateway, '/', { headers: { cookie: current + '; ' + current } })).status,
    ).toBe(401)
    expect(
      (await send(f.gateway, '/', { headers: { cookie: current.slice(0, -2) + 'xx' } })).status,
    ).toBe(401)
    expect(
      (await send(f.gateway, '/lan/logout', { method: 'GET', headers: { cookie: current } }))
        .status,
    ).toBe(405)
    expect(
      (
        await send(f.gateway, '/lan/logout', {
          method: 'POST',
          headers: { cookie: current, origin: ORIGIN },
        })
      ).status,
    ).toBe(303)
    expect((await send(f.gateway, '/', { headers: { cookie: current } })).status).toBe(401)
    expect(f.seen).toEqual([])
  })

  it('bounds peers and closes rejected incomplete uploads instead of forwarding or draining them', async () => {
    const f = await setup()
    for (let i = 0; i < 5; i++)
      expect((await login(f.gateway, 'wrong-token-with-at-least-32-bytes')).status).toBe(401)
    const reply = await new Promise<{ status: number; connection?: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: f.gateway.address.port,
          path: '/lan/login',
          method: 'POST',
          headers: {
            host: new URL(ORIGIN).host,
            origin: ORIGIN,
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': '9999999999',
            'x-forwarded-for': '192.0.2.123',
          },
        },
        (res) => {
          res.resume()
          res.once('end', () =>
            resolve({ status: res.statusCode!, connection: res.headers.connection }),
          )
        },
      )
      req.on('error', reject)
      req.write('token=partial')
    })
    expect(reply).toEqual({ status: 429, connection: 'close' })
    expect(f.seen).toEqual([])
  })

  it('ends gateway access at native cookie expiry and refuses fresh sessions', async () => {
    const f = await setup({}, undefined, 2)
    const session = cookie(await login(f.gateway))
    expect((await send(f.gateway, '/unknown', { headers: { cookie: session } })).status).toBe(200)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    try {
      expect((await send(f.gateway, '/unknown', { headers: { cookie: session } })).status).toBe(401)
      expect((await login(f.gateway)).status).toBe(503)
      expect(f.seen).toHaveLength(1)
    } finally {
      now.mockRestore()
    }
  })

  it('expires absolute sessions and refuses capacity overflow without evicting valid clients', async () => {
    const f = await setup({ maxSessions: 1, sessionTtlMs: 60 })
    const session = cookie(await login(f.gateway))
    expect((await login(f.gateway)).status).toBe(503)
    expect((await send(f.gateway, '/unprotected', { headers: { cookie: session } })).status).toBe(
      200,
    )
    await new Promise((resolve) => setTimeout(resolve, 85))
    expect((await send(f.gateway, '/', { headers: { cookie: session } })).status).toBe(401)
    expect((await login(f.gateway)).status).toBe(303)
  })

  it('returns 502 promptly for an unexpected HTTP upgrade and preserves native 401/403', async () => {
    const f = await setup({}, (req, res) => {
      if (req.url === '/unexpected-upgrade') {
        res.writeHead(101, { connection: 'Upgrade', upgrade: 'unexpected' })
        res.flushHeaders()
        return
      }
      res.writeHead(Number(req.url!.slice(1)))
      res.end('native-rejection')
    })
    const session = cookie(await login(f.gateway))
    expect(
      (await send(f.gateway, '/unexpected-upgrade', { headers: { cookie: session } })).status,
    ).toBe(502)
    for (const status of [401, 403]) {
      const reply = await send(f.gateway, '/' + status, { headers: { cookie: session } })
      expect(reply.status).toBe(status)
      expect(reply.body).toBe('native-rejection')
    }
  })

  it('reframes chunked GET and Connection-nominated framing without creating another upstream request', async () => {
    const f = await setup({}, (req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.once('end', () => res.end(body))
    })
    const session = cookie(await login(f.gateway))
    const body = 'GET /not-a-real-request HTTP/1.1\r\nHost: loopback\r\n\r\n'
    const headers = { cookie: session, origin: ORIGIN }
    const chunked = await send(f.gateway, '/chunked', {
      method: 'GET',
      headers: { ...headers, 'transfer-encoding': 'chunked' },
      body,
    })
    expect(chunked.body).toBe(body)
    const nominated = await send(f.gateway, '/nominated', {
      method: 'GET',
      headers: {
        ...headers,
        'content-length': String(Buffer.byteLength(body)),
        connection: 'close, content-length',
      },
      body,
    })
    expect(nominated.body).toBe(body)
    expect(f.seen.map((hit) => hit.url)).toEqual(['/chunked', '/nominated'])
  })

  it('streams request bodies and responses without changing payloads or following redirects', async () => {
    const f = await setup({}, (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://external.invalid/path' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      req.pipe(res)
    })
    const session = cookie(await login(f.gateway))
    const data = 'upload-stream-'.repeat(10000)
    const reply = await send(f.gateway, '/upload?exact=%2F', {
      method: 'POST',
      headers: { cookie: session, origin: ORIGIN },
      body: data,
    })
    expect(reply.body).toBe(data)
    const redirect = await send(f.gateway, '/redirect', { headers: { cookie: session } })
    expect(redirect.status).toBe(302)
    expect(redirect.headers.location).toBe('http://external.invalid/path')
    expect(f.seen).toHaveLength(2)
  })
})
