# Miko daemon

Miko executes Hub workflows through local providers. It derives its
provider, session, storage and process supervision modules from [Paseo](https://github.com/getpaseo/paseo).
The upstream history and Apache-2.0 license are retained.

Node.js 22 or later is required.

```sh
npm ci
npm run build:miko
npm run pack:miko
node scripts/smoke-miko-install.mjs
```

`pack:miko` creates five installable `@mikoagents/*` tarballs under `artifacts/`. Install all
five tarballs in a separate directory with `npm install /absolute/path/to/artifacts/*.tgz`.
These packages have not been published to npm.

```sh
miko daemon start
miko daemon status
miko provider ls
miko agent ls -ag
miko agent inspect <id> --json
miko agent logs <id> --follow
miko hub login https://your-hub.example
miko hub connect --help
miko hub permissions --help
miko daemon stop
```

State defaults to `~/.miko`, with `MIKO_HOME` overriding it. The default endpoint is
`127.0.0.1:7767`. Configure provider credentials using the provider's native authentication
or explicit provider configuration; Miko never grants task authority during enrollment.
Grant `hub.execute` separately when intended.

The supported command groups are `daemon`, `provider`, `hub` and read-only `agent` diagnostics. Workflow
orchestration, prompts, outputs and completion belong to Hub. Miko includes all inherited
provider adapters, custom ACP agents and provider profiles. It includes no mobile/desktop/web
application, voice models, relay, plugin host, browser host, terminal UI, script hosting or resident scheduler.
The OpenCode adapter's native bridge remains part of provider execution.

- [Execution architecture and scope](docs/architecture.md)
- [Custom providers and profiles](docs/custom-providers.md)
- [Upstream synchronization](docs/miko-upstream.md)
- [Contributing and verification](CONTRIBUTING.md)

Agent diagnostics keep Paseo's command names and options: `agent ls` (`-a`, `-g`, labels),
`agent inspect` (including `--json`), and `agent logs` (`--tail`, `--filter`, `--since`, `--follow`).
`agent logs --json` preserves complete available tool details; follow mode emits JSON lines.
Archived sessions remain inspectable with `agent ls -ag`. Provider history supplies session
transcripts after daemon restart where the provider supports persistence. Tool output retains
Paseo's size limits; diagnostic reads do not change provider permissions or submit prompts.
