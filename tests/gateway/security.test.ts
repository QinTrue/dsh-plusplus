import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { AttemptBudget } from '../../src/gateway/rate-limit.ts'
import { readLoginBody } from '../../src/gateway/security.ts'
import { validToken } from '../../src/gateway/token.ts'

function input(headers: Record<string, string> = {}) {
  const stream = new PassThrough() as unknown as IncomingMessage
  Object.assign(stream, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    complete: false,
  })
  return stream
}

describe('bounded login input and peer budgets', () => {
  it('expires peer lockouts and refuses overflow without evicting locked peers', () => {
    let now = 0
    const budget = new AttemptBudget(() => now, 1000, 2, 2)
    expect(budget.reserve('::ffff:192.0.2.1')).toBeUndefined()
    expect(budget.reserve('192.0.2.1')).toBeUndefined()
    expect(budget.reserve('192.0.2.1')).toBe(1)
    expect(budget.reserve('192.0.2.2')).toBeUndefined()
    expect(budget.reserve('192.0.2.3')).toBe(1)
    expect(budget.reserve('192.0.2.1')).toBe(1)
    now = 1000
    expect(budget.reserve('192.0.2.1')).toBeUndefined()
    expect(budget.reserve('192.0.2.3')).toBeUndefined()
  })

  it('bounds chunked bodies and removes listeners after rejection', async () => {
    const req = input()
    const pending = readLoginBody(req, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ status: 413 })
    req.emit('data', Buffer.alloc(1025))
    await rejected
    expect(req.listenerCount('data')).toBe(0)
    expect(req.listenerCount('end')).toBe(0)
  })

  it('times out partial uploads and rejects pre-aborted readers', async () => {
    const req = input()
    const keepAlive = setTimeout(() => {}, 200)
    try {
      await expect(readLoginBody(req, new AbortController().signal, 5)).rejects.toMatchObject({
        status: 408,
      })
    } finally {
      clearTimeout(keepAlive)
    }
    const abort = new AbortController()
    abort.abort()
    await expect(readLoginBody(input(), abort.signal)).rejects.toMatchObject({ status: 503 })
  })

  it('requires exactly one valid token form field with bounded declared size', async () => {
    for (const body of ['token=a&token=b', 'other=x', 'token=a&other=x']) {
      const req = input()
      const pending = readLoginBody(req, new AbortController().signal)
      req.emit('data', Buffer.from(body))
      req.emit('end')
      await expect(pending).rejects.toMatchObject({ status: 400 })
    }
    await expect(
      readLoginBody(input({ 'content-length': '1025' }), new AbortController().signal),
    ).rejects.toMatchObject({ status: 413 })
    await expect(
      readLoginBody(input({ 'content-type': 'application/json' }), new AbortController().signal),
    ).rejects.toMatchObject({ status: 415 })
  })

  it('rejects weak, oversized, padded, and control-bearing tokens', () => {
    expect(validToken('a'.repeat(32))).toBe(true)
    expect(validToken('a'.repeat(31))).toBe(false)
    expect(validToken('a'.repeat(257))).toBe(false)
    expect(validToken(' ' + 'a'.repeat(32))).toBe(false)
    expect(validToken('a'.repeat(32) + '\n')).toBe(false)
  })
})
