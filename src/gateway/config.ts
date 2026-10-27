import { validToken } from './token.ts'
import { loginThemeCss, type GatewayAppearance } from '../appearance/theme.ts'

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60_000
const MAX_SESSION_TTL_MS = 7 * 24 * 60 * 60_000

export interface GatewayOptions {
  /** Native DSH launch URL. Secret input, never a command-line argument or log. */
  upstreamUrl: string
  /** Exact externally visited origin, including a non-default port. Root mount only. */
  publicOrigin: string
  token: string
  host?: string
  port?: number
  tls?: { cert: string | Buffer; key: string | Buffer }
  sessionTtlMs?: number
  maxSessions?: number
  /** Shared --dsw-* light/dark values, also accepted by native theme.overrideTokens. */
  appearance?: GatewayAppearance
}
export interface GatewayConfig {
  upstream: URL
  origin: URL
  token: string
  host: string
  port: number
  tls?: GatewayOptions['tls']
  sessionTtlMs: number
  maxSessions: number
  loginTheme: string
}

export function gatewayConfig(options: GatewayOptions): GatewayConfig {
  let upstream: URL
  let origin: URL
  try {
    upstream = new URL(options.upstreamUrl)
    origin = new URL(options.publicOrigin)
  } catch {
    throw new Error('Provide a valid native loopback launch URL and public origin.')
  }
  if (
    upstream.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(upstream.hostname) ||
    upstream.username ||
    upstream.password ||
    upstream.pathname !== '/' ||
    upstream.hash ||
    upstream.searchParams.getAll('token').length !== 1 ||
    [...upstream.searchParams.keys()].some((key) => key !== 'token') ||
    !upstream.searchParams.get('token')
  ) {
    throw new Error(
      'Upstream must be a native HTTP launch URL at 127.0.0.1 or [::1], with exactly one token and no other path/query.',
    )
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== options.publicOrigin ||
    origin.username ||
    origin.password ||
    origin.hash ||
    origin.pathname !== '/' ||
    origin.search
  ) {
    throw new Error(
      'Public origin must be an exact http(s) origin without path, credentials or query.',
    )
  }
  if ((origin.protocol === 'https:') !== Boolean(options.tls))
    throw new Error('HTTPS requires certificate and key; HTTP cannot use TLS configuration.')
  if (!validToken(options.token))
    throw new Error(
      'DSH_PLUSPLUS_LAN_TOKEN must be 32–256 UTF-8 bytes without outer whitespace or control characters.',
    )
  const port = options.port ?? Number(origin.port || (origin.protocol === 'https:' ? 443 : 80))
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxSessions = options.maxSessions ?? 1024
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listen port.')
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1 || sessionTtlMs > MAX_SESSION_TTL_MS)
    throw new Error('Session lifetime must be positive and no more than 7 days.')
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 10_000)
    throw new Error('Session capacity must be between 1 and 10000.')
  return {
    upstream,
    origin,
    token: options.token,
    host: options.host ?? '0.0.0.0',
    port,
    tls: options.tls,
    sessionTtlMs,
    maxSessions,
    loginTheme: loginThemeCss(options.appearance),
  }
}
