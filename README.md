# DSH++

**为 DeepSeek Harness 提供功能增强、界面定制与实用工具的模块化插件。**

包名：`dsh-plusplus`。当前版本 `0.1.0` 提供**局域网访问**和**归档会话删除**模块；更多增强与样式模块可以在同一项目中扩展。

[English](README.en.md) · [开发指南](docs/development.md) · [安全说明](SECURITY.md)

## 当前功能

- 在 DSH 原生设置中开启、关闭和配置局域网访问。
- 生成或轮换访问 token，配置访问地址、端口和可选 HTTPS。
- 主机插件自动管理独立网关子进程，无需手动启动网关或复制原生启动链接。
- 所有 HTTP、静态资源、上传、SSE 和 WebSocket 转发都先通过网关会话认证。
- 停止、退出、会话到期、token 轮换和重启会撤销访问并断开相关连接。

## 归档会话删除

在侧栏显示已归档会话，打开“…”菜单并选择“永久删除”，确认后删除该会话日志和列表记录。本机与已登录的局域网用户均可使用。工作区文件、独立 fork 和共享附件保留。

支持 Linux/macOS 上 DSH `0.2.1-rc.2` / `0.2.1-rc.3` 的当前格式 JSONL 日志。删除会递归包含子代理，确认框显示数量；独立分支会保留。**主会话或子代理仍被 DSH 持有时，需要重启后，在不打开它们的情况下删除**；有活动任务或其他进程占用时会拒绝。详细范围和重试行为见[模块说明](docs/archived-session-deletion.md)。插件配置 `archivedSessions.enabled: false` 可关闭此独立模块。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`
- DSH `>=0.2.1-rc.2`
- DSH 原生服务监听 `127.0.0.1`

## 构建与安装

```bash
git clone git@github.com:QinTrue/dsh-plusplus.git
cd dsh-plusplus
npm ci
npm run check
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-plusplus-0.1.0.tgz
```

按 DSH 提示重启，并刷新浏览器加载设置客户端。原生服务保持本机监听：

```bash
dsh web --host 127.0.0.1 --port 3080
```

插件会检查实际 `webServer.host`，仅当它是 `127.0.0.1` 时允许开启网关。不要把原生端口直接开放到局域网。

## 开启局域网访问

1. 在本机浏览器打开 DSH，进入 **设置 → 局域网访问**。
2. 点击“生成 token”并保存，或者填写自己的 token。凭据通过 DSH credentials 保存为 `DSH_PLUSPLUS_LAN_TOKEN`，不写入插件配置。
3. 设置访问地址和端口，默认端口为 `19388`。地址留空时从本机非回环 IPv4 中选择；多网卡、VPN 或容器环境请填写其他设备实际可达的地址。
4. 勾选“开启局域网访问”，点击“保存并应用”。状态变为“已开启”后，其他设备打开显示的 `/lan` 地址并输入 token。

例如访问地址为 `http://192.168.1.20:19388` 时，网关端口也应为 `19388`，且不能与 DSH 原生端口相同。

取消开关并保存会关闭网关；更换 token 会撤销已有会话。非敏感配置通过原生 Settings/ConfigEditor 保存，DSH 重启后恢复已开启状态。插件卸载或主进程结束时，子进程会停止。

生成的 token 只在当前设置页显示，不提供现有凭据回读。Token 要求 32–256 个 UTF-8 字节，无首尾空白或控制字符。

## HTTPS 与权限

HTTP 不加密 token、cookie 或会话内容。使用 HTTPS 时，在访问地址中填写 HTTPS origin，并在设置中提供匹配且受浏览器信任的 PEM 证书和私钥路径。每个文件最大 256 KiB；证书签发与续期由外部管理。

打开 `/lan` 后可通过同源 POST 退出。默认会话为 8 小时绝对到期；退出、到期、关闭网关或轮换 token 会断开对应的长连接。

**登录者拥有完整原生 DSH 操作权限**，包括 agent 工具、设置与凭据 API。该模块不提供只读模式或角色隔离。本机管理接口 `/api/dsh-plusplus/lan/manage` 不通过 LAN 网关转发，但这不构成已登录管理员之间的权限隔离。详见 [SECURITY.md](SECURITY.md)。

## 项目结构

```text
src/
  index.ts        主机插件公开入口
  plugin/         DSH 配置、管理 API、子进程生命周期
  client/         原生设置页面
  gateway/        独立 HTTP/HTTPS 网关与认证、代理、会话
  modules/        独立增强模块（归档会话删除等）
scripts/          构建和原生集成验证
tests/           网关、插件与包契约测试
assets/           插件图标
docs/             开发约定与架构说明
```

开发命令、模块边界及验证流程见 [开发指南](docs/development.md)。安装后的主机和浏览器产物分别是 `lib/index.js`、`lib/client.js`；Node 网关接口为 `dsh-plusplus/gateway`。
