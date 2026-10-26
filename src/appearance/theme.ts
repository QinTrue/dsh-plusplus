/** Same dual-mode token shape as the public native theme.overrideTokens API. */
export type AppearanceTokens = Record<`--dsw-${string}`, { light: string; dark: string }>
export interface GatewayAppearance {
  preference?: 'system' | 'light' | 'dark'
  tokens?: AppearanceTokens
}

// Minimal native DSH defaults for the separate, script-free pre-authentication document.
// In-app UI inherits the host's active tokens instead of applying these defaults.
const loginTokens: AppearanceTokens = {
  '--dsw-font-family': {
    light: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    dark: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  '--dsw-alias-bg-base': { light: '#fff', dark: '#151517' },
  '--dsw-alias-bg-layer-1': { light: '#fff', dark: '#212123' },
  '--dsw-alias-bg-layer-2': { light: '#fff', dark: '#2c2c2e' },
  '--dsw-alias-bg-module-platform': { light: '#f9fafb', dark: '#353638' },
  '--dsw-alias-label-primary': { light: '#0f1115', dark: '#f9fafb' },
  '--dsw-alias-label-secondary': { light: '#61666b', dark: '#cfd3d6' },
  '--dsw-alias-label-tertiary': { light: '#81858c', dark: '#adb2b8' },
  '--dsw-alias-label-primary-foreground': { light: '#fff', dark: '#0f1115' },
  '--dsw-alias-label-dimmed': { light: '#adb2b8', dark: '#61666b' },
  '--dsw-alias-border-l2': { light: '#0000001a', dark: '#ffffff1f' },
  '--dsw-alias-border-l4': { light: '#00000029', dark: '#fff3' },
  '--dsw-alias-interactive-bg-hover': { light: '#2631480f', dark: '#ffffff14' },
  '--dsw-alias-state-business-primary': { light: '#4176e6', dark: '#7aaaff' },
  '--dsw-alias-state-error-primary': { light: '#ec1313', dark: '#f25a5a' },
  '--dsw-alias-brand-primary': { light: '#0f1115', dark: '#f9fafb' },
  '--dsw-alias-button-primary-fill': {
    light: 'var(--dsw-alias-brand-primary)',
    dark: 'var(--dsw-alias-brand-primary)',
  },
  '--dsw-alias-button-primary-hover': { light: '#43454a', dark: '#ebeef2' },
  '--dsw-radius-md': { light: '12px', dark: '12px' },
  '--dsw-radius-panel': { light: '28px', dark: '28px' },
  '--dsw-focus-ring-width': { light: '2px', dark: '2px' },
  '--dsw-focus-ring-color': {
    light: 'var(--dsw-alias-state-business-primary)',
    dark: 'var(--dsw-alias-state-business-primary)',
  },
}

/** Serialize token values only, never arbitrary selectors, markup or external stylesheets. */
export function loginThemeCss(appearance: GatewayAppearance = {}): string {
  const preference = appearance.preference ?? 'system'
  if (!['system', 'light', 'dark'].includes(preference))
    throw new Error('Invalid theme preference.')
  const tokens = { ...loginTokens, ...appearance.tokens }
  if (Object.keys(tokens).length > 256) throw new Error('Too many theme tokens.')
  const declarations = { light: '', dark: '' }
  for (const [name, modes] of Object.entries(tokens)) {
    if (!/^--dsw-[a-z0-9-]+$/.test(name)) throw new Error('Invalid theme token name.')
    for (const mode of ['light', 'dark'] as const) {
      const value = modes?.[mode]
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 1024 ||
        /[;{}<>\\\x00-\x1f\x7f]/.test(value)
      )
        throw new Error('Invalid theme token value.')
      declarations[mode] += `${name}:${value};`
    }
  }
  if (preference !== 'system')
    return `:root{color-scheme:${preference}}body{${declarations[preference]}}`
  return `:root{color-scheme:light dark}body{${declarations.light}}@media(prefers-color-scheme:dark){body{${declarations.dark}}}`
}
