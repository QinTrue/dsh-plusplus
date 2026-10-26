#!/usr/bin/env node
/** Built independent gateway against real native Connection/WebServer; no installed DSH changes. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { startGateway } from '../lib/gateway.js'
const requireFrom = process.env.DSH_VERIFY_ROOT
  ? createRequire(pathToFileURL(resolve(process.env.DSH_VERIFY_ROOT, 'package.json')))
  : createRequire(import.meta.url)
const load = (name) => import(pathToFileURL(requireFrom.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { WebServer } = await load('@deepseek-ai/dsh-host-webserver')
const connectionPlugin = await load('@deepseek-ai/dsh-client-connection')
const root = new Context()
let credentialRecord
root.provide('credentials', {
  async modifyRecord(_key, mutate) {
    const next = await mutate(credentialRecord)
    if (next !== undefined) credentialRecord = next
    return credentialRecord
  },
})
const origin = 'http://native-gateway.test:19388'
const token = 'integration-only-gateway-token-do-not-deploy'
let gateway
try {
  await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await root.plugin(connectionPlugin)
  const base = 'http://127.0.0.1:' + root.webServer.port
  root.connection.fetch.register({
    path: '/api/plusplus-verify',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return new Response('native-authenticated-api')
    },
  })
  let nativeUpgrades = 0
  root.webServer.registerUpgrade({
    path: '/api/plusplus-verify-ws',
    handler(req, socket) {
      nativeUpgrades++
      const rejection = root.connection.requestRejection(req)
      if (rejection) {
        socket.end(
          'HTTP/1.1 ' + rejection + ' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        )
        return
      }
      const accept = createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n',
      )
      socket.on('error', () => {})
      socket.on('data', (chunk) => socket.write(chunk))
    },
  })
  let unprotectedHits = 0
  root.webServer.register({
    kind: 'exact',
    path: '/future-unprotected',
    handler(_req, res) {
      unprotectedHits++
      res.end('unprotected-native-handler')
    },
  })
  root.webServer.registerFallback((req, res) => {
    if (!root.connection.authorizeIndex(req, res)) return
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>Native index fixture</title>')
  })
  assert.equal((await fetch(base + '/api/plusplus-verify')).status, 401)
  const launchUrl = root.connection.authenticatedUrl(base)
  gateway = await startGateway({
    token,
    upstreamUrl: launchUrl,
    publicOrigin: origin,
    host: '127.0.0.1',
    port: 0,
  })
  const send = (path, { cookie, method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: gateway.address.port,
          path,
          method,
          headers: { host: new URL(origin).host, ...(cookie ? { cookie } : {}), ...headers },
        },
        (res) => {
          let text = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => {
            text += chunk
          })
          res.once('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: text }),
          )
        },
      )
      req.once('error', reject)
      req.end(body)
    })
  const login = (value) =>
    send('/lan/login', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: value }).toString(),
    })
  for (const path of [
    '/api/plusplus-verify',
    '/future-unprotected',
    '/',
    new URL(launchUrl).pathname + new URL(launchUrl).search,
  ])
    assert.equal((await send(path)).status, 401)
  assert.equal(unprotectedHits, 0)
  assert.equal((await login('wrong')).status, 401)
  const signed = await login(token)
  assert.equal(signed.status, 303)
  const cookie = signed.headers['set-cookie'][0].split(';')[0]
  const upgrade = (session) =>
    new Promise((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1',
        port: gateway.address.port,
        path: '/api/plusplus-verify-ws',
        headers: {
          host: new URL(origin).host,
          origin,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...(session ? { cookie: session } : {}),
        },
      })
      req.once('error', reject)
      req.once('response', (res) => {
        res.resume()
        resolve({ status: res.statusCode })
      })
      req.once('upgrade', (res, socket) => resolve({ status: res.statusCode, socket }))
      req.end()
    })
  assert.equal((await upgrade()).status, 401)
  assert.equal(nativeUpgrades, 0)
  const tunnel = await upgrade(cookie)
  assert.equal(tunnel.status, 101)
  assert.equal(nativeUpgrades, 1)
  const echo = new Promise((resolve) =>
    tunnel.socket.once('data', (chunk) => resolve(chunk.toString())),
  )
  tunnel.socket.write('native-authenticated-websocket')
  assert.equal(await echo, 'native-authenticated-websocket')
  tunnel.socket.destroy()
  assert.match(cookie, /^dsh-plusplus-lan-/)
  assert.equal(JSON.stringify(signed).includes('dsh-auth-'), false)
  assert.equal((await send('/', { cookie })).status, 200)
  assert.equal(
    (await send('/api/plusplus-verify', { cookie, headers: { origin } })).body,
    'native-authenticated-api',
  )
  assert.equal((await send('/future-unprotected', { cookie })).body, 'unprotected-native-handler')
  assert.equal(unprotectedHits, 1)
  assert.equal(
    (await send('/api/plusplus-verify', { cookie, headers: { origin: 'http://hostile.test' } }))
      .status,
    403,
  )
  await gateway.close()
  gateway = await startGateway({
    token,
    upstreamUrl: launchUrl,
    publicOrigin: origin,
    host: '127.0.0.1',
    port: 0,
  })
  assert.equal((await send('/api/plusplus-verify', { cookie })).status, 401)
  assert.equal((await login(token)).status, 303)
  assert.equal((await fetch(base + '/api/plusplus-verify')).status, 401)
  console.log(
    'Verified independent gateway with real DSH: native cookie/API/WebSocket/trust, public upstream denial, restart revocation, no plugin or native changes.',
  )
} finally {
  await gateway?.close()
  await root.fiber.dispose()
}
