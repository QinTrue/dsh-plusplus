import { createElement as h, useEffect, useState, type FormEvent } from 'react'
import { Button, Input, Switch, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerClientStyles } from './styles.ts'
import type { LanStatus } from '../plugin/management.ts'
import type { PluginValues } from '../plugin/config.ts'
import {
  registerArchiveClient,
  type ArchiveClientContext,
} from '../modules/archived-sessions/client.ts'

const ENDPOINT = '/api/dsh-plusplus/lan/manage'
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
      { className: 'dsh-plusplus-field' },
      h('span', null, label),
      h(Input, {
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
    { 'aria-label': '局域网访问', className: 'dsh-plusplus-settings' },
    h(
      'div',
      { className: 'dsh-plusplus-section-heading' },
      h('h3', null, '局域网访问'),
      h('span', { role: 'status', className: 'dsh-plusplus-caption' }, phase),
    ),
    h('p', { className: 'dsh-plusplus-description' }, '让同一网络中的设备访问 DSH。'),
    error ? h('p', { role: 'alert', className: 'dsh-plusplus-error' }, error) : null,
    state?.message
      ? h('p', { role: 'alert', className: 'dsh-plusplus-error' }, state.message)
      : null,
    state && !state.nativeLoopback
      ? h(
          'p',
          { role: 'alert', className: 'dsh-plusplus-error' },
          'DSH 当前直接对外监听。请先在本机把原生监听地址改为 127.0.0.1 并重启，然后开启。',
        )
      : null,
    state && draft
      ? h(
          'form',
          { onSubmit: save },
          h(
            'fieldset',
            { disabled: busy },
            h(
              'div',
              { className: 'dsh-plusplus-toggle' },
              h('span', null, '开启局域网访问'),
              h(Switch, {
                label: '开启局域网访问',
                checked: draft.enabled,
                disabled: busy,
                onChange: (checked) => update('enabled', checked),
              }),
            ),
            field('访问地址（留空自动选择）', 'publicOrigin', draft.publicOrigin),
            state.suggestions.length
              ? h(
                  'p',
                  { className: 'dsh-plusplus-caption' },
                  '检测到：',
                  state.suggestions.join('、'),
                )
              : null,
            field('网关端口', 'port', draft.port, 'number'),
            h(
              'label',
              { className: 'dsh-plusplus-field' },
              h('span', null, state.tokenConfigured ? '访问 token（留空保留）' : '访问 token'),
              h(Input, {
                type: 'password',
                autoComplete: 'new-password',
                placeholder: state.tokenConfigured
                  ? '已配置，输入以更换'
                  : '输入 token 或在下方生成',
                'aria-label': state.tokenConfigured
                  ? '更换访问 token（留空保留）'
                  : '设置访问 token',
                value: token,
                disabled: busy || !state.tokenWritable,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                  setToken(event.target.value),
              }),
            ),
            h(
              Button,
              {
                type: 'button',
                variant: 'outline',
                size: 'sm',
                disabled: busy || !state.tokenWritable,
                onClick: () => void generate(),
              },
              state.tokenConfigured ? '生成新 token' : '生成 token',
            ),
            !state.tokenWritable
              ? h(
                  'p',
                  { className: 'dsh-plusplus-caption' },
                  '当前凭据来源只读，请在主机的凭据来源修改。',
                )
              : null,
            generated
              ? h(
                  'div',
                  { className: 'dsh-plusplus-generated' },
                  h(
                    'label',
                    { className: 'dsh-plusplus-field' },
                    h('span', null, '新 token'),
                    h(Input, {
                      'aria-label': '新 token',
                      value: generated,
                      readOnly: true,
                      type: visible ? 'text' : 'password',
                    }),
                  ),
                  h(
                    Button,
                    {
                      type: 'button',
                      variant: 'outline',
                      size: 'sm',
                      onClick: () => setVisible((current) => !current),
                    },
                    visible ? '隐藏 token' : '显示 token',
                  ),
                  h(
                    Button,
                    {
                      type: 'button',
                      variant: 'outline',
                      size: 'sm',
                      onClick: () => {
                        void writeClipboard(generated)
                          .then((copied) => {
                            if (!copied) setError('复制失败，请点击显示 token 后手动复制。')
                          })
                          .catch(() => setError('复制失败，请点击显示 token 后手动复制。'))
                      },
                    },
                    '复制 token',
                  ),
                  h(
                    'p',
                    { className: 'dsh-plusplus-caption' },
                    '请保存此 token，离开本页后不再显示。',
                  ),
                )
              : null,
            h(
              'p',
              { className: 'dsh-plusplus-caption' },
              'token 授予完整操作权限。更换 token 或关闭访问会断开已有连接。',
            ),
            h(
              'details',
              null,
              h('summary', null, 'HTTPS 设置'),
              field('证书文件路径（主机）', 'tlsCertPath', draft.tlsCertPath),
              field('私钥文件路径（主机）', 'tlsKeyPath', draft.tlsKeyPath),
            ),
            h(
              'p',
              { className: 'dsh-plusplus-caption' },
              'HTTP 不加密 token 和会话内容；建议使用 HTTPS 或可信加密网络。',
            ),
            h(
              'div',
              { className: 'dsh-plusplus-settings-footer' },
              h(
                Button,
                { type: 'submit', variant: 'primary', disabled: busy },
                busy ? '正在保存…' : '保存并应用',
              ),
            ),
          ),
        )
      : null,
    state?.phase === 'running'
      ? h(
          'p',
          { className: 'dsh-plusplus-caption' },
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

export const inject = ['slots']
export function apply(ctx: ArchiveClientContext) {
  registerClientStyles(ctx)
  registerArchiveClient(ctx)
  ctx.effect(() =>
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'dsh-plusplus-lan', order: 35, label: '局域网访问' },
        LanSettings,
      ),
    ),
  )
}
