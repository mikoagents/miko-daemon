# Changelog

## Unreleased

- Make provider and CLI tests portable across clean CI runners, normalize source line endings, and run npm packing through Node on Windows.
- Trim the fork to provider execution, durable sessions and worktrees, process supervision,
  explicit Hub authorization and local/existing-Paseo adapters.
- Remove application, speech, relay, plugin host, browser/terminal UI, scripts, resident scheduler,
  related dependencies and product release/build/CI tooling.
- Keep CLI Hub login credentials in the same isolated Miko home as the daemon.
- Restrict CLI to daemon, provider, backend and Hub management. Local execution uses the native
  session manager directly. Removed operations and configuration fail explicitly.

Earlier Paseo release history is preserved in Git history and at the recorded upstream source.
