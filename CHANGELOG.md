# Changelog

## Unreleased

- Trim the fork to provider execution, durable sessions and worktrees, process supervision,
  explicit Hub authorization and local/existing-Paseo adapters.
- Remove application, speech, relay, plugin host, browser/terminal UI, scripts, resident scheduler,
  related dependencies and product release/build/CI tooling.
- Restrict CLI to daemon, provider, backend and Hub management. Local execution uses the native
  session manager directly. Removed operations and configuration fail explicitly.

Earlier Paseo release history is preserved in Git history and at the recorded upstream source.
