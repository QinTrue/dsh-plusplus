#!/usr/bin/env node
/** Real native Loader + ConfigEditor + Settings + credentials, isolated temporary profile. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
const rootDir = process.env.DSH_PLUSPLUS_VERIFY_ROOT
  ? resolve(process.env.DSH_PLUSPLUS_VERIFY_ROOT)
  : fileURLToPath(new URL('../', import.meta.url))
const requireFrom = process.env.DSH_VERIFY_ROOT
  ? createRequire(pathToFileURL(resolve(process.env.DSH_VERIFY_ROOT, 'package.json')))
  : createRequire(import.meta.url)
const dependency = (name) => {
  try {
    return requireFrom.resolve(name)
  } catch {
    return createRequire(requireFrom.resolve('@deepseek-ai/dsh-config-editor')).resolve(name)
  }
}
const { boot, readProfilePatches } = await import(
  pathToFileURL(dependency('@deepseek-ai/dsh-app-boot')).href
)
const home = mkdtempSync(join(tmpdir(), 'dsh-plusplus-verify-'))
const profileDir = join(home, 'profiles', 'dsh-plusplus-test')
mkdirSync(profileDir, { recursive: true })
const patch = join(profileDir, 'cordis.patch.yml')
const configFile = join(profileDir, 'cordis.yml')
const credentialPath = join(home, 'credentials.yml')
const originServer = createServer()
await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve))
const gatewayPort = originServer.address().port
await new Promise((resolve) => originServer.close(resolve))
const origin = 'http://127.0.0.1:' + gatewayPort
const profile = {
  name: 'dsh-plusplus-test',
  dir: profileDir,
  patchPath: patch,
  installAnchor: dependency('@deepseek-ai/dsh-config-editor/package.json'),
  cwd: home,
  home,
  startedBundles: [],
  overlays: [],
  telemetryDisabledEnv: '1',
}
const rows = [
  {
    id: 'webserver',
    name: dependency('@deepseek-ai/dsh-host-webserver'),
    config: { host: '127.0.0.1', port: 0 },
  },
  {
    id: 'credentials',
    name: dependency('@deepseek-ai/dsh-credentials-local'),
    config: { path: credentialPath, watch: false, dshHome: home },
  },
  { id: 'connection', name: dependency('@deepseek-ai/dsh-client-connection') },
  { id: 'config-editor', name: dependency('@deepseek-ai/dsh-config-editor') },
  { id: 'settings', name: dependency('@deepseek-ai/dsh-settings') },
  { id: 'fixture-index', name: join(home, 'index-fixture.mjs') },
  { id: 'dsh-plusplus', name: join(rootDir, 'lib/index.js') },
]
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({
    name: 'dsh-plusplus-test-profile',
    type: 'module',
    dsh: { profile: { bundles: [] } },
  }),
)
writeFileSync(
  join(home, 'index-fixture.mjs'),
  `export const inject = ['webServer', 'connection']; export function apply(ctx) { ctx.effect(() => ctx.webServer.registerFallback((req, res) => { if (!ctx.connection.authorizeIndex(req, res)) return; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Native plugin fixture</title>') })); ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/unprotected', handler(_req, res) { res.end('unguarded-native-route') } })); }`,
)
writeFileSync(configFile, '[]\n')
writeFileSync(
  patch,
  JSON.stringify([{ insert: rows.map((row) => ({ ...row, name: pathToFileURL(row.name).href })) }]),
)
let root
let base, cookie
async function start() {
  root = await boot(
    'dsh-plusplus-test',
    configFile,
    readProfilePatches('dsh-plusplus-test', profile),
    (ctx) => ctx.provide('profileContext', profile),
  )
  base = 'http://127.0.0.1:' + root.webServer.port
  const auth = await fetch(root.connection.authenticatedUrl(base), { redirect: 'manual' })
  assert.equal(auth.status, 303)
  cookie = auth.headers.get('set-cookie').split(';')[0]
}
async function manage(body) {
  const response = await fetch(base + '/api/dsh-plusplus/lan/manage', {
    method: body ? 'POST' : 'GET',
    headers: { cookie, ...(body ? { origin: base, 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await response.json()
  assert.equal(response.status, 200, JSON.stringify(json))
  return json
}
const lanLogin = async (token) => {
  const response = await fetch(origin + '/lan/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  })
  assert.equal(response.status, 303)
  return response.headers.get('set-cookie').split(';')[0]
}
try {
  await start()
  assert.equal((await fetch(base + '/api/dsh-plusplus/lan/manage')).status, 403)
  assert.equal(
    (
      await fetch(base + '/api/dsh-plusplus/lan/manage', {
        headers: { cookie, origin: 'https://' + new URL(base).host },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await fetch(base + '/api/dsh-plusplus/lan/manage', {
        headers: { cookie, 'x-dsh-plusplus-gateway': '1' },
      })
    ).status,
    403,
  )
  const before = (await manage()).state
  assert.equal(before.phase, 'off')
  assert.equal(before.tokenConfigured, false)
  const generated = await manage({ action: 'generate' })
  assert.match(generated.token, /^[A-Za-z0-9_-]{43}$/)
  const config = { ...before.config, enabled: true, publicOrigin: origin, port: gatewayPort }
  const enabled = await manage({ action: 'save', config })
  assert.equal(enabled.state.phase, 'running', enabled.state.message)
  assert.equal((await fetch(origin + '/unprotected')).status, 401)
  let session = await lanLogin(generated.token)
  assert.equal(
    await (await fetch(origin + '/unprotected', { headers: { cookie: session } })).text(),
    'unguarded-native-route',
  )
  assert.equal(
    (await fetch(origin + '/api/dsh-plusplus/lan/manage', { headers: { cookie: session } })).status,
    403,
  )
  const newToken = (await manage({ action: 'generate' })).token
  assert.equal((await fetch(origin + '/unprotected', { headers: { cookie: session } })).status, 401)
  session = await lanLogin(newToken)
  const saved = readFileSync(patch, 'utf8')
  assert.equal(saved.includes(newToken), false)
  assert.equal(saved.includes('enabled: true'), true)
  assert.equal(JSON.stringify(await manage()).includes(newToken), false)
  const disabled = await manage({ action: 'save', config: { ...config, enabled: false } })
  assert.equal(disabled.state.phase, 'off')
  await assert.rejects(fetch(origin + '/unprotected'))
  // Two settings tabs: delayed enable may not reopen access after the later disable completes.
  const changes = await Promise.all([
    manage({ action: 'save', config }),
    manage({ action: 'save', config: { ...config, enabled: false } }),
  ])
  assert.equal(changes[1].state.phase, 'off')
  assert.equal((await manage()).state.config.enabled, false)
  await assert.rejects(fetch(origin + '/unprotected'))
  await manage({ action: 'save', config })
  await root.fiber.dispose()
  root = undefined
  await assert.rejects(fetch(origin + '/unprotected'))
  await start()
  // Persisted enable restores automatically, without a command or another Save.
  let restored
  for (let attempt = 0; attempt < 100; attempt++) {
    restored = (await manage()).state
    if (restored.phase === 'running' || restored.phase === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(restored.phase, 'running', restored.message)
  assert.equal((await fetch(origin + '/unprotected', { headers: { cookie: session } })).status, 401)
  await lanLogin(newToken)
  await manage({ action: 'save', config: { ...config, enabled: false } })
  const webEntry = root.configEditor.entries().find((entry) => entry.options.id === 'webserver')
  // Test the management fence using a concrete address confined to loopback.
  await root.configEditor.edit(webEntry, (current) => ({ ...current, host: '127.0.0.2' }))
  base = 'http://127.0.0.2:' + root.webServer.port
  const auth = await fetch(root.connection.authenticatedUrl(base), { redirect: 'manual' })
  cookie = auth.headers.get('set-cookie').split(';')[0]
  const denied = await fetch(base + '/api/dsh-plusplus/lan/manage', {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'save', config }),
  })
  assert.equal(denied.status, 403)
  await assert.rejects(fetch(origin + '/unprotected'))
  console.log(
    'Verified settings plugin with native Loader/Settings/ConfigEditor/credentials: generate, enable, rotate, disable, persistence, restart, local-only management, loopback enforcement and child disposal.',
  )
} finally {
  await root?.fiber.dispose()
  const target = realpathSync(home)
  if (!target.startsWith(realpathSync(tmpdir()) + '/dsh-plusplus-verify-'))
    throw new Error('Unexpected fixture cleanup target')
  rmSync(target, { recursive: true, force: true })
}
