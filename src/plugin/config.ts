import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'

export interface PluginValues {
  enabled: boolean
  publicOrigin: string
  port: number
  tlsCertPath: string
  tlsKeyPath: string
}
export interface PluginConfig {
  lan: Volatile<PluginValues>
}
export const Config = z.object({
  lan: z
    .object({
      enabled: z.boolean().default(false),
      publicOrigin: z.string().default(''),
      port: z.natural().min(1024).max(65535).default(19388),
      tlsCertPath: z.string().default(''),
      tlsKeyPath: z.string().default(''),
    })
    .volatile(),
})
export const TOKEN_REF = 'DSH_PLUSPLUS_LAN_TOKEN'
