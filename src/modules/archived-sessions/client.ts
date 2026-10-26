import {
  createElement as h,
  Fragment,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
} from 'react'
import {
  Button,
  IconTrashOutlineRegular,
  MenuItemButton,
  Modal,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ARCHIVE_ENDPOINT, type DeletePreview } from './contract.ts'

interface Target {
  sessionId: string
  title: string
}
interface ClientState {
  available: boolean
  target?: Target
  notice: string
}
class ArchiveRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
  }
}
export interface ArchiveClientContext {
  effect(run: () => () => void): unknown
  inject(names: string[], callback: (ctx: ArchiveClientContext) => void): unknown
  workspaces: {
    list: {
      getSnapshot(): { archivedSessionIds: readonly string[] }
      subscribe(callback: () => void): () => void
    }
  }
  sessions: { refresh(): Promise<void> }
  slots: {
    inject(name: string, mount: () => () => void): () => void
    register<P>(
      options: { name: string; id: string; order: number; label?: string },
      component: ComponentType<P>,
    ): () => void
  }
}

/** One owned client controller; requests stop when the native module unloads. */
export class ArchiveClient {
  private state: ClientState = { available: false, notice: '' }
  private readonly listeners = new Set<() => void>()
  private readonly life = new AbortController()
  private revision?: number
  private timer?: ReturnType<typeof setTimeout>
  constructor(private readonly refreshSessions: () => Promise<void>) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(next: Partial<ClientState>) {
    if (this.life.signal.aborted) return
    this.state = { ...this.state, ...next }
    for (const listener of this.listeners) listener()
  }
  open(target: Target) {
    this.update({ target, notice: '' })
  }
  dismiss() {
    this.update({ target: undefined })
  }
  dismissNotice() {
    this.update({ notice: '' })
  }
  async request<T>(body?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.life.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    if (this.life.signal.aborted || signal?.aborted) abort()
    const timer = setTimeout(abort, 20_000)
    try {
      const response = await fetch(ARCHIVE_ENDPOINT, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const result = (await response.json()) as T & { error?: string; code?: string }
      if (!response.ok)
        throw new ArchiveRequestError(result.error || '归档删除暂不可用。', result.code)
      return result
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error('尚未收到操作结果。请重试确认，避免重复创建其他操作。')
      throw error
    } finally {
      clearTimeout(timer)
      this.life.signal.removeEventListener('abort', abort)
      signal?.removeEventListener('abort', abort)
    }
  }
  async removed() {
    this.update({ target: undefined, notice: '已永久删除归档会话。' })
    await this.refreshSessions().catch(() => {
      this.update({ notice: '会话已删除，请刷新页面更新列表。' })
    })
  }
  start() {
    const poll = async () => {
      try {
        const result = await this.request<{ available: boolean; revision: number }>()
        if (this.revision !== undefined && this.revision !== result.revision)
          await this.refreshSessions()
        this.revision = result.revision
        this.update({ available: result.available })
      } catch {
        this.update({ available: false })
      }
      if (!this.life.signal.aborted) this.timer = setTimeout(() => void poll(), 3000)
    }
    void poll()
  }
  close() {
    this.life.abort()
    clearTimeout(this.timer)
    this.listeners.clear()
  }
}

export interface ArchiveMenuProps {
  sessionId: string
  displayTitle: string
  useMenuOpenState(): readonly [boolean, (open: boolean) => void]
}
export function ArchiveDeleteDialog({
  client,
  target,
}: {
  client: ArchiveClient
  target: Target
}): ReactElement {
  const [preview, setPreview] = useState<DeletePreview>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const check = async (signal?: AbortSignal) => {
    setError('')
    setPreview(undefined)
    try {
      const result = await client.request<DeletePreview>(
        { action: 'preview', sessionId: target.sessionId },
        signal,
      )
      if (!signal?.aborted) setPreview(result)
    } catch (error) {
      if (!signal?.aborted) setError((error as Error).message)
    }
  }
  useEffect(() => {
    const life = new AbortController()
    void check(life.signal)
    return () => life.abort()
  }, [client, target.sessionId])
  const remove = async () => {
    if (!preview || submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await client.request({
        action: 'delete',
        sessionId: preview.sessionId,
        createdAt: preview.createdAt,
        treeRevision: preview.treeRevision,
      })
      await client.removed()
    } catch (error) {
      if (error instanceof ArchiveRequestError && error.code === 'tree-changed')
        setPreview(undefined)
      setError((error as Error).message)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return h(
    Modal,
    {
      open: true,
      title: '永久删除归档会话',
      closeLabel: '关闭',
      description: '删除后无法恢复。',
      className: 'dsh-plusplus-archive-dialog',
      onClose: () => {
        if (!submitting.current) client.dismiss()
      },
      footer: h(
        Fragment,
        null,
        h(
          Button,
          {
            type: 'button',
            variant: 'outline',
            ...{ 'data-modal-autofocus': true },
            disabled: busy,
            onClick: () => client.dismiss(),
          },
          '取消',
        ),
        h(
          Button,
          {
            type: 'button',
            variant: 'outline',
            className: 'dsh-plusplus-danger',
            disabled: busy || (!preview && !error),
            onClick: () => void (preview ? remove() : check()),
          },
          busy ? '正在删除…' : !preview && error ? '重新检查' : error ? '重试删除' : '永久删除',
        ),
      ),
    },
    h(
      'div',
      { className: 'dsh-plusplus-archive-target' },
      h('span', null, target.title || '未命名会话'),
      h('span', { className: 'dsh-plusplus-caption' }, target.sessionId),
    ),
    h(
      'p',
      { className: 'dsh-plusplus-description' },
      '会话记录将被永久删除。工作区文件、独立分支和共享附件会保留。',
    ),
    !preview && !error ? h('p', { role: 'status' }, '正在检查是否可以删除…') : null,
    preview && preview.descendantCount > 0
      ? h('p', null, `将同时永久删除 ${preview.descendantCount} 个子代理会话（包括嵌套子代理）。`)
      : null,
    preview?.pending ? h('p', null, '此前的删除已开始，将检查并完成剩余删除和清理。') : null,
    error ? h('p', { role: 'alert', className: 'dsh-plusplus-error' }, error) : null,
  )
}

export function registerArchiveClient(ctx: ArchiveClientContext) {
  ctx.inject(['workspaces', 'sessions'], (ctx) => {
    const client = new ArchiveClient(() => ctx.sessions.refresh())
    ctx.effect(() => {
      client.start()
      return () => client.close()
    })
    const MenuItem = ({ sessionId, displayTitle, useMenuOpenState }: ArchiveMenuProps) => {
      const state = useSyncExternalStore(client.subscribe, client.snapshot)
      const workspace = useSyncExternalStore(
        (fn) => ctx.workspaces.list.subscribe(fn),
        () => ctx.workspaces.list.getSnapshot(),
      )
      const [, setOpen] = useMenuOpenState()
      if (!state.available || !workspace.archivedSessionIds.includes(sessionId)) return null
      return h(MenuItemButton, {
        danger: true,
        separatorBefore: true,
        icon: h(IconTrashOutlineRegular, { size: 14 }),
        children: '永久删除',
        onSelect: () => {
          client.open({ sessionId, title: displayTitle })
          setOpen(false)
        },
      })
    }
    const Overlay = () => {
      const state = useSyncExternalStore(client.subscribe, client.snapshot)
      return state.target
        ? h(ArchiveDeleteDialog, { client, target: state.target, key: state.target.sessionId })
        : state.notice
          ? h(Toast, { text: state.notice, tone: 'success', onDone: () => client.dismissNotice() })
          : null
    }
    ctx.effect(() =>
      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-plusplus-delete-archive',
            order: 500,
          },
          MenuItem,
        ),
      ),
    )
    ctx.effect(() =>
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-plusplus-delete-archive-dialog', order: 50 },
          Overlay,
        ),
      ),
    )
  })
}
