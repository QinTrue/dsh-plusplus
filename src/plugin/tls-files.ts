import { open, constants } from 'node:fs/promises'

/** Local settings paths may be mistyped: never block on a FIFO or read a device/unbounded file. */
export async function readTlsFile(path: string, signal: AbortSignal): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    const cap = 256 * 1024
    if (!info.isFile() || info.size <= 0 || info.size > cap)
      throw new Error('TLS input must be a regular PEM file no larger than 256 KiB.')
    const data = Buffer.alloc(cap + 1)
    let total = 0
    while (total <= cap) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(data, total, cap + 1 - total, null)
      if (bytesRead === 0) return data.subarray(0, total)
      total += bytesRead
    }
    throw new Error('TLS input exceeds the maximum size.')
  } finally {
    await handle.close()
  }
}
