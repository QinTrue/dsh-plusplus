import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { gatewayConfig, type GatewayOptions } from './config.ts'
import { Sessions } from './sessions.ts'
import { nativeSession } from './native-auth.ts'
import { UpstreamProxy } from './proxy.ts'
import { AttemptBudget } from './rate-limit.ts'
import { readLoginBody, LoginError, responseHeaders } from './security.ts'
import { validToken, tokensEqual } from './token.ts'
import { renderLogin } from './page.ts'

export interface Gateway {
  readonly address: { address: string; port: number }
  readonly nativeExpiresAt: number
  close(): Promise<void>
}

/** Authenticate before ANY upstream request, including unknown routes and every upgrade. */
export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  const config = gatewayConfig(options)
  const lifecycle = new AbortController()
  // Authenticate upstream before opening a public socket; failures expose no unauthenticated mode.
  const native = await nativeSession(config.upstream, lifecycle.signal)
  config.upstream.search = ''
  const proxy = new UpstreamProxy(config.upstream)
  const sessions = new Sessions(config.origin, config.sessionTtlMs, config.maxSessions)
  const attempts = new AttemptBudget()
  const sockets = new Set<Socket>()
  let closed = false

  const validate = (req: IncomingMessage, requireOrigin = false) => {
    if (closed) throw new LoginError(503, '网关已停止。')
    const target = req.url ?? ''
    if (!target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20\x7f#]/.test(target))
      throw new LoginError(400, '请求路径无效。')
    const hostCount = req.rawHeaders.filter(
      (_value, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === 'host',
    ).length
    if (hostCount !== 1 || req.headers.host !== config.origin.host)
      throw new LoginError(403, '访问地址不受信任。')
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none')
      throw new LoginError(403, '请求来源不受信任。')
    const origin = req.headers.origin
    if ((origin !== undefined || requireOrigin) && origin !== config.origin.origin)
      throw new LoginError(403, '请从同一地址访问网关。')
    if (
      req.headers['transfer-encoding'] !== undefined &&
      req.headers['transfer-encoding'].toLowerCase() !== 'chunked'
    )
      throw new LoginError(400, '不支持的请求编码。')
    if (req.method === 'CONNECT' || req.method === 'TRACE')
      throw new LoginError(405, '请求方法不受支持。')
    return target.split('?')[0]!
  }
  const admitForward = (target: string) => {
    let path: string
    try {
      path = decodeURIComponent(new URL(target, 'http://gateway.invalid').pathname)
    } catch {
      throw new LoginError(400, '请求路径无效。')
    }
    if (/^\/api\/dsh-plusplus\/lan(?:\/|$)/i.test(path))
      throw new LoginError(403, '请在本机 DSH 设置中管理网关。')
  }
  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    message: string,
    login = false,
  ) => {
    if (res.destroyed || res.writableEnded) return
    for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value)
    res.setHeader('content-type', login ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8')
    if (!req.readableEnded) {
      res.setHeader('connection', 'close')
      res.once('finish', () => req.destroy())
    }
    res.writeHead(status)
    res.end(
      req.method === 'HEAD'
        ? undefined
        : login
          ? renderLogin(message, Boolean(sessions.get(req.headers.cookie)), config.loginTheme)
          : message,
    )
  }
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = validate(req, !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? ''))
      if (path === '/lan' || path === '/lan/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('allow', 'GET, HEAD')
          throw new LoginError(405, '请打开 /lan 登录。')
        }
        send(req, res, 200, '', true)
        return
      }
      if (path === '/lan/login') {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          throw new LoginError(405, '请使用登录表单提交 token。')
        }
        if (req.url !== '/lan/login') throw new LoginError(400, '登录网址不能包含查询参数。')
        const retry = attempts.reserve(req.socket.remoteAddress)
        if (retry !== undefined) {
          res.setHeader('retry-after', String(retry))
          throw new LoginError(429, '尝试次数过多，请稍后重试。')
        }
        if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue()
        const token = await readLoginBody(req, lifecycle.signal)
        if (closed) throw new LoginError(503, '网关已停止。')
        if (!validToken(token) || !tokensEqual(token, config.token))
          throw new LoginError(401, 'Token 无效。')
        // Re-login revokes this browser's previous session, including any open streams.
        sessions.revoke(req.headers.cookie)
        if (native.expiresAt <= Date.now())
          throw new LoginError(503, '原生登录已过期，请用当前 DSH 启动链接重启网关。')
        const cookie = sessions.create(native.cookie, native.expiresAt)
        if (!cookie) throw new LoginError(503, '网关登录人数已达上限。')
        res.setHeader('set-cookie', cookie)
        res.setHeader('location', '/')
        send(req, res, 303, '')
        return
      }
      const session = sessions.get(req.headers.cookie)
      if (!session) {
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          req.headers.accept?.includes('text/html')
        ) {
          res.setHeader('location', '/lan')
          send(req, res, 303, '')
        } else send(req, res, 401, '请先通过 /lan 登录网关。')
        return
      }
      admitForward(req.url!)
      if (path === '/lan/logout') {
        if (req.method !== 'POST' || req.url !== '/lan/logout') {
          res.setHeader('allow', 'POST')
          throw new LoginError(405, '退出登录需要同源 POST。')
        }
        sessions.revoke(req.headers.cookie)
        res.setHeader('set-cookie', sessions.clearCookie())
        res.setHeader('location', '/lan')
        send(req, res, 303, '')
        return
      }
      if (req.headers.expect?.toLowerCase() === '100-continue') res.writeContinue()
      proxy.http(req, res, session)
    } catch (error) {
      const known = error instanceof LoginError
      send(
        req,
        res,
        known ? error.status : 503,
        known ? error.message : '网关暂时不可用。',
        req.url?.split('?')[0] === '/lan/login',
      )
    }
  }
  const server = config.tls ? createHttpsServer(config.tls, handler) : createHttpServer(handler)
  // Partial unauthenticated requests have bounded header/body lifetimes.
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 5_000
  server.maxHeadersCount = 100
  const rejectSocket = (socket: Duplex, status: number) => {
    socket.on('error', () => socket.destroy())
    socket.end(
      'HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      () => socket.destroy(),
    )
    const deadline = setTimeout(() => socket.destroy(), 1000)
    deadline.unref()
    socket.once('close', () => clearTimeout(deadline))
  }
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  server.on('connect', (_req, socket) => rejectSocket(socket, 405))
  server.on('checkContinue', (req, res) => {
    void handler(req, res)
  })
  server.on('checkExpectation', (req, res) => send(req, res, 417, '请求预期不受支持。'))
  server.on('upgrade', (req, socket, head) => {
    try {
      validate(req, true)
      const session = sessions.get(req.headers.cookie)
      if (!session) {
        rejectSocket(socket, 401)
        return
      }
      const key = req.headers['sec-websocket-key']
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        rejectSocket(socket, 400)
        return
      }
      if (
        req.method !== 'GET' ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        req.headers['sec-websocket-version'] !== '13' ||
        typeof key !== 'string' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(key)
      ) {
        rejectSocket(socket, 400)
        return
      }
      admitForward(req.url!)
      proxy.upgrade(req, socket, head, session)
    } catch (error) {
      rejectSocket(socket, error instanceof LoginError ? error.status : 503)
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    sessions.clear()
    proxy.close()
    lifecycle.abort()
    throw new Error('Gateway could not listen on the configured address.')
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Gateway address unavailable.')
  let closing: Promise<void> | undefined
  return {
    address: { address: address.address, port: address.port },
    nativeExpiresAt: native.expiresAt,
    close() {
      if (closing) return closing
      closed = true
      lifecycle.abort()
      sessions.clear()
      attempts.clear()
      proxy.close()
      closing = new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const socket of sockets) socket.destroy()
      })
      return closing
    },
  }
}
