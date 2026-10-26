const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )

/** Standalone HTML: no client module, script, storage, or global browser patch. */
export function renderLogin(message = '', loggedIn = false): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Qin LAN · 登录</title>
<style>html{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}body{max-width:30rem;margin:10vh auto;padding:1.5rem}h1{font-size:1.5rem}label{display:block;margin-top:1rem}input,button{box-sizing:border-box;width:100%;font:inherit;padding:.7rem;border:1px solid #888;border-radius:.5rem}button{margin-top:1rem;cursor:pointer;background:#245bd3;color:white;border:0}.notice{font-size:.9rem;opacity:.8}.error{padding:.6rem;border-left:3px solid #d55;overflow-wrap:anywhere}</style></head>
<body><main><h1>局域网登录 · Qin LAN</h1><p>使用主机配置的访问 token，登录 DSH 官方界面。</p>
${message ? '<p role="alert" class="error">' + escapeHtml(message) + '</p>' : ''}
${loggedIn ? '<p>已登录网关。<a href="/">返回 DSH</a></p><form method="post" action="/lan/logout"><button type="submit">退出网关 / Sign out</button></form>' : ''}
<form method="post" action="/lan/login" accept-charset="utf-8"><label for="token">访问 Token / Access token</label><input id="token" name="token" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="privacy"><button type="submit">登录 / Sign in</button></form>
<p id="privacy" class="notice">本页不保存 token；登录后，浏览器只保留网关登录状态。登录默认 8 小时后失效。</p><p class="notice">此凭证授予完整 agent 操作权限。请使用 HTTPS 或加密网络；普通 HTTP 不加密 token、cookie 和会话内容。部分官方 GUI 功能也需要安全上下文。</p></main></body></html>`
}
