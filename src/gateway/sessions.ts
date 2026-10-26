import { createHash, randomBytes } from 'node:crypto'

export interface GatewaySession {
  readonly nativeCookie: string
  readonly expiresAt: number
  readonly connections: Set<() => void>
  timer: ReturnType<typeof setTimeout>
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Opaque independent sessions: no native credential or plaintext session ID is stored in a browser-visible payload. */
export class Sessions {
  readonly cookieName: string
  private readonly entries = new Map<string, GatewaySession>()
  constructor(
    private readonly origin: URL,
    private readonly ttlMs: number,
    private readonly capacity: number,
  ) {
    this.cookieName =
      (origin.protocol === 'https:' ? '__Host-' : '') +
      'dsh-plusplus-lan-' +
      digest(origin.origin).slice(0, 16)
  }
  private cookie(value: string, maxAge: number): string {
    return (
      this.cookieName +
      '=' +
      value +
      '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
      maxAge +
      (this.origin.protocol === 'https:' ? '; Secure' : '')
    )
  }
  clearCookie(): string {
    return this.cookie('', 0)
  }
  create(nativeCookie: string, nativeExpiresAt = Number.POSITIVE_INFINITY): string | undefined {
    this.prune()
    const ttl = Math.min(this.ttlMs, nativeExpiresAt - Date.now())
    if (this.entries.size >= this.capacity || ttl <= 0) return undefined
    const value = randomBytes(32).toString('base64url')
    const key = digest(value)
    const expiresAt = Date.now() + ttl
    const timer = setTimeout(() => this.remove(key), ttl)
    timer.unref()
    this.entries.set(key, { nativeCookie, expiresAt, connections: new Set(), timer })
    return this.cookie(value, Math.ceil(ttl / 1000))
  }
  private key(raw: string | undefined): string | undefined {
    const matches = (raw ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.startsWith(this.cookieName + '='))
    if (matches.length !== 1) return undefined
    const value = matches[0]!.slice(this.cookieName.length + 1)
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? digest(value) : undefined
  }
  get(raw: string | undefined): GatewaySession | undefined {
    const key = this.key(raw)
    if (!key) return undefined
    const session = this.entries.get(key)
    if (session && session.expiresAt <= Date.now()) {
      this.remove(key)
      return undefined
    }
    return session
  }
  revoke(raw: string | undefined): void {
    const key = this.key(raw)
    if (key) this.remove(key)
  }
  private remove(key: string): void {
    const session = this.entries.get(key)
    if (!session) return
    this.entries.delete(key)
    clearTimeout(session.timer)
    for (const close of session.connections) close()
    session.connections.clear()
  }
  private prune(): void {
    for (const [key, session] of this.entries) if (session.expiresAt <= Date.now()) this.remove(key)
  }
  clear(): void {
    for (const key of this.entries.keys()) this.remove(key)
  }
}
