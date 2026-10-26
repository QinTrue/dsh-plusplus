import { describe, expect, it } from 'vitest'
import { renderLogin } from '../../src/gateway/page.ts'
import { loginThemeCss, type AppearanceTokens } from '../../src/appearance/theme.ts'

describe('standalone login document', () => {
  it('escapes errors and associates them with the password field without reflecting the submitted token', () => {
    const page = renderLogin('<img src=x onerror=alert(1)>')
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(page).not.toContain('<img')
    expect(page).toContain('aria-describedby="privacy login-error" aria-invalid="true"')
    expect(page).not.toMatch(/<input[^>]*\bvalue=/)
  })

  it('rejects token values that could escape a declaration or the style element', () => {
    for (const value of [
      'red;}body{display:none',
      '</style><script>alert(1)</script>',
      'red;--x:blue',
      'red\\3b',
    ])
      expect(() =>
        loginThemeCss({ tokens: { '--dsw-alias-brand-primary': { light: value, dark: value } } }),
      ).toThrow()
    expect(() =>
      loginThemeCss({
        tokens: { 'body{color': { light: 'red', dark: 'red' } } as AppearanceTokens,
      }),
    ).toThrow()
  })
})
