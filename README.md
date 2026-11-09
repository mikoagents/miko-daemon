# Miko Daemon

Self-hosted agent execution for [Miko Hub](https://github.com/mikoagents/hub), derived from
[Paseo](https://github.com/getpaseo/paseo). The CLI command is `miko`.

Miko retains Paseo's CLI → supervisor → worker → bootstrap architecture, provider registry,
native protocol/client, persistence, recovery, MCP and workspace facilities. The first version
supports local execution and explicitly configured existing Paseo services. The mobile app,
desktop app, website and T3 integrations are outside the daemon release.

## Build and install

Use Node.js 22 or newer and npm. From a clean checkout:

```sh
npm ci
npm run build:miko
npm run pack:miko
npm install --global ./artifacts/*.tgz
miko daemon start
miko hub login https://your-hub.example
```

The artifacts contain all internal packages under `@mikoagents/*`; installation does not require
another source checkout or an original Paseo installation. They have not been published to npm.
Connect-only enrollment does not grant execution. If intended, grant it explicitly:

```sh
miko hub permissions grant hub.execute
```

Miko uses `~/.miko` and port 7767, separate from Paseo's default state and port. Set `MIKO_HOME`
for another private home. Relay, speech and the built-in web UI are off by default.

See [backend configuration](docs/miko-backends.md),
[fork maintenance and source provenance](docs/miko-upstream.md), and the inherited
[architecture](docs/architecture.md), [testing](docs/testing.md) and [security](SECURITY.md) guides.

The upstream Apache-2.0 license and attribution are retained in [LICENSE](LICENSE).
