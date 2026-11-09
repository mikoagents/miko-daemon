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

- Core startup remains CLI → supervisor → worker → bootstrap. Miko's service is attached at
  the existing Hub socket lifecycle in bootstrap. Local execution attaches an ordinary native
  session to that daemon's existing server and provider manager.
- `src/server/miko` owns native Paseo translation, backend configuration, execution references
  and request receipts. It never answers provider permission requests.
- Native packages keep their upstream names in source. `scripts/pack-miko.mjs` maps package
  names and import specifiers in staged release files to `@mikoagents/*`; source packages are
  private to prevent accidental publication under the upstream namespace.
- Mobile, desktop and website source remains in history and the tree but is excluded from
  the daemon workspace install/release. Original deployment workflows are archived outside
  GitHub's executable workflow directory.
- Miko defaults to `~/.miko` and port 7767. `MIKO_HOME` selects a separate home;
  explicit upstream `PASEO_HOME`/config overrides remain available for inherited tooling.
  Relay, speech, web UI and injected native MCP are off by default. Core terminal, filesystem,
  process and provider facilities remain available.

## Synchronization exercise

On 2026-11-09, `sync/provider-fixture-cleanup` applied upstream
`79f2db8d56864245fb4361bacd939377af88f78b` with `cherry-pick -x`. The change touches only bounded
cleanup in the provider availability fixture and has no dependency commits. Its provider tests
passed on macOS; Windows execution remains CI's responsibility. This validates preserving source
attribution without moving the baseline or modifying provider/session architecture.
