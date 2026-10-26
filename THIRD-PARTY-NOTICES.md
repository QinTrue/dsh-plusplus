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
