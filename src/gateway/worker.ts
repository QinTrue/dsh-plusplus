import { startGateway, type Gateway } from './server.ts'
import type { GatewayOptions } from './config.ts'

// This entry is only spawned by the plugin. Secrets arrive once over an inherited IPC pipe.
if (!process.send) process.exit(1)
let stopping = false
let received = false
let gateway: Gateway | undefined
let starting: Promise<void> | undefined
const startupDeadline = setTimeout(() => void stop(), 15_000)
async function stop() {
  if (stopping) return
  stopping = true
  clearTimeout(startupDeadline)
  await starting?.catch(() => {})
  await gateway?.close()
  process.exit(0)
}
process.once('disconnect', () => void stop())
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return
  if ('type' in message && message.type === 'stop') {
    void stop()
    return
  }
  if (
    received ||
    stopping ||
    !('type' in message) ||
    message.type !== 'start' ||
    !('options' in message)
  )
    return
  received = true
  starting = (async () => {
    try {
      gateway = await startGateway(message.options as GatewayOptions)
      clearTimeout(startupDeadline)
      if (stopping || !process.connected) {
        await gateway.close()
        return
      }
      process.send!({
        type: 'ready',
        port: gateway.address.port,
        expiresAt: gateway.nativeExpiresAt,
      })
    } catch {
      clearTimeout(startupDeadline)
      if (process.connected) process.send!({ type: 'failed' }, () => process.exit(1))
      else process.exit(1)
    }
  })()
})
