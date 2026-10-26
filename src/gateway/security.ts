import type { IncomingMessage } from 'node:http'

export const responseHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
} as const

export class LoginError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly closeConnection = false,
  ) {
    super(message)
  }
}

/** Small, timed, abortable form reader; all listeners are removed on settlement. */
export function readLoginBody(
  req: IncomingMessage,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<string> {
  const type = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (type !== 'application/x-www-form-urlencoded')
    return Promise.reject(new LoginError(415, '请使用登录表单提交。', true))
  const limit = 1024
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) {
    return Promise.reject(new LoginError(413, '登录请求过大。', true))
  }
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks: Buffer[] = []
    const finish = (error?: Error, token?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      req
        .off('data', data)
        .off('end', end)
        .off('error', failed)
        .off('aborted', failed)
        .off('close', closed)
      if (error) reject(error)
      else resolve(token ?? '')
    }
    const aborted = () => finish(new LoginError(503, '登录入口已停止。', true))
    const failed = () => finish(new LoginError(400, '登录请求中断。', true))
    const closed = () => {
      if (!req.complete) failed()
    }
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > limit) finish(new LoginError(413, '登录请求过大。', true))
      else chunks.push(bytes)
    }
    const end = () => {
      const fields = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
      const tokens = fields.getAll('token')
      if (tokens.length !== 1 || [...fields.keys()].some((key) => key !== 'token')) {
        finish(new LoginError(400, '登录表单无效。'))
      } else finish(undefined, tokens[0])
    }
    const timer = setTimeout(() => finish(new LoginError(408, '登录请求超时。', true)), timeoutMs)
    timer.unref()
    req
      .on('data', data)
      .once('end', end)
      .once('error', failed)
      .once('aborted', failed)
      .once('close', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
