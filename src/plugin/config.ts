import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

export interface PluginValues {
  enabled: boolean
  publicOrigin: string
  port: number
  sessionDuration: '1d' | '7d' | '30d' | 'permanent'
  tlsCertPath: string
  tlsKeyPath: string
}
export interface PluginConfig {
  lan: Volatile<PluginValues>
  archivedSessions?: { enabled: boolean }
}
export const SESSION_DURATIONS = {
  '1d': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
  permanent: 'permanent',
} as const
export const Config = z.object({
  archivedSessions: z.object({ enabled: z.boolean().default(true) }),
  lan: z
    .object({
      enabled: z.boolean().default(false),
      publicOrigin: z.string().default(''),
      port: z.natural().min(1024).max(65535).default(19388),
      sessionDuration: z
        .union([z.const('1d'), z.const('7d'), z.const('30d'), z.const('permanent')])
        .default('7d'),
      tlsCertPath: z.string().default(''),
      tlsKeyPath: z.string().default(''),
    })
    .volatile(),
})
export const TOKEN_REF = 'DSH_PLUSPLUS_LAN_TOKEN'
