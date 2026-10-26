# AGENTS.md — dsh-plusplus

## Project scope

DSH++ is a modular enhancement toolkit for DeepSeek Harness. Its current module is settings-controlled LAN access. Implement future enhancements and appearance modules through public native plugin APIs, with explicit module boundaries and focused tests.

- Package, plugin registration, and browser module identity: `dsh-plusplus`.
- Credential name: `DSH_PLUSPLUS_LAN_TOKEN`.
- Management namespace: `/api/dsh-plusplus`; LAN settings endpoint: `/api/dsh-plusplus/lan/manage`.
- No legacy aliases, migration tools, runtime monkey patches, or native DSH source patches.
- Do not change the installed DSH, user profiles, credentials, session logs, or user files unless explicitly asked to deploy or configure them.

## Layout

- `src/index.ts`: public host entry.
- `src/plugin/`: native settings/configuration, management routes, worker ownership, and TLS file loading.
- `src/client/`: browser settings UI, registered through native slots.
- `src/gateway/`: Node-builtins-only gateway, proxy, authentication, rate budget, sessions, and IPC worker entry.
- `scripts/`: build and isolated native verification.
- `tests/gateway/`, `tests/plugin/`, and package tests: behavioral and boundary checks.
- `docs/development.md`: architecture and contributor workflow.

Use two-space indentation, UTF-8, LF line endings, and explicit relative imports. Keep generated `lib/`, dependency directories, local browser artifacts, credentials, and package archives out of Git.

## LAN invariants

- Native DSH must bind `127.0.0.1`. The plugin checks public `webServer.host`; it must never expose or silently rebind the native listener.
- Only GET/HEAD `/lan` and `/lan/`, and POST `/lan/login`, are public. All other requests, static assets, unknown APIs, uploads, SSE, and upgrades need a gateway session before an upstream request exists.
- Strict configured Host/full Origin validation happens before rewriting Host/Origin for the fixed numeric-loopback upstream. Forwarding headers never establish identity or origin. Reject CONNECT, absolute request URLs, and arbitrary targets.
- Gateway sessions are random, opaque, bounded, memory-only, and absolutely expiring. Cookies use HttpOnly, SameSite=Strict, and Secure on TLS. Logout is same-origin POST. Revocation closes owned streams and upgraded sockets.
- Startup validates secrets and exchanges the explicit native launch URL over loopback HTTP before binding. Native cookies stay server-side. Do not sign native cookies, bypass native auth, or log tokens, cookies, provider/HTTP errors, private keys, or launch URLs.
- The proxy preserves raw paths, filters hop-by-hop/forwarding headers, supports backpressure and disconnects, and never follows redirects. `/api/dsh-plusplus` management routes never pass through the LAN listener.
- Each gateway owns its listeners, sessions, rate budgets, pending logins, outbound requests, and upgraded sockets. Stop closes all resources; late async completions cannot create sessions after disposal.
- The child receives secrets via IPC with no secret argv or inherited environment. Parent disconnect, unload, and shutdown terminate it. Runtime code uses public native APIs; settings persist through Settings/ConfigEditor and secrets through credentials.
- Authenticated LAN users have full native operator authority. The local management API is not an RBAC boundary against authenticated administrators.

## Validation

Run `npm run check` before committing. It includes type checking, build, tests, native gateway/plugin verification, and package-content checks. Use `DSH_VERIFY_ROOT=/absolute/path/to/dsh npm run verify:host` and `npm run verify:plugin` to check an installed native version without modifying it.

Tests use isolated temporary profiles and loopback listeners. Cover anonymous denial on deliberately unprotected HTTP/upgrades, native authentication, encoded management paths, streaming, WebSocket, expiry/logout/shutdown, body/peer bounds, settings persistence, credential timing, and child cleanup. No model calls or firewall changes are required.

Keep applicable attribution in `LICENSE` and `THIRD-PARTY-NOTICES.md`.
