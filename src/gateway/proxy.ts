import {
  request,
  type IncomingMessage,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerResponse,
  type ClientRequest,
} from 'node:http'
import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { GatewaySession } from './sessions.ts'

const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** Remove both standard hop headers and fields explicitly nominated by Connection. */
function cleanHeaders(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    (input.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  )
  const result: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(input)) {
    if (
      hopHeaders.has(name) ||
      named.has(name) ||
      name === 'forwarded' ||
      name.startsWith('x-forwarded-') ||
      name === 'x-real-ip' ||
      name.startsWith('proxy-') ||
      value === undefined
    )
      continue
    result[name] = value
  }
  return result
}

export class UpstreamProxy {
  private readonly pending = new Set<ClientRequest>()
  private readonly tunnels = new Set<Duplex>()
  constructor(private readonly upstream: URL) {}
  private headers(
    req: IncomingMessage,
    session: GatewaySession,
    upgrade: boolean,
  ): OutgoingHttpHeaders {
    const headers = cleanHeaders(req.headers)
    // The browser's gateway cookie never reaches DSH. DSH's cookie stays inside this hop.
    headers.host = this.upstream.host
    headers.cookie = session.nativeCookie
    headers['x-dsh-plusplus-gateway'] = '1'
    if (req.headers.origin !== undefined) headers.origin = this.upstream.origin
    delete headers.referer
    delete headers.expect
    // IncomingMessage already de-chunks. Reframe explicitly even for GET/DELETE/OPTIONS,
    // whose ClientRequest default is not chunked; never emit unframed payload bytes.
    if (
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && headers['content-length'] === undefined)
    ) {
      delete headers['content-length']
      headers['transfer-encoding'] = 'chunked'
    }
    if (upgrade) {
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
    }
    return headers
  }
  private open(req: IncomingMessage, session: GatewaySession, upgrade = false): ClientRequest {
    const outbound = request({
      hostname: this.upstream.hostname.replace(/^\[|\]$/g, ''),
      port: this.upstream.port || 80,
      path: req.url,
      method: req.method,
      headers: this.headers(req, session, upgrade),
      agent: false,
    })
    this.pending.add(outbound)
    outbound.once('close', () => this.pending.delete(outbound))
    return outbound
  }
  private responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
    const clean = cleanHeaders(headers)
    // Upstream cannot replace or create a gateway credential, and cached content must not skip the gate.
    delete clean['set-cookie']
    delete clean['clear-site-data']
    clean['cache-control'] = 'no-store'
    clean['referrer-policy'] = 'same-origin'
    return clean
  }
  http(req: IncomingMessage, res: ServerResponse, session: GatewaySession): void {
    const outbound = this.open(req, session)
    let upstreamResponse: IncomingMessage | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      outbound.destroy()
      upstreamResponse?.destroy()
      res.destroy()
    }
    session.connections.add(stop)
    const cleanup = () => {
      clearTimeout(deadline)
      session.connections.delete(stop)
      if (!res.writableFinished) outbound.destroy()
      upstreamResponse?.destroy()
    }
    res.once('close', cleanup)
    req.once('aborted', () => outbound.destroy())
    req.once('error', () => outbound.destroy())
    // Upload time is governed by the server's request timeout, not the response-header deadline.
    outbound.once('finish', () => {
      if (upstreamResponse || outbound.destroyed) return
      deadline = setTimeout(() => outbound.destroy(new Error('Upstream response timeout')), 15_000)
      deadline.unref()
    })
    let failed = false
    const fail = () => {
      if (failed) return
      failed = true
      clearTimeout(deadline)
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'close',
        })
        res.end('DSH 暂时不可用。')
      } else res.destroy()
      outbound.destroy()
    }
    outbound.once('error', fail)
    outbound.once('upgrade', (_response, socket) => {
      fail()
      socket.destroy()
    })
    outbound.once('response', (response) => {
      clearTimeout(deadline)
      upstreamResponse = response
      if (res.destroyed) {
        response.destroy()
        return
      }
      const headers = this.responseHeaders(response.headers)
      if (!req.readableEnded) {
        headers.connection = 'close'
        res.once('finish', () => {
          outbound.destroy()
          req.destroy()
        })
      }
      res.writeHead(response.statusCode ?? 502, headers)
      // pipe preserves streaming and backpressure. No buffering, decompressing, or redirect following.
      response.once('aborted', () => res.destroy())
      response.once('error', () => res.destroy())
      response.pipe(res)
    })
    req.pipe(outbound)
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, session: GatewaySession): void {
    const outbound = this.open(req, session, true)
    let tunnel: Duplex | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      clearTimeout(deadline)
      outbound.destroy()
      tunnel?.destroy()
      socket.destroy()
    }
    session.connections.add(stop)
    socket.once('close', () => {
      stop()
      session.connections.delete(stop)
    })
    socket.once('error', stop)
    deadline = setTimeout(stop, 10_000)
    deadline.unref()
    let rejected = false
    const failed = (status = 502) => {
      if (rejected) return
      rejected = true
      clearTimeout(deadline)
      if (!socket.destroyed)
        socket.end(
          'HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          () => socket.destroy(),
        )
      const rejectionDeadline = setTimeout(() => socket.destroy(), 1000)
      rejectionDeadline.unref()
      socket.once('close', () => clearTimeout(rejectionDeadline))
      outbound.destroy()
    }
    outbound.once('error', () => failed())
    outbound.once('response', (response) => {
      const status = response.statusCode ?? 502
      response.destroy()
      failed(status >= 400 && status <= 599 ? status : 502)
    })
    outbound.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      clearTimeout(deadline)
      const key = req.headers['sec-websocket-key']!
      const expected = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      if (
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== 'websocket' ||
        response.headers['sec-websocket-accept'] !== expected ||
        socket.destroyed
      ) {
        upstreamSocket.destroy()
        failed()
        return
      }
      tunnel = upstreamSocket
      this.tunnels.add(upstreamSocket)
      upstreamSocket.once('close', () => {
        this.tunnels.delete(upstreamSocket)
        socket.destroy()
      })
      upstreamSocket.once('error', stop)
      const headers = this.responseHeaders(response.headers)
      delete headers['cache-control']
      const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
      ]
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value])
          if (item !== undefined) lines.push(name + ': ' + item)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) upstreamSocket.write(head)
      if (upstreamHead.length) socket.write(upstreamHead)
      socket.pipe(upstreamSocket).pipe(socket)
    })
    outbound.end()
  }
  close(): void {
    for (const outbound of this.pending) outbound.destroy()
    for (const tunnel of this.tunnels) tunnel.destroy()
    this.pending.clear()
    this.tunnels.clear()
  }
}
