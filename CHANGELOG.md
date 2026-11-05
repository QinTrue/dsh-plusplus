# Changelog

## 0.1.0 — Unreleased

Initial DSH++ project baseline.

- Modular source layout for the host plugin, native settings client, and independent gateway.
- Settings-controlled LAN access with token generation, rotation, origin/port configuration, and optional HTTPS.
- Authentication before all HTTP, SSE, upload, and WebSocket forwarding.
- Session expiry and revocation, strict origin validation, bounded login attempts, and owned child-process shutdown.
- Configurable LAN session lifetime: 1 day, 7 days (default), 30 days, or permanent until logout or gateway shutdown.
- LAN address selection from detected local IPv4 addresses, with automatic and custom choices.
- In-app host directory browser for adding workspaces from LAN browsers, pinned through the profile patch.
- Removable archived-session deletion module (`archivedSessions.enabled`): recursive subagent deletion, independent fork preservation, native write-lock ownership, durable receipts and retry, available to local and authenticated LAN operators.
- Native UI primitives and theme tokens for plugin controls and the LAN login page.
- Unit, package contract, and isolated native integration checks.
