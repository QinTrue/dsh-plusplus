import { createHash, randomBytes } from 'node:crypto'

export interface GatewaySession {
  nativeCookie: string
  expiresAt: number
  readonly connections: Set<() => void>
  timer?: ReturnType<typeof setTimeout>
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
    private readonly permanent = false,
  ) {
    this.cookieName =
      (origin.protocol === 'https:' ? '__Host-' : '') +
      'dsh-plusplus-lan-' +
      digest(origin.origin).slice(0, 16)
  }
  private cookie(value: string, maxAge?: number): string {
    return (
      this.cookieName +
      '=' +
      value +
      '; Path=/; HttpOnly; SameSite=Strict' +
      (maxAge === undefined ? '' : '; Max-Age=' + maxAge) +
      (this.origin.protocol === 'https:' ? '; Secure' : '')
    )
  }
  clearCookie(): string {
    return this.cookie('', 0)
  }
  create(nativeCookie: string, nativeExpiresAt = Number.POSITIVE_INFINITY): string | undefined {
    this.prune()
    const ttl = this.permanent ? Number.POSITIVE_INFINITY : this.ttlMs
    if (this.entries.size >= this.capacity || ttl <= 0 || nativeExpiresAt <= Date.now())
      return undefined
    const value = randomBytes(32).toString('base64url')
    const key = digest(value)
    const expiresAt = Date.now() + ttl
    const session: GatewaySession = {
      nativeCookie,
      expiresAt,
      connections: new Set<() => void>(),
    }
    if (Number.isFinite(ttl)) this.scheduleExpiry(key, session)
    this.entries.set(key, session)
    return this.permanent ? this.cookie(value) : this.cookie(value, Math.ceil(ttl / 1000))
  }
  private scheduleExpiry(key: string, session: GatewaySession): void {
    const remaining = session.expiresAt - Date.now()
    session.timer = setTimeout(
      () => {
        if (session.expiresAt <= Date.now()) this.remove(key)
        else this.scheduleExpiry(key, session)
      },
      Math.min(remaining, 2_147_000_000),
    )
    session.timer.unref()
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
  refreshNativeCookie(cookie: string): void {
    for (const session of this.entries.values()) session.nativeCookie = cookie
  }
  revoke(raw: string | undefined): void {
    const key = this.key(raw)
    if (key) this.remove(key)
  }
  private remove(key: string): void {
    const session = this.entries.get(key)
    if (!session) return
    this.entries.delete(key)
    if (session.timer) clearTimeout(session.timer)
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
