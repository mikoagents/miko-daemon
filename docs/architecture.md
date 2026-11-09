# Execution distribution

Hub owns triggers, routing, scheduling, workflow state, task authority and completion.
Miko owns provider sessions, their processes and persisted execution references.

The startup chain remains CLI → supervisor → daemon worker → bootstrap. The supervisor
retains its process lock, IPC, worker heartbeat, crash restart and graceful shutdown.
`bootstrap.ts` composes provider discovery, `AgentManager`, `AgentStorage`, the native
worktree/registry/recovery modules, Hub relationship management and execution connections.

Local execution calls `miko/provider-execution.ts` directly. There is one provider/session owner;
local requests do not loop through a virtual socket or instantiate an interactive Paseo session.
The public service journals requests and binds each session to its enrolled Hub,
provider and native reference. Provider adapters keep their native permissions and MCP behavior.

Miko executes through its own provider/session manager. The local `/ws` endpoint
provides only direct management, provider discovery and the execution RPC subset. Removed
operations return an explicit unsupported error. Reload validates configuration and reports
restart requirements; it does not partially reconfigure a running provider registry.

## Package boundary

| Package              | Maintained purpose                                                           |
| -------------------- | ---------------------------------------------------------------------------- |
| `cli`                | Daemon lifecycle, provider diagnostics, Hub enrollment and authorization     |
| `server`             | Supervision, providers, durable sessions, recovery and execution adapters    |
| `protocol`           | Inherited wire schemas and native provider/configuration types               |
| `client`             | Direct native control, provider discovery, Hub management and timeline reads |
| `execution-protocol` | Independent, versioned Hub execution contract                                |

Native schemas retain upstream wire vocabulary for local management and provider compatibility.
Schema names do not enable their corresponding product services in Miko. The client SDK
and server do not ship their terminal, file-browser, plugin, UI, voice or scheduling operations.

## Removed scope

Mobile, desktop, website, speech/audio models, encrypted relay/pairing, push, the full plugin
host, interactive browser and terminal hosts, file browser/editor APIs, script/service proxy
and resident schedule/heartbeat services are removed from source, installation and release.
Their build tasks, tests, documentation, examples, release tooling and CI are removed too.
Provider process/stdio, native file access, explicit MCP servers, Git worktrees and request
receipts remain because execution depends on them. Provider-managed plugins remain the
provider's own concern; Miko does not host Paseo product plugins.

The deleted products remain available in upstream Git history. Select upstream fixes by
module; do not restore a removed product as a dependency of an execution fix.
