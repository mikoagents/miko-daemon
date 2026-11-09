# Contributing

Develop against `mikoagents/miko-daemon`. Read [the execution scope](docs/architecture.md)
and [the upstream synchronization policy](docs/miko-upstream.md) first.

Use Node.js 22+, run `npm ci`, then `npm run build:miko`. Owning workspaces must be built
before interpreting cross-package declaration errors. Internal upstream package names stay
private; `pack:miko` rewrites staged package names and imports for the Miko distribution.

Run `npm run typecheck:miko`, `npm run lint`, `npm run format:check`, the affected inherited
tests, `npm run test:miko`, and `npm run test:core`. Run targeted suites locally with
`npx vitest run <files> --maxWorkers=1`; reserve the complete retained suite for CI.

For packaging changes run `npm run build:server:clean`, `npm run pack:miko` and
`node scripts/smoke-miko-install.mjs`. Validate execution changes with Hub's source E2E
suite against the exact daemon commit. Keep canonical protocol sources byte-identical.

Use isolated homes and allocated ports. Never restart the live Paseo daemon on port 6767.
Do not include credentials or private operational configuration in this repository.
