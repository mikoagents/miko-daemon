# Miko CLI

The execution distribution provides four command groups:

- `daemon`: start, status, stop, restart, validate configuration/restart requirements and authentication setup.
- `provider`: discovery, model catalogs and native provider diagnostics.
- `backend`: configure and diagnose existing Paseo execution services.
- `hub`: authentication, enrollment, explicit execution grants and workflow deployment.

Run `miko --help` and each command's `--help` for exact options. An isolated state directory
is selected with `MIKO_HOME` or `--home`; its default is `~/.miko`. Lifecycle commands retain
the inherited supervisor, lock, IPC and worker heartbeat. Status distinguishes a starting
worker from a ready listener. Task execution and completion are driven by Hub.

See [backends](../../docs/miko-backends.md) and [architecture](../../docs/architecture.md).
