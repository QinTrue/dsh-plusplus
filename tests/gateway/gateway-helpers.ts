import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { startGateway, type Gateway, type GatewayOptions } from '../../src/gateway/index.ts'

export const TOKEN = 'test-only-gateway-token-32-bytes-minimum'
export const ORIGIN = 'http://gateway.test:19388'
export const NATIVE_COOKIE = 'dsh-auth-test=native-private-cookie'
export interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}
export function send(
  gateway: Gateway,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: gateway.address.port,
        path,
        method: options.method ?? 'GET',
        headers: { host: new URL(ORIGIN).host, ...options.headers },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.once('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      },
    )
    req.once('error', reject)
    req.end(options.body)
  })
}
export function login(gateway: Gateway, token = TOKEN, cookie?: string) {
  return send(gateway, '/lan/login', {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ token }).toString(),
  })
}
export function cookie(reply: Reply) {
  return reply.headers['set-cookie']![0]!.split(';')[0]!
}
export async function fixture(
  options: Partial<GatewayOptions> = {},
  handle?: (req: IncomingMessage, res: ServerResponse) => void,
  nativeMaxAge = 86400,
) {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = []
  let upgradeCount = 0
  const native = createServer((req, res) => {
    if (req.url === '/?token=native-private-launch') {
      res.writeHead(303, {
        location: './',
        'set-cookie':
          NATIVE_COOKIE + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + nativeMaxAge,
      })
      res.end()
      return
    }
    if (req.url === '/' && req.headers.cookie === NATIVE_COOKIE) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>fixture</title>')
      return
    }
    // Deliberately no upstream authentication: gateway must protect even this.
    seen.push({ url: req.url!, headers: req.headers })
    if (handle) {
      handle(req, res)
      return
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': 'upstream=must-not-reach-browser; Path=/',
    })
    res.end('unprotected-upstream')
  })
  const sockets = new Set<import('node:net').Socket>()
  native.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  native.on('upgrade', (req, socket, head) => {
    upgradeCount++
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n',
    )
    if (head.length) socket.write(head)
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => native.listen(0, '127.0.0.1', resolve))
  const upstreamUrl =
    'http://127.0.0.1:' + (native.address() as AddressInfo).port + '/?token=native-private-launch'
  let gateway: Gateway
  try {
    gateway = await startGateway({
      upstreamUrl,
      token: TOKEN,
      publicOrigin: ORIGIN,
      port: 0,
      host: '127.0.0.1',
      ...options,
    })
  } catch (error) {
    for (const socket of sockets) socket.destroy()
    native.close()
    throw error
  }
  return {
    gateway,
    upstreamUrl,
    seen,
    upgrades: () => upgradeCount,
    async close() {
      await gateway.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => native.close(() => resolve()))
    },
  }
}
