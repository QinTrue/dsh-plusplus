# Development

## Setup and checks

```bash
npm ci
npm run check
```

`npm ci` builds the package through the `prepare` lifecycle. `npm run check` runs type checking, a clean build, tests, native integration verification, and a package dry run. The lockfile fixes development dependency versions.

The development fixtures override Zod to `4.6.6` to address GHSA-mrhx-c7xc-m3w5 in the version pinned by native DSH test dependencies. This override does not modify an installed DSH or bundle Zod into the plugin or worker.

Useful commands:

```bash
npm run typecheck
npm run format
npm run format:check
npm test
npm run build
npm run verify:host
npm run verify:plugin
DSH_VERIFY_ROOT=/absolute/path/to/installed/dsh npm run verify:host
DSH_VERIFY_ROOT=/absolute/path/to/installed/dsh npm run verify:plugin
npm pack
```

The verification scripts use temporary profiles, in-memory or temporary credentials, and loopback listeners. They never install into a user's DSH profile or invoke models. `DSH_PLUSPLUS_VERIFY_ROOT` optionally points plugin verification at a built or unpacked DSH++ package.

## Runtime boundaries

```text
Native settings UI
  → local authenticated management API
  → host-owned IPC worker
  → authenticated LAN listener
  → numeric-loopback native DSH
```

- `src/index.ts` exposes the native host plugin.
- `src/plugin/` owns public DSH service integration, nonsecret configuration, credential writes, management requests, and child lifecycle.
- `src/client/` registers the settings page. It does not own the listener or alter browser globals/native transport behavior.
- `src/modules/` contains independent enhancements, including archived-session deletion.
- `src/gateway/` is dependency-free at runtime apart from Node builtins. It owns authentication, sessions, streaming, and proxying.
- `src/gateway/index.ts` is the separate programmatic gateway API. Host consumers do not load gateway forwarding code into the main plugin by default.
- `src/gateway/worker.ts` is only launched by the host and receives secrets once through IPC.

Build output stays flat at `lib/index.js`, `lib/client.js`, `lib/gateway.js`, and `lib/worker.js`; declarations mirror the source under `lib/types/`. The child entry resolves beside the built host bundle. The browser module ID is generated from `package.json`, and build checks enforce matching host identity.

## Adding modules

Add only implemented features. Do not create empty feature scaffolds or advertise planned capabilities as shipped. Keep feature configuration scoped, client UI limited to native slots, and runtime dependencies isolated. Extend public entrypoints deliberately; do not move unrelated logic into the gateway worker.

Tests should prove user-visible behavior and security boundaries. Put gateway tests in `tests/gateway/`, host/controller tests in `tests/plugin/`, and build/package contract checks at `tests/` root. Share fixtures within their test area. Every added resource must have an explicit owner and disposal path.

The [archived-session deletion module](archived-session-deletion.md) documents the isolated JSONL compatibility adapter, native ownership checks, network access and deletion recovery. Future modules live under `src/modules/<feature>/`, with explicit host/client registration and focused tests. Only LAN configuration is restricted to the local host; other feature endpoints remain available to authenticated LAN users.

## UI and appearance

Use `@deepseek-ai/dsh-client-ui-primitives` for in-app controls, menu items, modals, icons and toasts. The native browser module supplies the implementation and CSS; the development dependency supplies types. Keep plugin layout in `src/client/styles.ts`, scoped to plugin classes and using `--dsw-*` tokens. Do not set a separate in-app palette or copy generated native class names. Active native themes and `theme.overrideTokens` then apply to DSH++ as well.

The token login screen is a separate, script-free document before authentication. It cannot inherit the authenticated app's DOM, browser theme state, or assets. `src/appearance/theme.ts` provides its minimal native defaults and a shared `AppearanceTokens` type with the public native theme API's `{ light, dark }` values. `GatewayOptions.appearance` accepts these tokens and an optional `system` / `light` / `dark` preference; only token declarations are serialized into the page. Defaults follow the device's color scheme.

`cordis.patch.yml` pins both faces of the public in-app directory browser for workspace selection: the host backend and its client Slot occupant. The DSH auto-picker sees only the loopback listener and can choose an OS dialog on the host display; remote LAN browsers cannot use that interaction, and its response waits for a person. The browse backend serves the same directory-picker API without a host GUI and is available to authenticated local and LAN clients.

When implementing a DSH++ appearance module, keep its dual-mode tokens in one shared definition. Register that definition through the public native theme API in its client and pass it as `appearance.tokens` when the host constructs the gateway options in `LanManager`. Also pass any explicit theme preference there. Browser-only CSS overrides cannot automatically propagate to a separate pre-authentication document. This requires no public appearance endpoint or anonymous native assets.

## Style and release workflow

Use TypeScript for runtime code and small Node ESM scripts for build/verification. `.editorconfig` defines two-space indentation, UTF-8, and LF. Prettier provides a repeatable formatting rule set; `npm run format` applies it and `npm run check` checks it. Keep imports explicit and avoid duplicated configuration or version literals in build logic.

Before publishing, update the version and changelog, run `npm run check`, inspect the package file list, and build with `npm pack`. A Git push does not publish to npm or deploy the installed DSH. Only publish or install when requested.

Do not commit dependency folders, generated bundles, package archives, environment files, local diagnostics, or credentials. Required licenses and attribution remain in the package.
