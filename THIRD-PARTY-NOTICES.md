# Third-Party Notices

## Runtime integration

DSH++ integrates with public DeepSeek Harness plugin APIs, Cordis, Schemastery, credentials, and React. These packages are resolved from the native host/client environment and retain their own licenses. The gateway worker contains only project code and Node builtins.

Development dependencies provide compilation, tests, and isolated native integration fixtures. See `package.json` and `package-lock.json` for the dependency list and exact versions.

## Attribution

The project lineage includes work from the following MIT-licensed projects; attribution is retained without shipping their retired features:

- [dsh-rewind](https://github.com/SiriLee/dsh-rewind), v0.15.3, by SiriLee.
- [dsh-lan-tool](https://github.com/MrMu666/dsh-lan-tool), v1.4.7.

[HAPI](https://github.com/tiann/hapi) inspired the custom-token login pattern. No HAPI implementation code is copied. DSH++ owns independent opaque gateway sessions; native DSH authentication remains a separate loopback layer.

See [LICENSE](LICENSE) for this project's MIT license.

The isolated JSONL compatibility adapter in `src/modules/archived-sessions/files.ts` follows the path encoding and directory layout of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), `packages/session/session-persistence-jsonl/src/format.ts`, versions `0.2.1-rc.2` / `0.2.1-rc.3` (MIT, copyright DeepSeek). The applicable upstream MIT notice is included in `LICENSE`.

The standalone LAN login page uses the public DSH theme token names and a minimal set of default design values from DeepSeek Harness `0.2.1-rc.2` (MIT, copyright DeepSeek). In-app controls use the host-provided native UI primitives.
