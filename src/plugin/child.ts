import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { GatewayOptions } from '../gateway/config.ts'

/** One owned process, no inherited provider secrets, argv secrets, shell or unbounded stop. */
export class GatewayChild {
  private child?: ChildProcess
  private stopping?: Promise<void>
  constructor(
    private readonly onExit: () => void,
    private readonly entry = new URL('./worker.js', import.meta.url),
  ) {}
  start(options: GatewayOptions): Promise<number> {
    const child = fork(fileURLToPath(this.entry), [], {
      execPath: process.execPath,
      execArgv: [],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      detached: false,
    })
    this.child = child
    return new Promise((resolve, reject) => {
      let ready = false
      const fail = () => reject(new Error('Gateway process could not start.'))
      const timer = setTimeout(() => {
        fail()
        void this.close()
      }, 15_000)
      child.once('error', () => {
        clearTimeout(timer)
        fail()
      })
      child.once('close', () => {
        clearTimeout(timer)
        this.child = undefined
        if (!ready) fail()
        this.onExit()
      })
      child.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return
        if (
          message.type === 'ready' &&
          'expiresAt' in message &&
          typeof message.expiresAt === 'number' &&
          message.expiresAt > Date.now()
        ) {
          ready = true
          clearTimeout(timer)
          resolve(message.expiresAt)
        }
        if (message.type === 'failed') {
          clearTimeout(timer)
          fail()
          void this.close()
        }
      })
      child.send({ type: 'start', options }, (error) => {
        if (error) {
          clearTimeout(timer)
          fail()
          void this.close()
        }
      })
    })
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    this.stopping = new Promise((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 2000)
      child.once('close', () => {
        clearTimeout(kill)
        resolve()
      })
      if (child.connected) child.send({ type: 'stop' }, () => {})
      else child.kill('SIGTERM')
    })
    return this.stopping
  }
}
