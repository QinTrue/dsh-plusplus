/** Node-only gateway API, also used by the plugin's isolated worker. */
export { startGateway } from './server.ts'
export type { Gateway } from './server.ts'
export type { GatewayOptions } from './config.ts'
export type { GatewayAppearance, AppearanceTokens } from '../appearance/theme.ts'
