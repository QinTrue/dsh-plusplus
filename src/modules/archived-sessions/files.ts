import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ArchiveError, sessionIdentity, type DeleteRequest } from './contract.ts'

const RECEIPT = '.dsh-plusplus-delete.json'
const TEMP = '.dsh-plusplus-delete.tmp'
const generation = /^session(?:\.v([1-4]))?\.jsonl(?:\.zstd)?$/
export const MAX_DESCENDANTS = 256
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024
export interface StoredIdentity extends Pick<DeleteRequest, 'sessionId' | 'createdAt'> {
  cwd?: string
}
export interface DescendantIdentity extends StoredIdentity {
  parentSession: string
}
export interface Receipt {
  version: 1
  identity: StoredIdentity
  files: string[]
  complete: boolean
  /** Only the root receipt carries the confirmed cascade, persisted before any unlink. */
  descendants?: DescendantIdentity[]
}

// DSH JSONL 0.2.1-rc.2/rc.3 path encoding. Kept here, with attribution, so the
// compatibility adapter can be removed without touching other DSH++ modules.
export function encodeSegment(value: string): string {
  if (value === '.' || value === '..') return '~002E'.repeat(value.length)
  return value.replace(
    /[^A-Za-z0-9._-]/g,
    (ch) => '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'),
  )
}
function projectKey(cwd: string): string {
  const readable = cwd
    .replace(/[\\/:]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, (ch) => encodeSegment(ch))
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
function unsafe(): never {
  throw new ArchiveError('unsafe-storage', '会话存储布局不受支持或已发生变化，未继续删除。')
}
function validateIdentity(identity: StoredIdentity): void {
  if (!identity || typeof identity !== 'object') unsafe()
  sessionIdentity(identity.sessionId)
  if (
    !Number.isSafeInteger(identity.createdAt) ||
    identity.createdAt < 0 ||
    (identity.cwd !== undefined && typeof identity.cwd !== 'string')
  )
    unsafe()
}
function validateDescendants(receipt: Receipt): void {
  if (receipt.descendants === undefined) return
  if (
    !Array.isArray(receipt.descendants) ||
    !receipt.descendants.length ||
    receipt.descendants.length > MAX_DESCENDANTS
  )
    unsafe()
  const seen = new Set([receipt.identity.sessionId])
  for (const child of receipt.descendants) {
    validateIdentity(child)
    sessionIdentity(child.parentSession)
    if (seen.has(child.sessionId) || !seen.has(child.parentSession)) unsafe()
    seen.add(child.sessionId)
  }
}
function regular(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) unsafe()
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Explicit JSONL compatibility adapter; never follows a client-supplied path. */
export class ArchiveFiles {
  readonly root: string
  constructor(root: string) {
    this.root = realpathSync(resolve(root))
  }
  directory(identity: StoredIdentity): string {
    sessionIdentity(identity.sessionId)
    const project = join(
      this.root,
      identity.cwd === undefined ? '_no-cwd' : projectKey(identity.cwd),
    )
    const directory = join(project, encodeSegment(identity.sessionId))
    for (const path of [this.root, project, directory]) {
      const info = lstatSync(path)
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) unsafe()
    }
    return directory
  }
  receipt(identity: StoredIdentity): Receipt | undefined {
    const directory = this.directory(identity)
    const path = join(directory, RECEIPT)
    try {
      regular(path)
      if (lstatSync(path).size > MAX_RECEIPT_BYTES) unsafe()
      const value = JSON.parse(readFileSync(path, 'utf8')) as Receipt
      validateIdentity(value.identity)
      validateDescendants(value)
      if (
        value.version !== 1 ||
        value.identity?.sessionId !== identity.sessionId ||
        value.identity.createdAt !== identity.createdAt ||
        value.identity.cwd !== identity.cwd ||
        typeof value.complete !== 'boolean' ||
        !Array.isArray(value.files) ||
        !value.files.length ||
        value.files.length > 10 ||
        value.files.some((file) => typeof file !== 'string' || !generation.test(file)) ||
        new Set(value.files).size !== value.files.length
      )
        unsafe()
      return value
    } catch (error) {
      if (absent(error)) return undefined
      if (error instanceof ArchiveError) throw error
      return unsafe()
    }
  }
  private write(receipt: Receipt): void {
    validateIdentity(receipt.identity)
    validateDescendants(receipt)
    const encoded = JSON.stringify(receipt) + '\n'
    if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) unsafe()
    const directory = this.directory(receipt.identity)
    const temp = join(directory, TEMP)
    try {
      regular(temp)
      unlinkSync(temp)
    } catch (error) {
      if (!absent(error)) throw error
    }
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try {
      writeFileSync(fd, encoded)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, join(directory, RECEIPT))
    syncDirectory(directory)
  }
  remaining(receipt: Receipt): string[] {
    const directory = this.directory(receipt.identity)
    const files: string[] = []
    for (const name of readdirSync(directory)) {
      if (name === 'session.lock' || name === RECEIPT || name === TEMP) {
        regular(join(directory, name))
        continue
      }
      if (!generation.test(name) || !receipt.files.includes(name)) unsafe()
      regular(join(directory, name))
      files.push(name)
    }
    return files
  }
  /** Validate every member before committing the cascade or removing any member. */
  plan(identity: StoredIdentity, descendants?: DescendantIdentity[]): Receipt {
    const directory = this.directory(identity)
    let receipt = this.receipt(identity)
    if (!receipt) {
      const files = readdirSync(directory).filter((name) => generation.test(name))
      if (!files.length || files.length > 10) unsafe()
      receipt = {
        version: 1,
        identity,
        files,
        complete: false,
        ...(descendants?.length ? { descendants } : {}),
      }
    }
    this.remaining(receipt)
    return receipt
  }
  /** The root manifest and every member receipt precede the first irreversible unlink. */
  prepare(receipt: Receipt): void {
    this.remaining(receipt)
    this.write(receipt)
  }
  /** Called only while holding the native write handle, after final admission. */
  remove(identity: StoredIdentity, admit: () => void): Receipt {
    const directory = this.directory(identity)
    const receipt = this.plan(identity)
    const remaining = this.remaining(receipt)
    // No asynchronous gap between the final state check and file removal.
    admit()
    this.write(receipt)
    // Old generations go first. A partial failure leaves the current log intact.
    remaining.sort(
      (a, b) => Number(generation.exec(a)?.[1] ?? 0) - Number(generation.exec(b)?.[1] ?? 0),
    )
    for (const file of remaining) unlinkSync(join(directory, file))
    syncDirectory(directory)
    // Keep session.lock's inode. Removing it would break native flock exclusion.
    return receipt
  }
  complete(receipt: Receipt): void {
    if (this.remaining(receipt).length) unsafe()
    this.write({ ...receipt, complete: true })
  }
  async receipts(): Promise<Receipt[]> {
    const found: Receipt[] = []
    for (const project of await readdir(this.root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue
      for (const session of await readdir(join(this.root, project.name), { withFileTypes: true })) {
        if (!session.isDirectory() || session.isSymbolicLink()) continue
        const path = join(this.root, project.name, session.name, RECEIPT)
        try {
          regular(path)
          if (lstatSync(path).size > MAX_RECEIPT_BYTES) unsafe()
          const raw = JSON.parse(readFileSync(path, 'utf8')) as Receipt
          if (join(this.directory(raw.identity), RECEIPT) !== path) unsafe()
          const receipt = this.receipt(raw.identity)
          if (receipt) found.push(receipt)
        } catch (error) {
          if (!absent(error)) throw error
        }
      }
    }
    return found
  }
}
