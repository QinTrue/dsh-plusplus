import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArchiveFiles } from '../../src/modules/archived-sessions/files.ts'
import { ArchiveManager, type ArchiveHost } from '../../src/modules/archived-sessions/manager.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
})

async function fixture(compression: 'none' | 'zstd' = 'none') {
  const root = new Context()
  const home = await mkdtemp(join(tmpdir(), 'dsh-plusplus-delete-'))
  const logs = join(home, 'logs')
  await mkdir(logs)
  await root.plugin(SessionStore)
  await root.plugin(Jsonl, { root: logs, compression })
  const archived = new Set<string>()
  const live = new Set<string>()
  let activity = false
  const cleanup = vi.fn(async (id: string) => {
    archived.delete(id)
  })
  const host: ArchiveHost = {
    persistence: root.sessionPersistence,
    archived: (id) => archived.has(id),
    live: (id) => live.has(id),
    liveHeaders: () => [],
    activity: async () => activity,
    cleanup,
  }
  const files = new ArchiveFiles(logs)
  let manager = new ArchiveManager(host, files)
  disposers.push(async () => {
    await manager.close()
    await root.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const create = async (id = 'archive-1', extra: Partial<SessionHeader> = {}) => {
    const header: SessionHeader = {
      id: SessionId(id),
      version: 4,
      createdAt: 100,
      isSeeded: false,
      delegationDepth: 0,
      ...extra,
    }
    const handle = await root.sessionPersistence.create(header)
    await handle.flush()
    await handle.close()
    archived.add(id)
    return {
      sessionId: id,
      createdAt: header.createdAt,
      ...(header.cwd ? { cwd: header.cwd } : {}),
    }
  }
  return {
    root,
    home,
    logs,
    files,
    get manager() {
      return manager
    },
    host,
    archived,
    live,
    cleanup,
    create,
    activity(value: boolean) {
      activity = value
    },
    async restartManager() {
      await manager.close()
      manager = new ArchiveManager(host, files)
      await manager.recover()
    },
  }
}

describe('archived session deletion with native JSONL ownership', () => {
  it.each(['none', 'zstd'] as const)(
    'deletes %s logs, keeps other sessions and can retry after restart',
    async (compression) => {
      const f = await fixture(compression)
      const identity = await f.create('target')
      await f.create('untouched')
      expect(await f.manager.preview('target')).toMatchObject({ ...identity, pending: false })
      const lockBefore = await readFile(join(f.files.directory(identity), 'session.lock'))
      await f.manager.delete(identity)
      expect(await f.root.sessionPersistence.stat(SessionId('target'))).toBeUndefined()
      expect(await f.root.sessionPersistence.stat(SessionId('untouched'))).toBeDefined()
      expect(await readdir(f.files.directory(identity))).toEqual(
        expect.arrayContaining(['session.lock', '.dsh-plusplus-delete.json']),
      )
      expect(await readFile(join(f.files.directory(identity), 'session.lock'))).toEqual(lockBefore)
      expect(f.files.receipt(identity)?.complete).toBe(true)
      await f.restartManager()
      await f.manager.delete(identity)
      expect(f.cleanup).toHaveBeenCalled()
    },
  )

  it('refuses unarchived, live, active, child-owned and stale identities without removing logs', async () => {
    const f = await fixture()
    const identity = await f.create()
    f.archived.clear()
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'not-archived' })
    f.archived.add(identity.sessionId)
    f.live.add(identity.sessionId)
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'in-use' })
    f.live.clear()
    f.activity(true)
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'in-use' })
    f.activity(false)
    await expect(f.manager.delete({ ...identity, createdAt: 101 })).rejects.toMatchObject({
      code: 'identity-changed',
    })
    await f.create('child', {
      parentSession: SessionId(identity.sessionId),
      origin: 'subagent',
      delegationDepth: 1,
    })
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'tree-changed' })
    await expect(f.manager.preview('child')).rejects.toMatchObject({ code: 'subagent' })
    expect(await f.root.sessionPersistence.stat(SessionId(identity.sessionId))).toBeDefined()
    expect(f.cleanup).not.toHaveBeenCalled()
  })

  it.each(['none', 'zstd'] as const)(
    'cascades %s nested subagents across directories and preserves forks',
    async (compression) => {
      const f = await fixture(compression)
      const root = await f.create('parent')
      const child = await f.create('child', {
        origin: 'subagent',
        parentSession: SessionId('parent'),
        cwd: f.home,
      })
      const nested = await f.create('nested', {
        origin: 'subagent',
        parentSession: SessionId('child'),
      })
      await f.create('fork', { parentSession: SessionId('parent') })
      await f.create('fork-child', { origin: 'subagent', parentSession: SessionId('fork') })
      f.archived.delete(child.sessionId)
      f.archived.delete(nested.sessionId)
      const preview = await f.manager.preview(root.sessionId)
      expect(preview).toMatchObject({ descendantCount: 2, pending: false })
      expect(preview.treeRevision).toMatch(/^[a-f0-9]{64}$/)
      await f.manager.delete(preview)
      for (const id of ['parent', 'child', 'nested']) {
        expect(await f.root.sessionPersistence.stat(SessionId(id))).toBeUndefined()
      }
      for (const id of ['fork', 'fork-child']) {
        expect(await f.root.sessionPersistence.stat(SessionId(id))).toBeDefined()
      }
      expect(f.cleanup.mock.calls.map(([id]) => id)).toEqual(['nested', 'child', 'parent'])
      expect(f.files.receipt(root)?.descendants).toHaveLength(2)
      await f.restartManager()
      await f.manager.delete(preview)
    },
  )

  it('preflights every child artifact and native writer before removing any log', async () => {
    const f = await fixture()
    const root = await f.create('parent')
    const child = await f.create('child', {
      origin: 'subagent',
      parentSession: SessionId('parent'),
    })
    const preview = await f.manager.preview(root.sessionId)
    const other = new Context()
    await other.plugin(Jsonl, { root: f.logs, compression: 'none' })
    const handle = await other.sessionPersistence.open(SessionId('child'), 'write')
    try {
      await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'in-use' })
      expect(f.files.receipt(root)).toBeUndefined()
    } finally {
      await handle.close()
      await other.fiber.dispose()
    }
    const unknown = join(f.files.directory(child), 'user-file')
    await writeFile(unknown, 'keep')
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'unsafe-storage' })
    expect(f.files.receipt(root)).toBeUndefined()
    for (const id of ['parent', 'child'])
      expect(await f.root.sessionPersistence.stat(SessionId(id))).toBeDefined()
    await rm(unknown)
    await f.manager.delete(preview)
  })

  it('refuses live, active and unsupported descendants and rechecks the confirmed tree under all locks', async () => {
    const f = await fixture()
    await f.create('parent')
    await f.create('child', { origin: 'subagent', parentSession: SessionId('parent') })
    const preview = await f.manager.preview('parent')
    f.live.add('child')
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'in-use' })
    f.live.clear()
    f.host.activity = async (id) => id === 'child'
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'in-use' })
    f.host.activity = async () => false
    const list = f.host.persistence.list.bind(f.host.persistence)
    const spy = vi
      .spyOn(f.host.persistence, 'list')
      .mockImplementation(async (options) =>
        (await list(options)).map((row) =>
          row.header.id === 'child' ? { ...row, formatStatus: 'migration-required' } : row,
        ),
      )
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'unsupported-format' })
    spy.mockRestore()
    let checks = 0
    f.host.activity = async (id) => {
      if (id === 'child' && ++checks === 2)
        await f.create('late-child', { origin: 'subagent', parentSession: SessionId('child') })
      return false
    }
    // The second inspection's list precedes this activity callback; a final list
    // after asynchronous admission must still catch the new member.
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'tree-changed' })
    expect(await f.root.sessionPersistence.stat(SessionId('parent'))).toBeDefined()
    expect(await f.root.sessionPersistence.stat(SessionId('child'))).toBeDefined()
  })

  it('requires a new confirmation if a descendant was added after preview', async () => {
    const f = await fixture()
    await f.create('parent')
    const preview = await f.manager.preview('parent')
    await f.create('child', { origin: 'subagent', parentSession: SessionId('parent') })
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'tree-changed' })
    expect(f.cleanup).not.toHaveBeenCalled()
    await f.manager.delete(await f.manager.preview('parent'))
  })

  it('keeps a durable cascade after a partial removal and only resumes log removal on explicit retry', async () => {
    const f = await fixture()
    const root = await f.create('parent')
    const a = await f.create('a', { origin: 'subagent', parentSession: SessionId('parent') })
    const b = await f.create('b', { origin: 'subagent', parentSession: SessionId('parent') })
    const preview = await f.manager.preview('parent')
    const remove = f.files.remove.bind(f.files)
    const interrupted = vi.spyOn(f.files, 'remove').mockImplementation((identity, admit) => {
      if (identity.sessionId === 'a') throw new Error('fixture interrupted')
      return remove(identity, admit)
    })
    await expect(f.manager.delete(preview)).rejects.toThrow('fixture interrupted')
    interrupted.mockRestore()
    expect(f.files.receipt(root)?.descendants).toHaveLength(2)
    expect(f.files.remaining(f.files.receipt(b)!)).toHaveLength(0)
    expect(f.files.remaining(f.files.receipt(a)!)).not.toHaveLength(0)
    await f.restartManager()
    expect(f.cleanup).not.toHaveBeenCalled()
    expect(await f.root.sessionPersistence.stat(SessionId('parent'))).toBeDefined()
    expect(await f.manager.preview('parent')).toMatchObject({
      pending: true,
      descendantCount: 2,
      treeRevision: preview.treeRevision,
    })
    await f.manager.delete(preview)
    expect(f.files.receipt(root)?.complete).toBe(true)
    expect(f.files.receipt(a)?.complete).toBe(true)
    expect(f.files.receipt(b)?.complete).toBe(true)
  })

  it('recovers a manifest persisted before child receipts, and preserves recreated or missing descendants', async () => {
    const f = await fixture()
    const root = await f.create('parent')
    const child = await f.create('child', {
      origin: 'subagent',
      parentSession: SessionId('parent'),
    })
    const preview = await f.manager.preview('parent')
    const prepare = f.files.prepare.bind(f.files)
    const interrupted = vi.spyOn(f.files, 'prepare').mockImplementation((receipt) => {
      if (receipt.identity.sessionId === 'child') throw new Error('fixture interrupted')
      prepare(receipt)
    })
    await expect(f.manager.delete(preview)).rejects.toThrow('fixture interrupted')
    interrupted.mockRestore()
    expect(f.files.receipt(root)?.descendants).toHaveLength(1)
    expect(f.files.receipt(child)).toBeUndefined()
    await f.restartManager()
    expect(f.cleanup).not.toHaveBeenCalled()
    // An unreceipted missing member is not proof of a completed deletion.
    const directory = f.files.directory(child)
    const log = (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!
    const bytes = await readFile(join(directory, log))
    await rm(join(directory, log))
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'tree-changed' })
    await writeFile(join(directory, log), bytes)
    f.cleanup.mockRejectedValueOnce(new Error('fixture cleanup failure'))
    await expect(f.manager.delete(preview)).rejects.toThrow('fixture cleanup failure')
    expect(f.archived.has('parent')).toBe(true)
    await f.create('child', {
      createdAt: 200,
      origin: 'subagent',
      parentSession: SessionId('parent'),
    })
    await f.restartManager()
    await expect(f.manager.delete(preview)).rejects.toMatchObject({ code: 'identity-changed' })
    expect((await f.root.sessionPersistence.stat(SessionId('child')))?.header.createdAt).toBe(200)
  })

  it('finishes all child metadata before removing the archived parent and recovers cleanup after restart', async () => {
    const f = await fixture()
    const root = await f.create('parent')
    const child = await f.create('child', {
      origin: 'subagent',
      parentSession: SessionId('parent'),
    })
    const preview = await f.manager.preview('parent')
    f.cleanup.mockRejectedValueOnce(new Error('fixture cleanup failure'))
    await expect(f.manager.delete(preview)).rejects.toThrow('fixture cleanup failure')
    expect(f.archived.has('parent')).toBe(true)
    expect(f.files.receipt(root)?.complete).toBe(false)
    await f.restartManager()
    expect(f.archived.has('parent')).toBe(false)
    expect(f.files.receipt(root)?.complete).toBe(true)
    expect(f.files.receipt(child)?.complete).toBe(true)
  })

  it('native write ownership refuses deletion by another persistence instance', async () => {
    const f = await fixture()
    const identity = await f.create()
    const other = new Context()
    await other.plugin(Jsonl, { root: f.logs, compression: 'none' })
    const handle = await other.sessionPersistence.open(SessionId(identity.sessionId), 'write')
    try {
      await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'in-use' })
      expect(await f.root.sessionPersistence.stat(SessionId(identity.sessionId))).toBeDefined()
    } finally {
      await handle.close()
      await other.fiber.dispose()
    }
    await f.manager.delete(identity)
  })

  it('rechecks archival after an asynchronous activity check and disposal prevents removal', async () => {
    const f = await fixture()
    const identity = await f.create()
    f.host.activity = async () => {
      f.archived.clear()
      return false
    }
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'not-archived' })
    f.archived.add(identity.sessionId)
    let release!: () => void
    f.host.activity = () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(false)
      })
    const removal = f.manager.delete(identity)
    const rejected = expect(removal).rejects.toMatchObject({ code: 'stopped' })
    await vi.waitFor(() => expect(release).toBeDefined())
    const closing = f.manager.close()
    release()
    await rejected
    await closing
    expect(await f.root.sessionPersistence.stat(SessionId(identity.sessionId))).toBeDefined()
  })

  it('recovers metadata cleanup after irreversible removal without calling missing a success', async () => {
    const f = await fixture()
    const identity = await f.create()
    // The former host adapter removed sidebar metadata before disabled search
    // threw. Recover that existing state even though it is no longer archived.
    f.cleanup.mockImplementationOnce(async (id) => {
      f.archived.delete(id)
      throw new Error('fixture failure')
    })
    await expect(f.manager.delete(identity)).rejects.toThrow('fixture failure')
    expect(await f.root.sessionPersistence.stat(SessionId(identity.sessionId))).toBeUndefined()
    expect(f.files.receipt(identity)?.complete).toBe(false)
    expect(f.archived.has(identity.sessionId)).toBe(false)
    await f.restartManager()
    expect(f.files.receipt(identity)?.complete).toBe(true)
    await expect(f.manager.delete({ sessionId: 'missing', createdAt: 100 })).rejects.toMatchObject({
      code: 'not-archived',
    })
  })

  it('rejects symlinked files and unknown artifacts, preserves user files and independent forks', async () => {
    const f = await fixture()
    const identity = await f.create('../target')
    await f.create('fork', { parentSession: SessionId(identity.sessionId) })
    const directory = f.files.directory(identity)
    const outside = join(f.home, 'user-file')
    await writeFile(outside, 'keep')
    await symlink(outside, join(directory, 'session.jsonl'))
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'unsafe-storage' })
    await rm(join(directory, 'session.jsonl'))
    await writeFile(join(directory, 'unknown.txt'), 'keep')
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'unsafe-storage' })
    await rm(join(directory, 'unknown.txt'))
    await f.manager.delete(identity)
    expect(await readFile(outside, 'utf8')).toBe('keep')
    expect(await f.root.sessionPersistence.stat(SessionId('fork'))).toBeDefined()
  })

  it('removes all old generations and does not erase a recreated identity using an old receipt', async () => {
    const f = await fixture()
    const identity = await f.create()
    const directory = f.files.directory(identity)
    await writeFile(join(directory, 'session.v2.jsonl'), 'old generation')
    await f.manager.delete(identity)
    expect((await readdir(directory)).some((name) => name.includes('.jsonl'))).toBe(false)
    await f.create(identity.sessionId, { createdAt: 200 })
    await expect(f.manager.delete(identity)).rejects.toMatchObject({ code: 'identity-changed' })
    expect(
      (await f.root.sessionPersistence.stat(SessionId(identity.sessionId)))?.header.createdAt,
    ).toBe(200)
  })
})
