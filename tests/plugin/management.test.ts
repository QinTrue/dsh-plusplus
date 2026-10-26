import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { LanManager } from '../../src/plugin/management.ts'
import type { PluginValues } from '../../src/plugin/config.ts'

const values: PluginValues = {
  enabled: false,
  publicOrigin: 'http://127.0.0.1:19388',
  port: 19388,
  tlsCertPath: '',
  tlsKeyPath: '',
}

describe('native listener requirement', () => {
  it.each(['0.0.0.0', '::', '192.0.2.10', '127.0.0.2', '::1'])(
    'refuses enabling on %s before reading secrets or persisting settings',
    async (host) => {
      const resolve = vi.fn()
      const update = vi.fn()
      const ctx = {
        webServer: { host, port: 3080 },
        credentials: { resolve },
        settings: { update },
      } as unknown as Context
      const manager = new LanManager(ctx, { lan: createVolatile(values) })
      try {
        await expect(
          manager.change({ action: 'save', config: { ...values, enabled: true } }),
        ).rejects.toThrow('127.0.0.1')
        expect(resolve).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
      } finally {
        await manager.close()
      }
    },
  )
})

function fixture(set: () => Promise<void>, describe: () => Promise<unknown>) {
  const ctx = {
    webServer: { host: '127.0.0.1', port: 3080 },
    credentials: { set, describe },
  } as unknown as Context
  return new LanManager(ctx, { lan: createVolatile(values) })
}

describe('settings secret commit semantics', () => {
  it('keeps a delayed credential commit pending instead of falsely reporting rollback', async () => {
    vi.useFakeTimers()
    let complete!: () => void
    const manager = fixture(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
      async () => ({ configured: true, writable: true }),
    )
    try {
      let finished = false
      const changed = manager.change({ action: 'generate' }).then((result) => {
        finished = true
        return result
      })
      await vi.advanceTimersByTimeAsync(6000)
      expect(finished).toBe(false)
      complete()
      const result = await changed
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(result.state?.phase).toBe('off')
    } finally {
      await manager.close()
      vi.useRealTimers()
    }
  })

  it('returns the newly committed token even when metadata refresh fails', async () => {
    const manager = fixture(
      async () => {},
      async () => {
        throw new Error('fixture metadata unavailable')
      },
    )
    try {
      const result = await manager.change({ action: 'generate' })
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(result.state).toBeUndefined()
    } finally {
      await manager.close()
    }
  })

  it('refuses subsequent work from a credential result that arrives after disposal', async () => {
    let complete!: () => void
    const describe = vi.fn(async () => ({ configured: true, writable: true }))
    const manager = fixture(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve
        }),
      describe,
    )
    const pending = manager.change({ action: 'generate' })
    const rejected = expect(pending).rejects.toThrow('Plugin stopped')
    await manager.close()
    complete()
    await rejected
    expect(describe).not.toHaveBeenCalled()
  })
})
