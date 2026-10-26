import { createHash } from 'node:crypto'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  ArchiveError,
  sessionIdentity,
  type DeletePreview,
  type DeleteRequest,
} from './contract.ts'
import {
  ArchiveFiles,
  MAX_DESCENDANTS,
  type DescendantIdentity,
  type Receipt,
  type StoredIdentity,
} from './files.ts'

export interface ArchiveHost {
  persistence: SessionPersistence
  archived(id: SessionId): boolean
  live(id: SessionId): boolean
  liveHeaders(): readonly SessionHeader[]
  activity(id: SessionId): Promise<boolean>
  cleanup(id: SessionId): Promise<void>
}
interface Tree {
  identity: StoredIdentity
  descendants?: DescendantIdentity[]
}
const members = (tree: Tree): StoredIdentity[] => [tree.identity, ...(tree.descendants ?? [])]
const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
function revision(tree: Tree): string {
  const rows = members(tree).map((member) => [
    member.sessionId,
    member.createdAt,
    member.cwd ?? null,
    'parentSession' in member ? member.parentSession : null,
  ])
  rows.sort((a, b) => compareIds(String(a[0]), String(b[0])))
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
function changed(): never {
  throw new ArchiveError('tree-changed', '会话或子代理列表已变化，请重新检查并确认。')
}

/** Owns admission, native write leases, deletion receipts and shutdown draining. */
export class ArchiveManager {
  private readonly life = new AbortController()
  private active?: Promise<unknown>
  private readonly receipts = new Map<string, Receipt>()
  private readonly owners = new Map<string, string>()
  constructor(
    private readonly host: ArchiveHost,
    private readonly files: ArchiveFiles,
  ) {}
  private assertOpen() {
    if (this.life.signal.aborted) throw new ArchiveError('stopped', '删除模块已停止。', 503)
  }
  private admit(tree: Tree, remaining: boolean) {
    this.assertOpen()
    if (remaining && !this.host.archived(tree.identity.sessionId as SessionId))
      throw new ArchiveError('not-archived', '只能删除已归档的会话。')
    if (members(tree).some((member) => this.host.live(member.sessionId as SessionId)))
      throw new ArchiveError(
        'in-use',
        '会话或子代理仍被 DSH 持有。请重启 DSH 后，在不打开该会话的情况下重试。',
      )
  }
  private identity(header: SessionHeader): StoredIdentity {
    return {
      sessionId: header.id,
      createdAt: header.createdAt,
      ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    }
  }
  private remember(receipt: Receipt) {
    this.receipts.set(receipt.identity.sessionId, receipt)
    for (const child of receipt.descendants ?? [])
      this.owners.set(child.sessionId, receipt.identity.sessionId)
  }
  private assertRoot(id: string) {
    if (this.owners.has(id))
      throw new ArchiveError('subagent', '请从所属的归档主会话删除子代理会话。')
  }
  /** A saved manifest fixes the tree even if earlier attempts removed some logs. */
  private async inspect(
    id: SessionId,
    known?: Tree,
    checkActivity = true,
  ): Promise<{
    tree: Tree
    present: StoredIdentity[]
  }> {
    this.assertOpen()
    const snapshots = await this.host.persistence.list({ signal: this.life.signal })
    const stored = new Map(snapshots.map((row) => [row.header.id, row]))
    const headers = [...snapshots.map((row) => row.header), ...this.host.liveHeaders()]
    let tree: Tree
    if (known) {
      tree = known
    } else {
      if (!this.host.archived(id)) throw new ArchiveError('not-archived', '只能删除已归档的会话。')
      const root = stored.get(id)
      if (!root) throw new ArchiveError('not-found', '会话不存在。', 404)
      if (root.header.origin === 'subagent')
        throw new ArchiveError('subagent', '请从所属的归档主会话删除子代理会话。')
      tree = { identity: this.identity(root.header) }
      const descendants: DescendantIdentity[] = []
      const seen = new Set<string>([id])
      const parents: string[] = [id]
      for (const parent of parents) {
        const children = headers
          .filter((header) => header.origin === 'subagent' && header.parentSession === parent)
          .sort((a, b) => compareIds(a.id, b.id))
        for (const child of children) {
          if (seen.has(child.id)) continue
          if (descendants.length >= MAX_DESCENDANTS)
            throw new ArchiveError('too-many-children', '子代理会话数量超过单次删除上限。')
          seen.add(child.id)
          parents.push(child.id)
          descendants.push({ ...this.identity(child), parentSession: parent })
        }
      }
      if (descendants.length) tree.descendants = descendants
    }
    const expected = new Map(members(tree).map((member) => [member.sessionId, member]))
    // Inspect edges from removed parents too: a retry cannot silently include
    // newly created children using an earlier confirmation.
    for (const header of headers) {
      if (
        header.origin === 'subagent' &&
        header.parentSession &&
        expected.has(header.parentSession)
      ) {
        const member = expected.get(header.id)
        if (
          !member ||
          !('parentSession' in member) ||
          member.parentSession !== header.parentSession
        )
          changed()
      }
    }
    const present: StoredIdentity[] = []
    for (const member of expected.values()) {
      const saved = this.receipts.get(member.sessionId)
      if (
        saved &&
        (saved.identity.createdAt !== member.createdAt || saved.identity.cwd !== member.cwd)
      )
        throw new ArchiveError('identity-changed', '会话身份或存储已变化，未继续清理。')
      const removed = saved && (saved.complete || this.files.remaining(saved).length === 0)
      const snapshot = stored.get(member.sessionId as SessionId)
      if (removed) {
        if (snapshot || this.host.live(member.sessionId as SessionId))
          throw new ArchiveError('identity-changed', '会话身份或存储已变化，未继续清理。')
      } else {
        if (!snapshot) changed()
        const header = snapshot.header
        if (header.createdAt !== member.createdAt || header.cwd !== member.cwd)
          throw new ArchiveError('identity-changed', '会话身份或存储已变化，未继续清理。')
        if (
          'parentSession' in member
            ? header.origin !== 'subagent' || header.parentSession !== member.parentSession
            : header.origin === 'subagent'
        )
          changed()
        if (snapshot.formatStatus === 'migration-required' || header.version !== 4)
          throw new ArchiveError(
            'unsupported-format',
            '会话或子代理日志需要升级。请先用 DSH 打开以升级，再归档并重启后删除。',
          )
        present.push(member)
      }
      if (checkActivity && (await this.host.activity(member.sessionId as SessionId)))
        throw new ArchiveError('in-use', '会话或子代理仍有任务或定时提醒，请停止相关活动后重试。')
    }
    // Activity hooks are asynchronous. Re-read the fixed tree after they settle,
    // so an added child or a changed identity cannot slip through that gap.
    if (checkActivity) return this.inspect(id, tree, false)
    this.admit(tree, present.length > 0)
    return { tree, present }
  }
  async preview(raw: unknown): Promise<DeletePreview> {
    const id = sessionIdentity(raw) as SessionId
    this.assertRoot(id)
    const known = this.receipts.get(id)
    const { tree } = await this.inspect(id, known)
    return {
      sessionId: id,
      createdAt: tree.identity.createdAt,
      pending: known !== undefined,
      descendantCount: tree.descendants?.length ?? 0,
      treeRevision: revision(tree),
    }
  }
  delete(input: DeleteRequest): Promise<void> {
    this.assertOpen()
    sessionIdentity(input.sessionId)
    this.assertRoot(input.sessionId)
    if (
      !Number.isSafeInteger(input.createdAt) ||
      input.createdAt < 0 ||
      (input.treeRevision !== undefined && !/^[a-f0-9]{64}$/.test(input.treeRevision))
    )
      return Promise.reject(new ArchiveError('invalid-request', '无效的会话身份。', 400))
    if (this.active)
      return Promise.reject(new ArchiveError('busy', '正在处理删除，请稍后重试。', 429))
    const operation = this.remove(input)
    this.active = operation
    void operation
      .finally(() => {
        if (this.active === operation) this.active = undefined
      })
      .catch(() => {})
    return operation
  }
  private async assertNotRecreated(receipt: Receipt) {
    this.assertOpen()
    const id = receipt.identity.sessionId as SessionId
    if (this.host.live(id) || (await this.host.persistence.stat(id, { signal: this.life.signal })))
      throw new ArchiveError('identity-changed', '会话身份或存储已变化，未继续清理。')
  }
  private group(tree: Tree): Receipt[] {
    return members(tree).map((member) => {
      const receipt = this.receipts.get(member.sessionId)
      if (
        !receipt ||
        receipt.identity.createdAt !== member.createdAt ||
        receipt.identity.cwd !== member.cwd
      )
        changed()
      return receipt
    })
  }
  private async finish(root: Receipt): Promise<void> {
    const { present } = await this.inspect(root.identity.sessionId as SessionId, root)
    if (present.length) changed()
    const group = this.group(root)
    // Children first; the archived root remains visible until every cleanup succeeds.
    for (const receipt of group.reverse()) {
      await this.assertNotRecreated(receipt)
      await this.host.cleanup(receipt.identity.sessionId as SessionId)
      this.files.complete(receipt)
      this.remember({ ...receipt, complete: true })
    }
  }
  private async remove(input: DeleteRequest): Promise<void> {
    const id = input.sessionId as SessionId
    const known = this.receipts.get(id)
    if (known && known.identity.createdAt !== input.createdAt)
      throw new ArchiveError('identity-changed', '会话身份已变化，请重新确认。')
    const { tree, present } = await this.inspect(id, known)
    if (tree.identity.createdAt !== input.createdAt)
      throw new ArchiveError('identity-changed', '会话身份已变化，请重新确认。')
    const confirmed = revision(tree)
    if (
      (input.treeRevision !== undefined || tree.descendants?.length) &&
      input.treeRevision !== confirmed
    )
      changed()
    if (!present.length && known) return this.finish(known)
    const handles: SessionHandle[] = []
    try {
      // Obtain every native lease before the first irreversible removal.
      for (const member of present) {
        try {
          const handle = await this.host.persistence.open(member.sessionId as SessionId, 'write', {
            signal: this.life.signal,
          })
          handles.push(handle)
          if (handle.header.createdAt !== member.createdAt || handle.header.cwd !== member.cwd)
            changed()
        } catch (error) {
          if ((error as Error).name === 'SessionAlreadyOwnedError')
            throw new ArchiveError('in-use', '会话或子代理被其他 DSH 进程占用，请释放后重试。')
          throw error
        }
      }
      const checked = await this.inspect(id, known)
      if (revision(checked.tree) !== confirmed || checked.present.length !== present.length)
        changed()
      const planned = members(tree).map((member, index) =>
        this.files.plan(member, index === 0 ? tree.descendants : undefined),
      )
      this.admit(tree, true)
      // The root manifest must reach disk before any child receipt or log removal.
      for (const receipt of planned) {
        try {
          this.files.prepare(receipt)
        } finally {
          const saved = this.files.receipt(receipt.identity)
          if (saved) this.remember(saved)
        }
      }
      // No asynchronous gaps: leaves first, root last, with a final lifecycle check.
      for (const receipt of [...planned].reverse()) {
        if (this.files.remaining(receipt).length)
          this.files.remove(receipt.identity, () => this.admit(tree, true))
      }
      await this.finish(planned[0]!)
    } finally {
      // Close every lease even if one close fails. Idle native handles append nothing.
      const closed = await Promise.allSettled(handles.reverse().map((handle) => handle.close()))
      const failed = closed.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
  }
  /** Recover only fully committed groups; never start another log removal. */
  async recover(): Promise<void> {
    for (const receipt of await this.files.receipts()) this.remember(receipt)
    for (const receipt of this.receipts.values()) {
      this.assertOpen()
      if (this.owners.has(receipt.identity.sessionId)) continue
      try {
        if (this.group(receipt).every((member) => !this.files.remaining(member).length))
          await this.finish(receipt)
      } catch {
        /* Keep the full manifest for an explicit retry. */
      }
    }
  }
  async close(): Promise<void> {
    this.life.abort()
    await this.active?.catch(() => {})
  }
}
