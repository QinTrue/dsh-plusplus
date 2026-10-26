import { loginThemeCss } from '../appearance/theme.ts'

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  )

/** A separate pre-auth document: native token names, no script or anonymous upstream assets. */
export function renderLogin(message = '', loggedIn = false, themeCss = loginThemeCss()): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>局域网访问 · DSH</title>
<style>
${themeCss}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;font:14px/22px var(--dsw-font-family);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}
main{width:100%;max-width:400px}
.brand{display:flex;align-items:baseline;justify-content:center;gap:8px;margin-bottom:28px;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.5px}
.brand span{font-size:12px;line-height:18px;font-weight:400;letter-spacing:0;color:var(--dsw-alias-label-tertiary)}
.card{padding:28px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2)}
h1{margin:0;font-size:20px;line-height:28px;font-weight:500}
.description{margin:8px 0 24px;color:var(--dsw-alias-label-secondary)}
label{display:block;margin-bottom:8px;font-size:13px;line-height:20px;font-weight:500}
input,button,.button{width:100%;font:inherit;border-radius:var(--dsw-radius-md)}
input{height:40px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);outline:none}
input::placeholder{color:var(--dsw-alias-label-dimmed)}
input:focus{border-color:var(--dsw-alias-state-business-primary)}
button,.button{display:flex;align-items:center;justify-content:center;min-height:36px;padding:7px 14px;border:0;cursor:pointer;text-decoration:none;color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill)}
button:hover,.button:hover{background:var(--dsw-alias-button-primary-hover)}
input:focus-visible,button:focus-visible,a:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:3px}
.submit{margin-top:16px}
.secondary{margin-top:12px;border:0.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:transparent}
.secondary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hint{margin:14px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.error{margin:0 0 20px;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
footer{margin:20px 12px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;text-align:center}
footer p{margin:0}
@media(max-width:440px){body{padding:28px 16px}.card{padding:24px}.brand{margin-bottom:24px}}
@media(max-height:560px){body{justify-content:flex-start}}
</style>
</head>
<body>
<main>
<div class="brand" aria-label="DeepSeek Harness">DSH <span>DeepSeek Harness</span></div>
<section class="card" aria-labelledby="title">
<h1 id="title">${loggedIn ? '已连接到 DSH' : '局域网访问'}</h1>
<p class="description">${loggedIn ? '当前浏览器已通过访问验证。' : '输入主机设置的访问 token，继续使用 DSH。'}</p>
${message ? '<p role="alert" class="error" id="login-error">' + escapeHtml(message) + '</p>' : ''}
${
  loggedIn
    ? '<a class="button" href="/">进入 DSH</a><form method="post" action="/lan/logout"><button class="secondary" type="submit">退出登录</button></form>'
    : `<form method="post" action="/lan/login" accept-charset="utf-8">
<label for="token">访问 token</label>
<input id="token" name="token" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="输入访问 token" aria-describedby="privacy${message ? ' login-error' : ''}"${message ? ' aria-invalid="true"' : ''}>
<button class="submit" type="submit">连接到 DSH</button>
<p id="privacy" class="hint">token 仅用于本次验证，不会保存在浏览器中。</p>
</form>`
}
</section>
<footer><p>仅向可信设备提供 token，它授予完整操作权限。</p><p>HTTP 连接不加密，请使用 HTTPS 或可信加密网络。</p><p>DSH++ · 局域网访问</p></footer>
</main>
</body>
</html>`
}
