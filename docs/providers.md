# Provider maintenance

Retain the upstream provider adapters and registry under `packages/server/src/server/agent`.
Built-in providers, custom ACP agents, profile inheritance, models, modes and thinking options
keep their native semantics. See [custom provider configuration](custom-providers.md).

Provider options are validated by the selected adapter's strict schema. Unknown options and
missing capabilities must produce errors, not be ignored or translated into broader authority.
The Hub catalog advertises effective exact MCP preapproval capability for inherited profiles;
Hub uses that capability rather than a provider-name allowlist.

Declared external MCP servers and task tool grants are passed through to the native provider.
The full Paseo plugin host and auto-injected orchestration tools are absent. The OpenCode
adapter's own bridge remains an execution dependency; it is separate from product plugins.
Miko never answers a provider permission request on the author's behalf.

Synchronize a provider fix with its native protocol, persistence and client dependencies as a
complete change group. Run affected adapter tests and the Hub contract before advancing the pin.
Use [the synchronization procedure](miko-upstream.md); preserve original paths and symbols.
