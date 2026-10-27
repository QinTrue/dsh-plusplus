import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { nativeSession } from '../../src/gateway/native-auth.ts'
import { gatewayConfig } from '../../src/gateway/config.ts'
import { TOKEN, ORIGIN } from './gateway-helpers.ts'

describe('standalone upstream trust boundary', () => {
  it('refuses off-host, DNS, arbitrary paths, extra query parameters and invalid public origins', () => {
    const base = {
      token: TOKEN,
      publicOrigin: ORIGIN,
      upstreamUrl: 'http://127.0.0.1:3080/?token=private',
    }
    for (const upstreamUrl of [
      'http://localhost:3080/?token=x',
      'http://192.0.2.1/?token=x',
      'https://127.0.0.1/?token=x',
      'http://127.0.0.1/api?token=x',
      'http://127.0.0.1/?token=x&token=y',
      'http://127.0.0.1/?token=x&other=y',
      'http://user:pass@127.0.0.1/?token=x',
    ])
      expect(() => gatewayConfig({ ...base, upstreamUrl })).toThrow()
    for (const publicOrigin of [
      ORIGIN + '/',
      ORIGIN + '/lan',
      'null',
      'ftp://example.test',
      ORIGIN + '?x=y',
      'https://gateway.test',
    ])
      expect(() => gatewayConfig({ ...base, publicOrigin })).toThrow()
    expect(gatewayConfig(base).upstream.hostname).toBe('127.0.0.1')
    expect(gatewayConfig(base).sessionTtlMs).toBe(7 * 24 * 60 * 60_000)
    expect(() => gatewayConfig({ ...base, sessionTtlMs: 7 * 24 * 60 * 60_000 + 1 })).toThrow(
      '7 days',
    )
    expect(
      gatewayConfig({
        ...base,
        publicOrigin: 'https://gateway.test',
        tls: { cert: 'test', key: 'test' },
      }).origin.protocol,
    ).toBe('https:')
  })

  it('refuses a cookie that cannot authenticate the native index after exchange', async () => {
    let calls = 0
    const server = createServer((req, res) => {
      calls++
      if (req.url === '/?token=private') {
        res.writeHead(303, {
          location: './',
          'set-cookie': 'dsh-auth-test=value; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400',
        })
      } else res.writeHead(401)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = new URL(
        'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/?token=private',
      )
      await expect(nativeSession(url, new AbortController().signal)).rejects.toThrow(
        'Native DSH authentication failed',
      )
      expect(calls).toBe(2)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('fails closed on unexpected native status/cookie/redirect contracts without following redirects', async () => {
    let calls = 0
    let response = {
      status: 200,
      cookie: 'dsh-auth-test=value; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400',
      location: './',
    }
    const server = createServer((_req, res) => {
      calls++
      res.writeHead(response.status, { 'set-cookie': response.cookie, location: response.location })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const url = new URL(
        'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/?token=private',
      )
      for (const bad of [
        { status: 200 },
        { status: 303, cookie: 'other=value; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400' },
        { status: 303, cookie: 'dsh-auth-test=value; Path=/' },
        { status: 303, location: 'http://evil.invalid/' },
      ]) {
        response = Object.assign(
          {
            status: 303,
            cookie: 'dsh-auth-test=value; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400',
            location: './',
          },
          bad,
        )
        await expect(nativeSession(url, new AbortController().signal)).rejects.toThrow(
          'Native DSH authentication failed',
        )
      }
      expect(calls).toBe(4)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
