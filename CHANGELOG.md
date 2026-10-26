# Changelog

## 0.1.0 — Unreleased

Initial DSH++ project baseline.

- Modular source layout for the host plugin, native settings client, and independent gateway.
- Settings-controlled LAN access with token generation, rotation, origin/port configuration, and optional HTTPS.
- Authentication before all HTTP, SSE, upload, and WebSocket forwarding.
- Session expiry and revocation, strict origin validation, bounded login attempts, and owned child-process shutdown.
- Unit, package contract, and isolated native integration checks.
