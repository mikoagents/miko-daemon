# Security

Run Miko only in an environment where you trust the configured Hub and native provider tools.
Enrollment credentials establish connectivity; `hub.execute` separately authorizes tasks.
Providers enforce their native sandbox, permission and MCP rules. Miko never auto-approves prompts.

State and backend credentials belong in a private Miko home, separate from Paseo. Configure
a daemon password before exposing its native management endpoint, and use TLS or an SSH tunnel
for access beyond the loopback interface. Existing Paseo backend credentials are separate from
Hub enrollment credentials. Keep all credentials outside this repository.

Report vulnerabilities privately through GitHub's security advisory flow for this repository.
