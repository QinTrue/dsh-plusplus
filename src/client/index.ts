import { createElement as h, useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { Button, Input, Switch, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { registerClientStyles } from './styles.ts'
import type { LanStatus } from '../plugin/management.ts'
import type { PluginValues } from '../plugin/config.ts'
import {
  registerArchiveClient,
  type ArchiveClientContext,
} from '../modules/archived-sessions/client.ts'

const ENDPOINT = '/api/dsh-plusplus/lan/manage'
const LOCAL_ONLY_MESSAGE = '请在本机 DSH 设置中管理网关。'
const AUTO_ADDRESS = '__auto__'
const CUSTOM_ADDRESS = '__custom__'
type ManagementResult = { state?: LanStatus; token?: string; error?: string }

class ManagementRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ManagementRequestError'
  }
}

async function call(body?: unknown): Promise<{ state?: LanStatus; token?: string }> {
  const response = await fetch(ENDPOINT, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let result: ManagementResult
  try {
    result = text ? (JSON.parse(text) as ManagementResult) : {}
  } catch {
    throw new ManagementRequestError(
      response.status,
      response.status === 403 ? LOCAL_ONLY_MESSAGE : '无法读取局域网设置。',
    )
  }
  if (!response.ok)
    throw new ManagementRequestError(
      response.status,
      result.error || (response.status === 403 ? LOCAL_ONLY_MESSAGE : '无法读取局域网设置。'),
    )
  return result
}

function originHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

function originWithPort(value: string, port: number): string {
  try {
    const origin = new URL(value)
    origin.port = String(port)
    return origin.origin
  } catch {
    return value
  }
}

function originWithAddress(address: string, draft: PluginValues): string {
  const protocol = draft.tlsCertPath || draft.tlsKeyPath ? 'https:' : 'http:'
  const host = address.includes(':') && !address.startsWith('[') ? '[' + address + ']' : address
  return protocol + '//' + host + ':' + draft.port
}

function originForSave(value: string, draft: PluginValues): string {
  if (!value) return ''
  const next = originWithPort(value, draft.port)
  try {
    const origin = new URL(next)
    origin.protocol = draft.tlsCertPath || draft.tlsKeyPath ? 'https:' : 'http:'
    return origin.origin
  } catch {
    return next
  }
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
  const [localOnly, setLocalOnly] = useState(false)
  const [addressChoice, setAddressChoice] = useState<string>()
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setInterval> | undefined
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
        if (!active) return
        if (error instanceof ManagementRequestError && error.status === 403) {
          setLocalOnly(true)
          setError('')
          if (timer) clearInterval(timer)
        } else setError((error as Error).message)
      }
    }
    timer = setInterval(() => void refresh(), 2000)
    void refresh()
    return () => {
      active = false
      if (timer) clearInterval(timer)
    }
  }, [])
  const update = <K extends keyof PluginValues>(key: K, value: PluginValues[K]) =>
    setDraft((current) => {
      if (!current) return current
      const next = { ...current, [key]: value } as PluginValues
      if (key === 'port' && typeof value === 'number' && current.publicOrigin)
        next.publicOrigin = originWithPort(current.publicOrigin, value)
      return next
    })
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      const config = { ...draft, publicOrigin: originForSave(draft.publicOrigin, draft) }
      const result = await call({ action: 'save', config, ...(token ? { token } : {}) })
      if (result.state) {
        setState(result.state)
        setDraft(result.state.config)
      }
      setToken('')
    } catch (error) {
      if (error instanceof ManagementRequestError && error.status === 403) {
        setLocalOnly(true)
        setError('')
      } else setError((error as Error).message)
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
      if (error instanceof ManagementRequestError && error.status === 403) {
        setLocalOnly(true)
        setError('')
      } else setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const phase = state
    ? localOnly
      ? '仅本机可管理'
      : { off: '已关闭', starting: '开启中', running: '已开启', error: '启动失败' }[state.phase]
    : localOnly
      ? '仅本机可管理'
      : '正在读取设置'
  const configuredHost = draft ? originHost(draft.publicOrigin) : ''
  const selectedAddress =
    addressChoice ??
    (configuredHost
      ? state?.suggestions.includes(configuredHost)
        ? configuredHost
        : CUSTOM_ADDRESS
      : (state?.suggestions[0] ?? AUTO_ADDRESS))
  const showCustomAddress = selectedAddress === CUSTOM_ADDRESS
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
        onChange: (event: ChangeEvent<HTMLInputElement>) =>
          update(name, type === 'number' ? Number(event.target.value) : event.target.value),
        ...(type === 'number' ? { min: 1024, max: 65535 } : {}),
      }),
    )
  const addressField = draft
    ? h(
        'div',
        { className: 'dsh-plusplus-field' },
        h('span', null, '本机的访问地址'),
        h(
          'select',
          {
            'aria-label': '本机的访问地址',
            value: selectedAddress,
            disabled: busy,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => {
              const choice = event.target.value
              setAddressChoice(choice)
              if (choice === AUTO_ADDRESS) update('publicOrigin', '')
              else if (choice === CUSTOM_ADDRESS) {
                if (!configuredHost || state?.suggestions.includes(configuredHost))
                  update('publicOrigin', '')
              } else update('publicOrigin', originWithAddress(choice, draft))
            },
          },
          ...(state?.suggestions ?? []).map((address, index) =>
            h(
              'option',
              { key: address, value: address },
              address + (index === 0 ? '（默认）' : ''),
            ),
          ),
          h(
            'option',
            { value: AUTO_ADDRESS },
            state?.suggestions.length ? '自动选择（首个可用地址）' : '自动选择（未检测到地址）',
          ),
          h('option', { value: CUSTOM_ADDRESS }, '其他地址…'),
        ),
        showCustomAddress
          ? h(Input, {
              className: 'dsh-plusplus-custom-address',
              'aria-label': '自定义访问地址',
              placeholder: '例如 192.168.1.20',
              value: configuredHost,
              disabled: busy,
              onChange: (event: ChangeEvent<HTMLInputElement>) =>
                update(
                  'publicOrigin',
                  event.target.value ? originWithAddress(event.target.value.trim(), draft) : '',
                ),
            })
          : null,
        h(
          'span',
          { className: 'dsh-plusplus-caption' },
          '列表只显示 IP；协议由 HTTPS 设置决定，端口使用下方网关端口。',
        ),
      )
    : null
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
    localOnly
      ? h(
          'div',
          { role: 'status', className: 'dsh-plusplus-local-only' },
          h('strong', null, LOCAL_ONLY_MESSAGE),
          h('span', null, '局域网页面只能使用网关，配置入口仅在本机浏览器提供。'),
        )
      : null,
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
    state && draft && !localOnly
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
            addressField,
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
