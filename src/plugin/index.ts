import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import { Config, TOKEN_REF, type PluginConfig } from './config.ts'
import { LanManager, MANAGEMENT_PATH } from './management.ts'
import { responseHeaders } from '../gateway/security.ts'
import type { IncomingMessage } from 'node:http'

export { Config }
export const name = 'dsh-plusplus'
export const inject = ['webServer', 'connection', 'credentials', 'settings', 'configEditor']
function readRequest(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const fail = () => finish(new Error('Invalid settings request.'))
    const data = (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 8192) fail()
      else chunks.push(chunk)
    }
    const end = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        fail()
      }
    }
    const timer = setTimeout(fail, 5000)
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer)
      req.off('data', data)
      req.off('end', end)
      req.off('aborted', fail)
      req.off('error', fail)
      signal.removeEventListener('abort', fail)
      if (error) reject(error)
      else resolve(value)
    }
    req.on('data', data)
    req.once('end', end)
    req.once('aborted', fail)
    req.once('error', fail)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
}

export function apply(ctx: Context, config: PluginConfig): void {
  const manager = new LanManager(ctx, config)
  const life = new AbortController()
  let closed = false
  let writes: Promise<unknown> = Promise.resolve()
  // Stop child first on disposal; asynchronous startup cannot outlive the owner.
  ctx.effect(() => async () => {
    closed = true
    life.abort()
    const stopped = manager.close()
    await writes.catch(() => {})
    await stopped
  })
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: MANAGEMENT_PATH,
      async handler(req, res) {
        const reply = (status: number, value: unknown) => {
          if (closed || res.destroyed || res.writableEnded) return
          res.writeHead(status, {
            ...responseHeaders,
            'content-type': 'application/json; charset=utf-8',
            connection: 'close',
          })
          res.end(JSON.stringify(value))
          if (!req.readableEnded) {
            req.on('error', () => {})
            res.once('finish', () => req.destroy())
          }
        }
        if (closed || !manager.admit(req)) {
          reply(403, { error: '请在本机 DSH 设置中管理局域网访问。' })
          return
        }
        if (req.url !== MANAGEMENT_PATH || !['GET', 'POST'].includes(req.method ?? '')) {
          reply(405, { error: '不支持的设置操作。' })
          return
        }
        try {
          if (req.method === 'GET') {
            reply(200, { state: await manager.status() })
            return
          }
          if (
            req.headers['content-type'] !== 'application/json' ||
            Number(req.headers['content-length'] ?? 0) > 8192
          ) {
            reply(400, { error: '无效的设置请求。' })
            return
          }
          const body = await readRequest(req, life.signal)
          if (closed) return
          const change = writes
            .catch(() => {})
            .then(() => {
              if (closed) throw new Error('Plugin stopped.')
              return manager.change(body)
            })
          writes = change
          reply(200, await change)
        } catch {
          reply(400, {
            error: '保存失败。请检查 token、访问地址、证书和本机监听状态；原生配置可能只读。',
          })
        }
      },
    }),
  )
  // Public native Loader event: values are committed before this owning-fiber notification.
  ctx.on('loader/volatile-update', () => {
    void manager.reconcile()
  })
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === TOKEN_REF) void manager.reconcile(true)
  })
  // Let native frontend/auth providers settle before the worker's startup HTML check.
  void ctx.root.loader
    .await()
    .then(() => manager.reconcile())
    .catch(() => {})
}
