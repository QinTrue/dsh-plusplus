import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTlsFile } from '../../src/plugin/tls-files.ts'

describe('settings PEM input bounds', () => {
  it('reads regular files and refuses devices/oversized inputs or cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-plusplus-pem-'))
    try {
      const path = join(dir, 'cert.pem')
      const signal = new AbortController().signal
      await writeFile(path, 'fixture PEM bytes')
      expect((await readTlsFile(path, signal)).toString()).toBe('fixture PEM bytes')
      await expect(readTlsFile(dir, signal)).rejects.toThrow('regular PEM file')
      if (process.platform !== 'win32')
        await expect(readTlsFile('/dev/zero', signal)).rejects.toThrow('regular PEM file')
      await writeFile(path, Buffer.alloc(256 * 1024 + 1))
      await expect(readTlsFile(path, signal)).rejects.toThrow('regular PEM file')
      await writeFile(path, 'fixture')
      await expect(readTlsFile(path, AbortSignal.abort())).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
