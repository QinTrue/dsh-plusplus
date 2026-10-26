import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-config-editor'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { responseHeaders } from '../../gateway/security.ts'
import { ARCHIVE_ENDPOINT, ArchiveError } from './contract.ts'
import { ArchiveFiles } from './files.ts'
import { ArchiveManager } from './manager.ts'

/** Version gate is intentional: this module implements the missing storage operation. */
export function nativeArchiveRoot(ctx: Context): string {
  if (process.platform === 'win32')
    throw new ArchiveError('unsupported-host', '归档删除目前支持 Linux 和 macOS。', 503)
  const require = createRequire(ctx.profileContext.installAnchor)
  for (const name of [
    'dsh-session-persistence-jsonl',
    'dsh-workspace',
    'dsh-session-projection-cache',
    'dsh-session-query-sqlite',
  ]) {
    const pkg = JSON.parse(
      readFileSync(require.resolve('@deepseek-ai/' + name + '/package.json'), 'utf8'),
    ) as { version: string }
    if (!['0.2.1-rc.2', '0.2.1-rc.3'].includes(pkg.version))
      throw new ArchiveError('unsupported-host', '当前 DSH 版本尚未通过归档删除兼容验证。', 503)
  }
  const candidates = ctx.configEditor.entries().filter((entry) => {
    const module = entry.moduleNamespace as { name?: unknown } | undefined
    return (
      module?.name === 'session-persistence-jsonl' &&
      entry.fiber?.state === 2 &&
      entry.fiber.ctx.get('sessionPersistence')?.identity === ctx.sessionPersistence.identity
    )
  })
  const root: unknown = candidates.length === 1 ? candidates[0]!.fiber?.config.root : undefined
  if (typeof root !== 'string' || !isAbsolute(root))
    throw new ArchiveError('unsupported-storage', '无法确认当前 JSONL 会话存储目录。', 503)
  return root
}

export function admitArchiveRequest(ctx: Context, req: IncomingMessage): boolean {
  if (req.method !== 'GET' || req.headers.origin !== undefined) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || !req.headers.host) return false
    try {
      const parsed = new URL(origin)
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.origin !== origin ||
        new URL(parsed.protocol + '//' + req.headers.host).origin !== origin
      )
        return false
    } catch {
      return false
    }
  }
  return ctx.connection.requestRejection(req) === undefined
}

function readBody(req: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (
    req.headers['content-type'] !== 'application/json' ||
    (req.headers['content-length'] !== undefined &&
      (!/^\d+$/.test(req.headers['content-length']) ||
        Number(req.headers['content-length']) > 2048))
  )
    return Promise.reject(new ArchiveError('invalid-request', '无效的删除请求。', 400))
  return new Promise((resolve, reject) => {
    let settled = false
    let size = 0
    const chunks: Buffer[] = []
    const finish = (error?: Error, body?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', data).off('end', end).off('error', fail).off('aborted', fail)
      signal.removeEventListener('abort', fail)
      if (error) reject(error)
      else resolve(body!)
    }
    const fail = () => finish(new ArchiveError('invalid-request', '删除请求中断或超时。', 400))
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > 2048) fail()
      else chunks.push(chunk)
    }
    const end = () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          fail()
          return
        }
        finish(undefined, body as Record<string, unknown>)
      } catch {
        fail()
      }
    }
    const timer = setTimeout(fail, 5000)
    req.on('data', data).once('end', end).once('error', fail).once('aborted', fail)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
}

export function registerArchivedSessions(ctx: Context): void {
  ctx.inject(
    [
      'sessionPersistence',
      'sessions',
      'workspaceRegistry',
      'storageDomain',
      'sessionQuery',
      'sessionProjectionCache',
      'profileContext',
    ],
    (ctx) => {
      const life = new AbortController()
      let manager: ArchiveManager | undefined
      let unavailable: ArchiveError | undefined
      let revision = Date.now()
      const ready = (async () => {
        try {
          const files = new ArchiveFiles(nativeArchiveRoot(ctx))
          manager = new ArchiveManager(
            {
              persistence: ctx.sessionPersistence,
              archived: (id) => ctx.workspaceRegistry.archivedSessionIds.includes(id),
              live: (id) => ctx.sessions.get(id) !== undefined,
              liveHeaders: () => ctx.sessions.list().map((session) => session.header),
              activity: async (id) =>
                (
                  await ctx.waterfall('workspace/session-activity', { sessionId: id }, () =>
                    Promise.resolve([]),
                  )
                ).length > 0,
              cleanup: async (id) => {
                // Public domain handles keep the native cache's memory and disk coherent.
                await ctx.storageDomain.get('session_projcache')?.table('sessions').delete(id)
                // A normal search reconciles deleted sources through the native index owner.
                // The web profile disables full-text search by default. That explicit
                // refusal needs no index cleanup; every other failure remains retryable.
                try {
                  await ctx.sessionQuery.searchSessions({ query: 'dshpluspluscleanup', limit: 1 })
                } catch (error) {
                  if ((error as { code?: unknown })?.code !== 'SESSION_QUERY_SEARCH_DISABLED')
                    throw error
                }
                for (const workspace of ctx.workspaceRegistry.list())
                  await workspace.detachSession(id)
                await ctx.workspaceRegistry.unpinSession(id)
                await ctx.workspaceRegistry.unarchiveSession(id)
                revision++
              },
            },
            files,
          )
          await manager.recover()
        } catch (error) {
          unavailable =
            error instanceof ArchiveError
              ? error
              : new ArchiveError(
                  'unavailable',
                  '归档删除模块暂不可用，请检查当前 DSH 版本和会话存储。',
                  503,
                )
          await manager?.close()
          manager = undefined
        }
      })()
      ctx.effect(() => async () => {
        life.abort()
        await manager?.close()
        await ready
        await manager?.close()
      })
      ctx.effect(() =>
        ctx.webServer.register({
          kind: 'exact',
          path: ARCHIVE_ENDPOINT,
          async handler(req, res) {
            const reply = (status: number, value: unknown) => {
              if (res.destroyed || res.writableEnded) return
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
            if (!admitArchiveRequest(ctx, req)) {
              reply(403, { code: 'unauthorized', error: '请登录 DSH，并从同一地址操作。' })
              return
            }
            if (req.url !== ARCHIVE_ENDPOINT || !['GET', 'POST'].includes(req.method ?? '')) {
              reply(405, { error: '不支持的操作。' })
              return
            }
            try {
              await ready
              if (life.signal.aborted) throw new ArchiveError('stopped', '删除模块已停止。', 503)
              if (!manager)
                throw unavailable ?? new ArchiveError('unavailable', '删除模块不可用。', 503)
              if (req.method === 'GET') {
                reply(200, { available: true, revision })
                return
              }
              const body = await readBody(req, life.signal)
              if (
                Object.keys(body).some(
                  (key) => !['action', 'sessionId', 'createdAt', 'treeRevision'].includes(key),
                )
              )
                throw new ArchiveError('invalid-request', '无效的删除请求。', 400)
              if (
                body.action === 'preview' &&
                body.createdAt === undefined &&
                body.treeRevision === undefined
              ) {
                reply(200, await manager.preview(body.sessionId))
              } else if (
                body.action === 'delete' &&
                typeof body.sessionId === 'string' &&
                typeof body.createdAt === 'number' &&
                (body.treeRevision === undefined || typeof body.treeRevision === 'string')
              ) {
                await manager.delete({
                  sessionId: body.sessionId,
                  createdAt: body.createdAt,
                  ...(body.treeRevision !== undefined ? { treeRevision: body.treeRevision } : {}),
                })
                reply(200, { deleted: true, revision })
              } else throw new ArchiveError('invalid-request', '无效的删除请求。', 400)
            } catch (error) {
              const failure =
                error instanceof ArchiveError
                  ? error
                  : new ArchiveError(
                      'delete-incomplete',
                      '操作尚未确认完成。请重试以检查并完成清理；请勿取消归档。',
                      500,
                    )
              reply(failure.status, { code: failure.code, error: failure.message })
            }
          },
        }),
      )
    },
  )
}
