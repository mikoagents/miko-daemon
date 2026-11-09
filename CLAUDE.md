# Miko daemon development

This repository is an execution distribution derived from Paseo. Its retained packages are
`cli`, `server`, `protocol`, `client` and `execution-protocol`. Read [architecture](docs/architecture.md),
[contributing](CONTRIBUTING.md), [custom providers](docs/custom-providers.md) and
[upstream synchronization](docs/miko-upstream.md) before substantial changes.

Keep provider/session/storage/supervision modules at their upstream paths. Miko-specific
execution logic belongs in `packages/server/src/server/miko`. Preserve native provider options
and permissions, explicit MCP grants, durable receipts and session ownership. Never rewrite
task prompts or auto-approve permissions. Removed products must stay out of dependency/build
closures; native wire schema vocabulary is retained for existing Paseo interoperability.

- Never restart the live daemon on port 6767 or use its state for tests.
- Build owning workspaces before diagnosing cross-package types (`npm run build:miko`).
- Run typecheck and lint after changes; use npm scripts for lint/format, and Oxfmt for formatting.
- Run affected tests locally with one worker. Never run the entire workspace suite locally;
  CI runs the retained suites. Avoid parallel resource-heavy test runs.
- Strict TypeScript, no `any`, no unsafe casts to suppress errors. Validate external boundaries.
- Preserve upstream native wire compatibility; the public execution protocol is separately versioned.
- Do not restore UI, voice, relay, schedules or plugin hosts while synchronizing provider fixes.
