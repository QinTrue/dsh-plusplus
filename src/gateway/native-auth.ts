import { request, type IncomingHttpHeaders } from 'node:http'

/** Read only bounded response headers; never follow redirects, consume HTML or retain idle sockets. */
function headers(
  url: URL,
  signal: AbortSignal,
  cookie?: string,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET',
      signal,
      agent: false,
      headers: { 'sec-fetch-site': 'none', ...(cookie ? { cookie } : {}) },
    })
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      req.destroy()
      reject(
        new Error(
          'Native DSH authentication failed; check the loopback listener and current launch URL.',
        ),
      )
    }
    const timeout = setTimeout(fail, 5_000)
    timeout.unref()
    req.once('error', fail)
    req.once('upgrade', (_res, socket) => {
      socket.destroy()
      fail()
    })
    req.once('response', (res) => {
      if (settled) {
        res.destroy()
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ status: res.statusCode ?? 0, headers: res.headers })
      res.destroy()
    })
    req.end()
  })
}

/** Public native HTTP login, pinned to numeric loopback. No launch URL/cookie reaches a browser. */
export async function nativeSession(
  upstream: URL,
  signal: AbortSignal,
): Promise<{ cookie: string; expiresAt: number }> {
  const startedAt = Date.now()
  const response = await headers(upstream, signal)
  const cookies = response.headers['set-cookie'] ?? []
  const cookie = cookies.find(
    (value) =>
      /^dsh-auth-[A-Za-z0-9_-]+=/.test(value) &&
      /; HttpOnly(?:;|$)/i.test(value) &&
      /; SameSite=Strict(?:;|$)/i.test(value) &&
      /; Path=\/(?:;|$)/i.test(value),
  )
  const maxAge = Number(cookie?.match(/; Max-Age=(\d+)(?:;|$)/i)?.[1])
  // Native signatures use second-resolution expiry; stop conservatively before it.
  const expiresAt = startedAt + maxAge * 1000 - 1000
  const fail = () =>
    new Error(
      'Native DSH authentication failed; check the loopback listener and current launch URL.',
    )
  if (
    response.status !== 303 ||
    response.headers.location !== './' ||
    cookies.length !== 1 ||
    !cookie ||
    !Number.isSafeInteger(maxAge) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  )
    throw fail()
  const value = cookie.split(';')[0]!
  const verified = await headers(new URL('/', upstream), signal, value)
  if (
    verified.status !== 200 ||
    !/^text\/html(?:;|$)/i.test(verified.headers['content-type'] ?? '') ||
    expiresAt <= Date.now()
  )
    throw fail()
  return { cookie: value, expiresAt }
}
