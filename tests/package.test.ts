import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { name, apply, inject } from '../src/index.ts'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

describe('published package contract', () => {
  it('keeps host registration and package identity aligned', () => {
    expect(name).toBe('dsh-plusplus')
    expect(pkg.name).toBe(name)
    expect(typeof apply).toBe('function')
    expect(inject).toContain('settings')
    const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
    expect(patch).toContain('id: ' + pkg.name)
    expect(patch).toContain('name: ' + pkg.name)
    expect(pkg.bin).toBeUndefined()
  })

  it('pins the public browse directory picker for LAN and local browser clients', () => {
    const yaml = createRequire(fileURLToPath(new URL('package.json', root)))('js-yaml') as {
      load(input: string, options: { schema: typeof entryListSchema }): unknown
    }
    const patch = yaml.load(readFileSync(new URL('cordis.patch.yml', root), 'utf8'), {
      schema: entryListSchema,
    }) as Parameters<typeof applyEntryPatches>[1]
    const result = applyEntryPatches(
      [{ id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-auto' }],
      patch,
      () => {},
    )
    expect(result.find((entry) => entry.id === 'directory-picker')).toMatchObject({
      disabled: true,
      name: '@deepseek-ai/dsh-host-directory-picker-auto',
    })
    expect(result).toContainEqual({
      id: 'dsh-plusplus-directory-picker-browse',
      name: '@deepseek-ai/dsh-host-directory-picker-browse',
    })
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-directory-picker-browse')
  })

  it('ships usable JavaScript and declarations for every public entry', () => {
    for (const key of ['.', './client', './gateway']) {
      const entry = pkg.exports[key]
      expect(existsSync(new URL(entry.default, root)), key + ' JavaScript').toBe(true)
      expect(existsSync(new URL(entry.types, root)), key + ' declarations').toBe(true)
    }
    expect(existsSync(new URL('lib/worker.js', root))).toBe(true)
  })

  it('loads the built browser client through native module and settings slots', () => {
    type Client = { inject: string[]; apply: (ctx: unknown) => void }
    let moduleId: string | undefined
    let client: Client | undefined
    const require = createRequire(fileURLToPath(new URL('package.json', root)))
    const imports: string[] = []
    const nativeRequire = (id: string) => {
      imports.push(id)
      return id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id)
    }
    const removeStyle = () => {
      styleRemoved = true
    }
    let styleRemoved = false
    const style = { dataset: {}, textContent: '', remove: removeStyle }
    runInNewContext(readFileSync(new URL('lib/client.js', root), 'utf8'), {
      document: { createElement: () => style, head: { append() {} } },
      window: {
        __ModuleLoader__: {
          load(module: { id: string; factory: (require: NodeJS.Require) => Client }) {
            moduleId = module.id
            client = module.factory(nativeRequire as NodeJS.Require)
          },
        },
      },
    })
    expect(moduleId).toBe(pkg.name)
    expect(client?.inject).toEqual(['slots'])
    expect(imports).toContain('@deepseek-ai/dsh-client-ui-primitives')
    let registration: { name: string; id: string } | undefined
    let disposed = false
    const effects: (() => void)[] = []
    client!.apply({
      inject() {},
      effect(run: () => () => void) {
        effects.push(run())
      },
      slots: {
        inject(_name: string, mount: () => () => void) {
          return mount()
        },
        register(options: { name: string; id: string }, component: unknown) {
          registration = options
          expect(typeof component).toBe('function')
          return () => {
            disposed = true
          }
        },
      },
    })
    expect(registration).toMatchObject({ name: 'settings.section', id: 'dsh-plusplus-lan' })
    for (const dispose of effects) dispose()
    expect(disposed).toBe(true)
    expect(styleRemoved).toBe(true)
  })
})
