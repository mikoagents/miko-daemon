# Miko execution runtime

Retains Paseo's supervisor, worker, native provider adapters, agent manager, persistence and
Git worktree/recovery modules. The composition root owns only execution and Hub connectivity.

See [architecture](../../docs/architecture.md) and
[contributing](../../CONTRIBUTING.md). Build the complete owning stack from the root with
`npm run build:miko`; run targeted tests here with `npx vitest run <files> --maxWorkers=1`.
