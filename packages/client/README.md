# Native control client

The retained `DaemonClient` supports direct native connections, daemon lifecycle/configuration
diagnostics, provider discovery, Hub enrollment/permissions, agent snapshots and canonical timeline reads.
It keeps the inherited transport, correlation, reconnect and liveness behavior.

Miko's public execution service uses `execution-protocol` and runs providers locally.
Relay E2EE and interactive product
APIs are excluded from this package.
