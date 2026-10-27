import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import { readTlsFile } from './tls-files.ts'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-config-editor'
import { GatewayChild } from './child.ts'
import { gatewayConfig, type GatewayOptions } from '../gateway/config.ts'
import { TOKEN_REF, type PluginConfig, type PluginValues } from './config.ts'
import { validToken } from '../gateway/token.ts'

export interface LanStatus {
  phase: 'off' | 'starting' | 'running' | 'error'
  message: string
  config: PluginValues
  origin: string
  suggestions: string[]
  tokenConfigured: boolean
  tokenWritable: boolean
  nativeLoopback: boolean
}
const REF = credentialRef(TOKEN_REF)
const isLoopback = (ip?: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
export const MANAGEMENT_PATH = '/api/dsh-plusplus/lan/manage'

/** Narrow explicit local settings controller. Native admission remains mandatory. */
export class LanManager {
  private child?: GatewayChild
  private closed = false
  private generation = 0
  private inFlight: Promise<void> = Promise.resolve()
  private observed = ''
  private renewal?: ReturnType<typeof setTimeout>
  private phase: LanStatus['phase'] = 'off'
  private message = ''
  private activeOrigin = ''
  private readonly life = new AbortController()
  constructor(
    private readonly ctx: Context,
    private readonly config: PluginConfig,
  ) {}
  values(): PluginValues {
    return { ...this.config.lan.get() }
  }
  suggestions(_port?: number): string[] {
    return [
      ...new Set(
        Object.values(networkInterfaces()).flatMap((list) =>
          (list ?? [])
            .filter((row) => row.family === 'IPv4' && !row.internal)
            .map((row) => row.address),
        ),
      ),
    ].sort()
  }
  private origin(values: PluginValues) {
    if (values.publicOrigin) return values.publicOrigin
    const address = this.suggestions()[0]
    if (!address) return ''
    const protocol = values.tlsCertPath || values.tlsKeyPath ? 'https' : 'http'
    return protocol + '://' + address + ':' + values.port
  }
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: () => void = () => {}
    const ended = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error('Operation stopped.'))
      timer = setTimeout(abort, 5000)
      this.life.signal.addEventListener('abort', abort, { once: true })
      if (this.life.signal.aborted) abort()
    })
    try {
      return await Promise.race([operation, ended])
    } finally {
      clearTimeout(timer)
      this.life.signal.removeEventListener('abort', abort)
    }
  }
  /** Public listener state is checked; no socket/config private fields are touched. */
  private async options(values: PluginValues): Promise<GatewayOptions> {
    if (this.ctx.webServer.host !== '127.0.0.1')
      throw new Error('请先将 DSH 原生监听地址改为 127.0.0.1 并重启；当前端口可绕过网关。')
    const origin = this.origin(values)
    if (!origin) throw new Error('未找到可用的局域网地址，请填写访问地址。')
    const token = (await this.bounded(this.ctx.credentials.resolve(REF)))?.value
    if (!token || !validToken(token)) throw new Error('请先设置或生成 32–256 字节的访问 token。')
    if (Boolean(values.tlsCertPath) !== Boolean(values.tlsKeyPath))
      throw new Error('HTTPS 需要同时配置证书和私钥路径。')
    const tls = values.tlsCertPath
      ? {
          cert: await this.bounded(readTlsFile(values.tlsCertPath, this.life.signal)),
          key: await this.bounded(readTlsFile(values.tlsKeyPath, this.life.signal)),
        }
      : undefined
    const upstreamUrl = this.ctx.connection.authenticatedUrl(
      'http://127.0.0.1:' + this.ctx.webServer.port,
    )
    const options = {
      token,
      upstreamUrl,
      publicOrigin: origin,
      port: values.port,
      host: '0.0.0.0',
      tls,
    }
    const checked = gatewayConfig(options)
    if (
      Number(checked.origin.port || (tls ? 443 : 80)) !== values.port ||
      values.port === this.ctx.webServer.port
    )
      throw new Error('访问地址端口须与网关端口一致，且不能占用 DSH 原生端口。')
    return options
  }
  /** Native settings/config changes and credential rotation invalidate the old child immediately. */
  reconcile(force = false): Promise<void> {
    const values = this.values()
    const snapshot = JSON.stringify([values, this.ctx.webServer.host, this.ctx.webServer.port])
    if (this.closed || (!force && snapshot === this.observed)) return this.inFlight
    this.observed = snapshot
    clearTimeout(this.renewal)
    const epoch = ++this.generation
    const previous = this.child
    this.child = undefined
    this.phase = values.enabled ? 'starting' : 'off'
    this.message = ''
    const stopped = previous?.close() ?? Promise.resolve()
    this.inFlight = this.inFlight
      .catch(() => {})
      .then(async () => {
        await stopped
        if (this.closed || epoch !== this.generation) return
        this.activeOrigin = ''
        if (!values.enabled) return
        try {
          const options = await this.options(values)
          if (this.closed || epoch !== this.generation) return
          const child = new GatewayChild(() => {
            if (this.child !== child || this.closed) return
            this.child = undefined
            this.phase = 'error'
            this.message = '网关已停止，请在设置中重新开启。'
          })
          this.child = child
          const nativeExpiresAt = await child.start(options)
          if (this.closed || epoch !== this.generation) {
            await child.close()
            return
          }
          this.activeOrigin = options.publicOrigin
          this.phase = 'running'
          // Renew the private native cookie without asking the operator for launch links/commands.
          this.renewal = setTimeout(
            () => {
              void this.reconcile(true)
            },
            Math.max(1000, Math.min(2_147_000_000, nativeExpiresAt - Date.now() - 60_000)),
          )
          this.renewal.unref()
        } catch {
          if (this.closed || epoch !== this.generation) return
          await this.child?.close()
          this.child = undefined
          this.phase = 'error'
          this.message =
            this.ctx.webServer.host !== '127.0.0.1'
              ? 'DSH 原生端口仍对外监听。请在本机将监听地址改为 127.0.0.1 并重启，再开启局域网访问。'
              : '启动失败。请检查 token、访问地址、端口占用及 HTTPS 证书。修正后重新开启。'
        }
      })
    return this.inFlight
  }
  async status(): Promise<LanStatus> {
    const info = await this.bounded(this.ctx.credentials.describe(REF))
    const config = this.values()
    return {
      phase: this.phase,
      message: this.message,
      config,
      origin: this.activeOrigin || this.origin(config),
      suggestions: this.suggestions(),
      tokenConfigured: info.configured,
      tokenWritable: info.writable,
      nativeLoopback: this.ctx.webServer.host === '127.0.0.1',
    }
  }
  private assertActive() {
    if (this.closed) throw new Error('Plugin stopped.')
  }
  private async persist(values: PluginValues): Promise<void> {
    this.assertActive()
    const entry = this.ctx.configEditor.entries().find((entry) => entry.fiber === this.ctx.fiber)
    if (!entry) throw new Error('Plugin settings unavailable.')
    const view = this.ctx.settings
      .describe({ redactSecrets: true })
      .find((row) => row.ns === entry.options.id)
    if (!view) throw new Error('Plugin settings unavailable.')
    this.assertActive()
    await this.ctx.settings.update(entry.options.id, { lan: values }, view.revision)
    this.assertActive()
  }
  /** Secret output is possible only on the explicit local Generate action. */
  async change(body: unknown): Promise<{ state?: LanStatus; token?: string }> {
    if (this.closed || !body || typeof body !== 'object' || Array.isArray(body))
      throw new Error('Invalid request.')
    const input = body as Record<string, unknown>
    if (input.action === 'generate' && Object.keys(input).length === 1) {
      const token = randomBytes(32).toString('base64url')
      await this.ctx.credentials.set(REF, token)
      this.assertActive()
      await this.reconcile(true)
      // A successful secret commit must remain visible even if its optional status read fails.
      try {
        return { state: await this.status(), token }
      } catch {
        return { token }
      }
    }
    if (
      input.action !== 'save' ||
      Object.keys(input).some((key) => !['action', 'config', 'token'].includes(key))
    )
      throw new Error('Invalid settings action.')
    const raw = input.config
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid settings.')
    const values = { ...(raw as PluginValues) }
    if (
      Object.keys(values).some(
        (key) => !['enabled', 'publicOrigin', 'port', 'tlsCertPath', 'tlsKeyPath'].includes(key),
      ) ||
      typeof values.enabled !== 'boolean' ||
      typeof values.publicOrigin !== 'string' ||
      !Number.isInteger(values.port) ||
      values.port < 1024 ||
      values.port > 65535 ||
      typeof values.tlsCertPath !== 'string' ||
      typeof values.tlsKeyPath !== 'string'
    )
      throw new Error('Invalid settings.')
    if (input.token !== undefined) {
      if (typeof input.token !== 'string' || !validToken(input.token))
        throw new Error('Invalid token.')
      await this.ctx.credentials.set(REF, input.token)
      this.assertActive()
    }
    if (values.enabled) {
      // Refuse before persisting a misleading enabled state.
      await this.options(values)
      this.assertActive()
    }
    this.assertActive()
    await this.persist(values)
    await this.reconcile(true)
    return { state: await this.status() }
  }
  admit(req: IncomingMessage): boolean {
    if (
      !isLoopback(req.socket.remoteAddress) ||
      req.headers['x-dsh-plusplus-gateway'] !== undefined
    )
      return false
    const authorities = ['127.0.0.1', 'localhost'].map(
      (host) => new URL('http://' + host + ':' + this.ctx.webServer.port).host,
    )
    if (!authorities.includes(req.headers.host ?? '')) return false
    if (
      (req.method !== 'GET' || req.headers.origin !== undefined) &&
      req.headers.origin !== 'http://' + req.headers.host
    )
      return false
    return this.ctx.connection.requestRejection(req) === undefined
  }
  async close(): Promise<void> {
    this.closed = true
    this.generation++
    this.life.abort()
    clearTimeout(this.renewal)
    await this.child?.close()
    this.child = undefined
    await this.inFlight.catch(() => {})
  }
}
