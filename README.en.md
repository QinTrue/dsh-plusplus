# DSH++

**A modular toolkit for DeepSeek Harness enhancements, interface customization, and practical utilities.**

Package: `dsh-plusplus`. Version `0.1.0` includes **LAN access** and **archived-session deletion**. Additional enhancement and appearance modules can be added within the same project.

[中文](README.md) · [Development](docs/development.md) · [Security](SECURITY.md)

## Features

- Enable and configure LAN access from native DSH Settings.
- Generate or rotate an access token; set the origin, port, and optional HTTPS certificate paths.
- The host plugin owns a separate gateway process. No manual gateway command or native launch-link copy is required.
- Every forwarded HTTP request, asset, upload, SSE stream, and WebSocket upgrade requires a gateway session.
- LAN users can browse directories on the DSH host in the browser and add a workspace without opening a host OS dialog.
- Logout, expiry, token rotation, restart, and shutdown revoke access and close owned connections.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- DSH `>=0.2.1-rc.2`
- Native DSH bound to `127.0.0.1`

## Build and install

```bash
git clone git@github.com:QinTrue/dsh-plusplus.git
cd dsh-plusplus
npm ci
npm run check
npm pack
dsh plugin --profile web add /absolute/path/to/dsh-plusplus-0.1.0.tgz
```

Restart DSH as prompted and refresh the browser to load the settings client. Keep the native listener on loopback:

```bash
dsh web --host 127.0.0.1 --port 3080
```

The plugin checks the public `webServer.host` before enabling the gateway and requires `127.0.0.1`. Do not expose the native port directly to the LAN.

## Enable LAN access

1. Open DSH locally and navigate to **Settings → 局域网访问 (LAN access)**.
2. Generate and save a token, or provide your own. Native credentials stores it as `DSH_PLUSPLUS_LAN_TOKEN`; plugin configuration contains no token.
3. Set the public origin and port, which defaults to `19388`. A blank origin selects a non-loopback IPv4 address. Choose an explicit reachable address on hosts with multiple interfaces, VPNs, or containers.
4. Enable access and save. Once the state shows running, open the displayed `/lan` address on another device and sign in.

The origin port must match the gateway port and differ from the native DSH port. Disabling access stops the listener. Token rotation revokes existing sessions. Native Settings/ConfigEditor persists nonsecret values and restores the enabled state after restart. Unloading the plugin or stopping the parent process stops the worker.

Newly generated tokens are displayed only in the current settings page; existing secrets cannot be read back. Tokens require 32–256 UTF-8 bytes without outer whitespace or control characters.

## HTTPS and permissions

HTTP does not encrypt tokens, cookies, or content. For HTTPS, configure an HTTPS origin and matching, browser-trusted PEM certificate/private-key files on the host. Each file is limited to 256 KiB. Certificate issuance and renewal are external.

Visit `/lan` to sign out using a same-origin POST. Sessions expire absolutely after eight hours by default. Logout, expiry, disable, or rotation closes the corresponding live connections.

**Authenticated users retain full native DSH operator authority**, including agent tools, settings, and credential APIs. There is no read-only or role-based access mode. The local `/api/dsh-plusplus/lan/manage` endpoint is not forwarded from LAN, but this does not isolate authenticated administrators from one another. See [SECURITY.md](SECURITY.md).

## Layout

- `src/plugin/`: native configuration, management API, and worker lifecycle.
- `src/client/`: native settings page.
- `src/gateway/`: HTTP/HTTPS listener, authentication, proxying, sessions, and worker entry.
- `tests/`: gateway, plugin, and package contract tests.
- `scripts/`: build and native integration verification.
- `docs/`: development conventions and architecture.

The package exposes its host plugin at `dsh-plusplus`, browser client at `dsh-plusplus/client`, and Node gateway API at `dsh-plusplus/gateway`. Read the [development guide](docs/development.md) before adding modules.

## Archived-session deletion

Show archived sessions in the sidebar, open the row menu and choose **Permanently delete**. Confirming removes the selected session logs and list records. Both local and authenticated LAN operators can use it. Project files, independent forks and shared attachments remain.

Supports Linux/macOS and the current JSONL format in DSH `0.2.1-rc.2` / `0.2.1-rc.3`. Deletion recursively includes subagents, with their count shown before confirmation; independent forks are preserved. A root or subagent still held by DSH requires a restart before deletion, without reopening it. Active work and another writer refuse deletion. Set `archivedSessions.enabled: false` in plugin configuration to disable the independent module. See [module details](docs/archived-session-deletion.md).
