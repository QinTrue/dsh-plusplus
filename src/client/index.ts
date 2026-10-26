import { createElement as h, useEffect, useState, type FormEvent, type CSSProperties } from 'react'
import type { LanStatus } from '../plugin/management.ts'
import type { PluginValues } from '../plugin/config.ts'

const ENDPOINT = '/api/dsh-plusplus/lan/manage'
const row: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }
const control: CSSProperties = {
  font: 'inherit',
  color: 'inherit',
  border: '1px solid var(--dsw-alias-border-l2, #888)',
  borderRadius: 8,
  padding: '9px 12px',
  background: 'transparent',
  maxWidth: '100%',
  boxSizing: 'border-box',
}
async function call(body?: unknown): Promise<{ state?: LanStatus; token?: string }> {
  const response = await fetch(ENDPOINT, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const result = (await response.json()) as { state?: LanStatus; token?: string; error?: string }
  if (!response.ok) throw new Error(result.error || '无法读取局域网设置。')
  return result
}

/** A settings card only: no global patches, transport interception, or native GUI replacement. */
export function LanSettings() {
  const [state, setState] = useState<LanStatus>()
  const [draft, setDraft] = useState<PluginValues>()
  const [token, setToken] = useState('')
  const [generated, setGenerated] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const result = await call()
        if (!active) return
        if (result.state) {
          const next = result.state
          setState(next)
          setDraft((current) => current ?? next.config)
        }
      } catch (error) {
        if (active) setError((error as Error).message)
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  const update = <K extends keyof PluginValues>(key: K, value: PluginValues[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      const result = await call({ action: 'save', config: draft, ...(token ? { token } : {}) })
      if (result.state) {
        setState(result.state)
        setDraft(result.state.config)
      }
      setToken('')
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const generate = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await call({ action: 'generate' })
      if (result.state) setState(result.state)
      setGenerated(result.token ?? '')
      setToken('')
      setVisible(false)
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const phase = state
    ? { off: '已关闭', starting: '开启中', running: '已开启', error: '启动失败' }[state.phase]
    : '正在读取设置'
  const field = (label: string, name: keyof PluginValues, value: string | number, type = 'text') =>
    h(
      'label',
      { style: row },
      label,
      h('input', {
        style: control,
        type,
        value,
        'aria-label': label,
        disabled: busy,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          update(name, type === 'number' ? Number(event.target.value) : event.target.value),
        ...(type === 'number' ? { min: 1024, max: 65535 } : {}),
      }),
    )
  return h(
    'section',
    {
      'aria-label': '局域网访问',
      style: {
        maxWidth: 620,
        color: 'var(--dsw-alias-label-primary, inherit)',
        padding: '12px 0',
        fontSize: 14,
      },
    },
    h('h3', { style: { marginTop: 0 } }, '局域网访问'),
    h('p', { role: 'status' }, phase),
    error ? h('p', { role: 'alert' }, error) : null,
    state?.message ? h('p', { role: 'alert' }, state.message) : null,
    state && !state.nativeLoopback
      ? h(
          'p',
          { role: 'alert' },
          'DSH 当前直接对外监听。请先在本机把原生监听地址改为 127.0.0.1 并重启，然后开启。',
        )
      : null,
    state && draft
      ? h(
          'form',
          { onSubmit: save },
          h(
            'fieldset',
            { disabled: busy, style: { border: 0, margin: 0, padding: 0, minWidth: 0 } },
            h(
              'label',
              { style: { display: 'flex', gap: 8, marginBottom: 18 } },
              h('input', {
                type: 'checkbox',
                checked: draft.enabled,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                  update('enabled', event.target.checked),
              }),
              '开启局域网访问',
            ),
            field('访问地址（留空自动选择）', 'publicOrigin', draft.publicOrigin),
            state.suggestions.length
              ? h(
                  'p',
                  { style: { overflowWrap: 'anywhere' } },
                  '检测到：',
                  state.suggestions.join('、'),
                )
              : null,
            field('网关端口', 'port', draft.port, 'number'),
            h(
              'label',
              { style: row },
              state.tokenConfigured ? '更换访问 token（留空保留）' : '设置访问 token',
              h('input', {
                style: control,
                type: 'password',
                autoComplete: 'new-password',
                value: token,
                disabled: !state.tokenWritable,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                  setToken(event.target.value),
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                style: control,
                disabled: !state.tokenWritable,
                onClick: () => void generate(),
              },
              state.tokenConfigured ? '生成新 token' : '生成 token',
            ),
            !state.tokenWritable
              ? h('p', null, '当前凭据来源只读，请在主机的凭据来源修改。')
              : null,
            generated
              ? h(
                  'div',
                  { style: { ...row, marginTop: 12 } },
                  h(
                    'label',
                    null,
                    '新 token（请保存，本页关闭后不再显示）',
                    h('input', {
                      style: { ...control, width: '100%' },
                      value: generated,
                      readOnly: true,
                      type: visible ? 'text' : 'password',
                    }),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: control,
                      onClick: () => setVisible((current) => !current),
                    },
                    visible ? '隐藏 token' : '显示 token',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: control,
                      onClick: () => {
                        void navigator.clipboard
                          .writeText(generated)
                          .catch(() => setError('复制失败，请点击显示 token 后手动复制。'))
                      },
                    },
                    '复制 token',
                  ),
                )
              : null,
            h('p', null, 'token 授予完整操作权限。更换 token 或关闭访问会断开已有连接。'),
            h(
              'details',
              null,
              h('summary', { style: { cursor: 'pointer', marginBottom: 12 } }, 'HTTPS 设置'),
              field('证书文件路径（主机）', 'tlsCertPath', draft.tlsCertPath),
              field('私钥文件路径（主机）', 'tlsKeyPath', draft.tlsKeyPath),
            ),
            h('p', null, 'HTTP 不加密 token 和会话内容；建议使用 HTTPS 或可信加密网络。'),
            h('button', { type: 'submit', style: control }, busy ? '正在保存…' : '保存并应用'),
          ),
        )
      : null,
    state?.phase === 'running'
      ? h(
          'p',
          { style: { overflowWrap: 'anywhere' } },
          '其他设备打开：',
          h(
            'a',
            { href: state.origin + '/lan', target: '_blank', rel: 'noreferrer' },
            state.origin + '/lan',
          ),
        )
      : null,
  )
}

interface ClientContext {
  effect(run: () => () => void): unknown
  slots: {
    inject(name: string, mount: () => () => void): () => void
    register(
      options: { name: string; id: string; order: number; label: string },
      component: typeof LanSettings,
    ): () => void
  }
}
export const inject = ['slots']
export function apply(ctx: ClientContext) {
  ctx.effect(() =>
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'dsh-plusplus-lan', order: 35, label: '局域网访问' },
        LanSettings,
      ),
    ),
  )
}
