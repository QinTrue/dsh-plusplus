#!/usr/bin/env node
/** Build the host, browser client, and isolated gateway worker from one package identity. */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { isBuiltin } from 'node:module'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const output = resolve(root, 'lib')
rmSync(output, { recursive: true, force: true })
const shared = {
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  metafile: true,
}
const [, gatewayBuild, workerBuild] = await Promise.all([
  build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'lib/index.js' }),
  build({ ...shared, entryPoints: ['src/gateway/index.ts'], outfile: 'lib/gateway.js' }),
  build({ ...shared, entryPoints: ['src/gateway/worker.ts'], outfile: 'lib/worker.js' }),
])
for (const result of [gatewayBuild, workerBuild]) {
  for (const file of Object.values(result.metafile.outputs)) {
    if (file.imports.some((entry) => entry.external && !isBuiltin(entry.path)))
      throw new Error('Gateway artifacts must use only Node builtins')
  }
}
const client = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  packages: 'external',
  write: false,
})
const code = client.outputFiles[0].text
writeFileSync(
  resolve(output, 'client.js'),
  'window.__ModuleLoader__.load({ id: ' +
    JSON.stringify(pkg.name) +
    ', factory: (require) => { const module = { exports: {} }; const exports = module.exports;\n' +
    code +
    '\nreturn module.exports; } });\n',
)
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
const entry = await import(new URL('../lib/index.js', import.meta.url))
const gateway = await import(new URL('../lib/gateway.js', import.meta.url))
if (
  entry.name !== pkg.name ||
  typeof entry.apply !== 'function' ||
  typeof gateway.startGateway !== 'function' ||
  !pkg.dsh?.client ||
  !pkg.exports['./client'] ||
  !pkg.exports['./gateway']
)
  throw new Error('Invalid DSH++ package contract')
console.log(
  'Built ' + pkg.name + '@' + pkg.version + ' (settings plugin + independent gateway process)',
)
