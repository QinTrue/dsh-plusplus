import { describe, expect, it, vi } from 'vitest'
import { Sessions } from '../../src/gateway/sessions.ts'

describe('gateway session expiry', () => {
  it('rechecks the absolute deadline after a maximum-length timer segment', async () => {
    vi.useFakeTimers()
    const sessions = new Sessions(new URL('http://gateway.test:19388'), 2_147_000_100, 10)
    try {
      const issued = sessions.create('native-cookie')!
      const now = Date.now()
      await vi.advanceTimersByTimeAsync(2_147_000_000)
      expect(sessions.get(issued)).toBeDefined()
      await vi.advanceTimersByTimeAsync(100)
      expect(Date.now()).toBe(now + 2_147_000_100)
      expect(sessions.get(issued)).toBeUndefined()
    } finally {
      sessions.clear()
      vi.useRealTimers()
    }
  })

  it('keeps permanent sessions in memory without a persistent browser cookie', () => {
    const sessions = new Sessions(new URL('https://gateway.test'), 0, 10, true)
    try {
      const issued = sessions.create('native-cookie')!
      expect(issued).not.toContain('Max-Age=')
      expect(sessions.get(issued)).toBeDefined()
    } finally {
      sessions.clear()
    }
  })
})
