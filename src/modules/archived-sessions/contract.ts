export const ARCHIVE_ENDPOINT = '/api/dsh-plusplus/archived-sessions'

export interface DeleteRequest {
  sessionId: string
  createdAt: number
  /** Binds confirmation to the exact root and subagent identities shown by preview. */
  treeRevision?: string
}

export interface DeletePreview extends DeleteRequest {
  pending: boolean
  descendantCount: number
  treeRevision: string
}

export class ArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}

export function sessionIdentity(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 160 || /[\x00-\x1f\x7f]/.test(input))
    throw new ArchiveError('invalid-request', '无效的会话 ID。', 400)
  return input
}
