import { createHash, timingSafeEqual } from 'node:crypto'

/** Tokens are opaque UTF-8, never silently trimmed or placed in HTTP headers. */
export function validToken(value: string): boolean {
  const bytes = Buffer.byteLength(value, 'utf8')
  return (
    bytes >= 32 &&
    bytes <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
}

export function tokensEqual(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(actual), digest(expected))
}
