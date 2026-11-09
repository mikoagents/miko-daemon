# Maintaining the Miko fork

The exact baseline and selectively synchronized upstream commits live in `MIKO_UPSTREAM.json`.
`origin` is `mikoagents/miko-daemon`; `upstream` is `getpaseo/paseo`. Retain upstream history,
Apache licensing, file paths and internal symbols. Keep native protocol schemas backward compatible.

Miko's execution protocol lives in `packages/execution-protocol`. Its version is independent
of the native protocol. Hub records a daemon commit and a schema digest in its compatibility file.
A protocol change must update that pair and pass both repositories' contract tests.

## Selective synchronization

1. Fetch upstream and create a `sync/<subject>` branch from Miko main.
2. Review the entire upstream change and its dependency commits. Provider, native protocol,
   client, persistence and recovery changes that depend on one another travel together.
3. Apply the complete group with `git cherry-pick -x <commits>`.
4. Build owning packages before interpreting cross-package type errors. Run the affected
   upstream tests, `npm run test:miko`, `npm run typecheck:miko`, lint and formatting.
5. Run Hub's source E2E suites against this checkout and the candidate immutable commit.
6. Record each synchronized source commit here, merge the sync branch, and update Hub's pin.

Do not replace a pin with a branch, automatically advance upstream, rename core symbols,
or regenerate the repository as a source archive.

## Fork boundary

The current distribution contains only the five packages described in [architecture](architecture.md).
Deleted product source remains in Git history. Keep provider/session/storage/supervision paths and
symbols stable; adapt provider changes at the narrow bootstrap/execution boundary.

Local execution directly composes the inherited agent manager, request receipts, worktrees and
recovery services. There is no virtual native
socket, interactive product session or second process supervisor. Internal package names remain
private; `pack:miko` maps staged files to `@mikoagents/*`.

The repository intentionally drops all product application, speech, relay, plugin host, browser,
terminal UI, resident schedule/heartbeat, script proxy and related release/tooling trees. Do not
resolve an upstream conflict by bringing these trees back. Native schemas remain a compatibility
boundary for local management and providers, rather than enabling those products.

Miko defaults to `~/.miko` and port 7767. Development commands use `.dev/miko-home` on port 7768
without copying credentials or state from an existing Paseo home.

## Synchronization exercise

On 2026-11-09, `sync/provider-fixture-cleanup` applied upstream
`79f2db8d56864245fb4361bacd939377af88f78b` with `cherry-pick -x`. The change touches only bounded
cleanup in the provider availability fixture and has no dependency commits. Its provider tests
passed on macOS; Windows execution remains CI's responsibility. This validates preserving source
attribution without moving the baseline or modifying provider/session architecture.
