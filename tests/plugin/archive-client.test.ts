// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createElement as h,
  type ComponentType,
  type ReactNode,
  type ButtonHTMLAttributes,
} from 'react'
import {
  ArchiveClient,
  ArchiveDeleteDialog,
  registerArchiveClient,
  type ArchiveClientContext,
  type ArchiveMenuProps,
} from '../../src/modules/archived-sessions/client.ts'

// The native browser loader supplies these components and their CSS. Unit tests
// exercise our controller at that boundary; native layout/focus are browser-verified.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({
    variant: _variant,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => h('button', props),
  Modal: ({
    title,
    onClose,
    children,
    footer,
  }: {
    title: string
    onClose(): void
    children: ReactNode
    footer: ReactNode
  }) =>
    h(
      'div',
      { role: 'dialog', 'aria-label': title },
      h('button', { onClick: onClose, 'aria-label': '关闭' }),
      children,
      footer,
    ),
  MenuItemButton: ({ onSelect, children }: { onSelect(): void; children: ReactNode }) =>
    h('button', { role: 'menuitem', onClick: onSelect }, children),
  IconTrashOutlineRegular: () => null,
  Toast: ({ text }: { text: string }) => h('div', { role: 'status' }, text),
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('archive deletion confirmation', () => {
  it('previews without deleting and cancel sends no delete request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({
        sessionId: 'one',
        createdAt: 9,
        pending: false,
        descendantCount: 0,
        treeRevision: 'a'.repeat(64),
      }),
    )
    vi.stubGlobal('fetch', fetch)
    const client = new ArchiveClient(async () => {})
    const dismiss = vi.spyOn(client, 'dismiss')
    render(h(ArchiveDeleteDialog, { client, target: { sessionId: 'one', title: 'Test archive' } }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(dismiss).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).action).toBe('preview')
    client.close()
  })

  it('requires a successful eligibility check and displays native refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ error: '会话仍被 DSH 持有。' }, 409)),
    )
    const client = new ArchiveClient(async () => {})
    render(h(ArchiveDeleteDialog, { client, target: { sessionId: 'one', title: '' } }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '会话仍被 DSH 持有。')
    expect(screen.queryByRole('button', { name: '永久删除' })).toBeNull()
    expect(screen.getByRole('button', { name: '重新检查' })).toBeDefined()
    client.close()
  })

  it('guards repeated confirmation, retries the same identity and refreshes only after success', async () => {
    let resolve!: (value: Response) => void
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          sessionId: 'one',
          createdAt: 9,
          pending: false,
          descendantCount: 2,
          treeRevision: 'a'.repeat(64),
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      )
      .mockResolvedValueOnce(response({ deleted: true }))
    vi.stubGlobal('fetch', fetch)
    const refresh = vi.fn(async () => {})
    const client = new ArchiveClient(refresh)
    const dismiss = vi.spyOn(client, 'dismiss')
    render(h(ArchiveDeleteDialog, { client, target: { sessionId: 'one', title: 'Archive' } }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    fireEvent.click(screen.getByRole('button', { name: '正在删除…' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(dismiss).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByText('将同时永久删除 2 个子代理会话（包括嵌套子代理）。')).toBeDefined()
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({
      treeRevision: 'a'.repeat(64),
      createdAt: 9,
    })
    await act(async () => {
      resolve(response({ error: '请重试清理。' }, 500))
    })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '请重试清理。')
    fireEvent.click(screen.getByRole('button', { name: '重试删除' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(fetch.mock.calls[1]![1]!.body).toBe(fetch.mock.calls[2]![1]!.body)
    client.close()
  })

  it('requires another preview and confirmation when the descendant tree changes', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        response({
          sessionId: 'one',
          createdAt: 9,
          descendantCount: 1,
          treeRevision: 'a'.repeat(64),
        }),
      )
      .mockResolvedValueOnce(response({ code: 'tree-changed', error: '请重新检查并确认。' }, 409))
      .mockResolvedValueOnce(
        response({
          sessionId: 'one',
          createdAt: 9,
          descendantCount: 2,
          treeRevision: 'b'.repeat(64),
        }),
      )
      .mockResolvedValueOnce(response({ deleted: true }))
    vi.stubGlobal('fetch', fetch)
    const refresh = vi.fn(async () => {})
    const client = new ArchiveClient(refresh)
    render(h(ArchiveDeleteDialog, { client, target: { sessionId: 'one', title: 'Archive' } }))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '重新检查' }))
    await screen.findByText('将同时永久删除 2 个子代理会话（包括嵌套子代理）。')
    expect(refresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    expect(JSON.parse(fetch.mock.calls[3]![1]!.body as string).treeRevision).toBe('b'.repeat(64))
    client.close()
  })

  it('registers a menu action only for archived rows and owns all native slots and polling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ available: true, revision: 0 })),
    )
    const effects: (() => void)[] = []
    const registrations = new Map<string, ComponentType<ArchiveMenuProps>>()
    const snapshot = { archivedSessionIds: ['archived'] }
    const disposed = vi.fn()
    const ctx: ArchiveClientContext = {
      effect(run) {
        effects.push(run())
      },
      inject(_names, run) {
        run(ctx)
      },
      workspaces: { list: { subscribe: () => () => {}, getSnapshot: () => snapshot } },
      sessions: { refresh: async () => {} },
      slots: {
        inject(_name, mount) {
          return mount()
        },
        register(options, component) {
          registrations.set(options.name, component as ComponentType<ArchiveMenuProps>)
          return disposed
        },
      },
    }
    registerArchiveClient(ctx)
    const Menu = registrations.get('sidebar.workspaces.session.menu.item')!
    const closeMenu = vi.fn()
    const view = render(
      h(Menu, {
        sessionId: 'archived',
        displayTitle: 'Archive',
        useMenuOpenState: () => [true, closeMenu] as const,
      }),
    )
    await screen.findByRole('menuitem', { name: '永久删除' })
    fireEvent.click(screen.getByRole('menuitem'))
    expect(closeMenu).toHaveBeenCalledWith(false)
    view.rerender(
      h(Menu, {
        sessionId: 'active',
        displayTitle: 'Live',
        useMenuOpenState: () => [true, closeMenu] as const,
      }),
    )
    expect(screen.queryByRole('menuitem')).toBeNull()
    for (const dispose of effects.reverse()) dispose()
    expect(disposed).toHaveBeenCalledTimes(2)
  })
})
