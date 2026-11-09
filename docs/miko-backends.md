# Hub execution backends

`local` executes through Miko's inherited provider/session manager. It is always present.
Configure a native Paseo service explicitly:

```sh
miko backend add workstation --url wss://example.test/ws --token-file /private/paseo-token
miko backend ls --json
miko backend diagnostic workstation --json
miko daemon restart
```

Use the remote service's own bearer credential. Miko's Hub credential does not authenticate
against that service. The configuration is private at `$MIKO_HOME/miko-backends.json`;
keep it outside repositories. Listing and execution responses omit credentials.
Diagnostics use their own native client identity and create no agents. Hub connections are
scoped to their enrolled identity and backend, so separate Miko instances cannot replace one
another's subscriptions. A backend name cannot be replaced in place: remove and add deliberately, then restart.
An existing session rejects a changed backend endpoint or credential binding.

Set `run.agent.backend: workstation` in Hub's trigger YAML, or enter the ID in the form.
Omission selects `local`. Provider IDs, model, mode, thinking options and provider options
retain their native meaning. The remote service owns its native agents, workspaces and processes.
It must advertise Hub agent RPCs and durable request receipts. A missing feature is an error.
Exact MCP preapproval is required for unattended Hub execution; custom providers and inherited
profiles advertise their effective contract from Miko's registry. Older Paseo services support
known built-in contracts; unknown profiles require a service that advertises their capabilities.

Connection enrollment defaults to connected-only. Grant `hub.execute` separately when intended.
Miko does not approve permission prompts, rewrite task prompts or grant undeclared output tools.

Request receipts are private and scoped to the enrolled Hub identity. Creates use stable keys;
submissions use the execution's stable message ID. A journal entry is written before the native
request. Successful receipts replay without repeating effects. A submission left pending after
an interrupted acknowledgement remains `request_outcome_unknown`; inspect the native service
before taking an operator recovery action. Reconnecting does not guess its outcome or submit again.
Watches subscribe before reading an authoritative snapshot. Cleanup closes those subscriptions
and native connections; the inherited daemon remains responsible for provider process lifecycle.
