import { afterEach, describe, expect, it } from 'vitest'
import { request } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Readable } from 'node:stream'
import { once } from 'node:events'
import { fixture, login, cookie, send, ORIGIN } from './gateway-helpers.ts'
import type { Gateway } from '../../src/gateway/index.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup(...args: Parameters<typeof fixture>) {
  const f = await fixture(...args)
  cleanup.push(() => f.close())
  return f
}
function upgrade(
  gateway: Gateway,
  cookieValue?: string,
  origin = ORIGIN,
  path = '/unknown/future/socket',
  head = '',
): Promise<{ status: number; socket: Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port: gateway.address.port, host: '127.0.0.1', allowHalfOpen: true })
    let response = Buffer.alloc(0)
    socket.once('error', reject)
    socket.on('data', function receive(chunk) {
      response = Buffer.concat([response, chunk])
      const end = response.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', receive)
      resolve({
        status: Number(response.toString().split(' ')[1]),
        socket,
        head: response.subarray(end + 4),
      })
    })
    socket.once('connect', () =>
      socket.write(
        [
          'GET ' + path + ' HTTP/1.1',
          'Host: ' + new URL(ORIGIN).host,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Origin: ' + origin,
          ...(cookieValue ? ['Cookie: ' + cookieValue] : []),
          'X-Forwarded-For: 127.0.0.1',
          '',
          head,
        ].join('\r\n'),
      ),
    )
  })
}
function receive(socket: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const data = (chunk: Buffer) => {
      socket.off('error', failed)
      resolve(chunk)
    }
    const failed = (error: Error) => {
      socket.off('data', data)
      reject(error)
    }
    socket.once('data', data)
    socket.once('error', failed)
  })
}
function closed(socket: Readable): Promise<void> {
  return new Promise((resolve) => {
    socket.on('error', () => {})
    socket.once('end', () => socket.destroy())
    socket.once('close', resolve)
  })
}

describe('gateway stream and upgrade boundary', () => {
  it('rejects every anonymous or cross-origin upgrade before upstream sees any bytes', async () => {
    const f = await setup()
    for (const [value, origin, path] of [
      [undefined, ORIGIN, '/api/remote.mux'],
      ['dsh-auth-test=native-private-cookie', ORIGIN, '/unknown/future/socket'],
      [undefined, ORIGIN, '/lan'],
      [undefined, ORIGIN, '/?token=native-private-launch'],
    ] as const) {
      const reply = await upgrade(f.gateway, value, origin, path)
      expect(reply.status).toBe(401)
      await once(reply.socket, 'end')
      reply.socket.destroy()
    }
    const session = cookie(await login(f.gateway))
    const hostile = await upgrade(f.gateway, session, 'http://evil.test')
    expect(hostile.status).toBe(403)
    hostile.socket.destroy()
    expect(f.upgrades()).toBe(0)
  })

  it('never opens upstream upgrades for local management paths or their encoded aliases', async () => {
    const f = await setup()
    const session = cookie(await login(f.gateway))
    for (const path of [
      '/api/dsh-plusplus/lan/manage',
      '/api/%64sh-plusplus/lan/manage',
      '/api/other/../dsh-plusplus/lan/manage',
      '/api%2Fdsh-plusplus%2Flan%2Fmanage',
    ]) {
      const reply = await upgrade(f.gateway, session, ORIGIN, path)
      expect(reply.status).toBe(403)
      reply.socket.destroy()
    }
    expect(f.upgrades()).toBe(0)
  })

  it('preserves upgrade head/bidirectional bytes and logout closes the existing tunnel', async () => {
    const f = await setup()
    const session = cookie(await login(f.gateway))
    const reply = await upgrade(f.gateway, session, ORIGIN, '/future/ws?exact=%2F', 'initial-bytes')
    expect(reply.status).toBe(101)
    let initial = reply.head
    if (!initial.length) initial = await receive(reply.socket)
    expect(initial.toString()).toBe('initial-bytes')
    const echo = receive(reply.socket)
    reply.socket.write('bidirectional-bytes')
    expect((await echo).toString()).toBe('bidirectional-bytes')
    expect(f.upgrades()).toBe(1)
    const ended = closed(reply.socket)
    expect(
      (
        await send(f.gateway, '/lan/logout', {
          method: 'POST',
          headers: { cookie: session, origin: ORIGIN },
        })
      ).status,
    ).toBe(303)
    await ended
    expect(reply.socket.destroyed).toBe(true)
  })

  it('streams SSE immediately and logout cancels both sides', async () => {
    let upstreamClosed!: () => void
    const upstreamDone = new Promise<void>((resolve) => {
      upstreamClosed = resolve
    })
    const f = await setup({}, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      res.once('close', upstreamClosed)
    })
    const session = cookie(await login(f.gateway))
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: f.gateway.address.port,
          path: '/plugins/events',
          headers: { host: new URL(ORIGIN).host, cookie: session },
        },
        resolve,
      )
      req.once('error', reject)
      req.end()
    })
    expect(response.headers['content-type']).toBe('text/event-stream')
    expect((await receive(response)).toString()).toBe('data: first\n\n')
    const downstreamClosed = closed(response)
    response.on('error', () => {})
    await send(f.gateway, '/lan/logout', {
      method: 'POST',
      headers: { cookie: session, origin: ORIGIN },
    })
    await downstreamClosed
    await upstreamDone
    expect(response.destroyed).toBe(true)
  })

  it('absolute expiry closes an already-open websocket and shutdown aborts partial logins', async () => {
    const f = await setup({ sessionTtlMs: 120 })
    const session = cookie(await login(f.gateway))
    const ws = await upgrade(f.gateway, session)
    await closed(ws.socket)
    expect(ws.socket.destroyed).toBe(true)
    expect((await send(f.gateway, '/', { headers: { cookie: session } })).status).toBe(401)
    const partial = connect(f.gateway.address.port, '127.0.0.1')
    partial.on('error', () => {})
    await once(partial, 'connect')
    partial.write(
      'POST /lan/login HTTP/1.1\r\nHost: ' +
        new URL(ORIGIN).host +
        '\r\nOrigin: ' +
        ORIGIN +
        '\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\ntoken=partial',
    )
    partial.resume()
    const ended = closed(partial)
    await f.gateway.close()
    await ended
    await f.gateway.close()
  })

  it('unauthenticated Expect requests get no 100 Continue and authenticated ones can upload', async () => {
    const f = await setup({}, (req, res) => req.pipe(res))
    const anonymous = await send(f.gateway, '/upload', {
      method: 'POST',
      headers: { origin: ORIGIN, expect: '100-continue' },
    })
    expect(anonymous.status).toBe(401)
    expect(f.seen).toEqual([])
    const session = cookie(await login(f.gateway))
    const reply = await new Promise<{ body: string; continued: boolean }>((resolve, reject) => {
      let continued = false
      const req = request(
        {
          hostname: '127.0.0.1',
          port: f.gateway.address.port,
          path: '/upload',
          method: 'POST',
          headers: {
            host: new URL(ORIGIN).host,
            origin: ORIGIN,
            cookie: session,
            expect: '100-continue',
            'content-length': 7,
          },
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.once('end', () => resolve({ body, continued }))
        },
      )
      req.once('continue', () => {
        continued = true
        req.end('payload')
      })
      req.once('error', reject)
      req.flushHeaders()
    })
    expect(reply).toEqual({ body: 'payload', continued: true })
  })
})
