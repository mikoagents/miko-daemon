# Durable execution state

Miko uses private, file-backed state under its own home (`~/.miko` by default).
`AgentStorage` owns agent configuration, provider persistence handles and lifecycle records.
Project/workspace registries preserve cwd and worktree identity for archive and recovery.
The existing provider/session modules own native handles; there is no second session database.

`config.json` contains execution configuration. Its strict schema rejects removed product fields
instead of silently accepting them. Provider profiles and native options retain their upstream
meaning. Credentials belong in provider authentication or private explicit configuration.

`hub-relationship.json` records enrollment and connection authority; its task permission grant
is independent of the connection credential. `daemon-keypair.json` preserves the enrollment's
X25519 identity format without installing an encrypted relay runtime.

The native agent request journal spans connection lifetimes. Each public execution connection
also has private request receipts and session bindings under `miko/`, scoped by enrolled Hub
identity. Bindings record the provider and native agent/workspace IDs.

Persist intent before side effects. Replay confirmed receipts. Treat an interrupted submission
as unknown and query its receipt; do not infer failure or resubmit from a timeout. See
[architecture](architecture.md) for ownership.
