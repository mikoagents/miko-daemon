# Server development

Follow the [repository guide](../../CLAUDE.md) and [execution architecture](../../docs/architecture.md).
The server owns provider sessions, persistence/recovery, worktrees, supervisor/worker lifecycle
and Hub execution adapters. It has no interactive Paseo product session.

Build with `npm run build:miko` from the root. Run specific server tests from this directory:
`npx vitest run <files> --maxWorkers=1 --bail=1`. Never restart the main daemon on port 6767.
Keep native provider, process, storage and recovery module paths stable for upstream sync.
