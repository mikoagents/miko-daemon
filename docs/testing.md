# Testing

Keep tests beside the behavior they verify. Use real storage, worktrees and isolated daemon
processes for recovery and lifecycle contracts. Replace provider IO for deterministic tests;
paid native-provider tests require explicit operator credentials and are not a default check.

Every test should assert observable behavior. For a bug, reproduce the failure before changing
production code. Wait on the relevant event or authoritative state rather than fixed sleeps.
Use separate temporary homes and allocated ports; always close clients, sessions and processes.
Never use or restart the live Paseo daemon on 6767.

Run affected files locally with `npx vitest run <files> --maxWorkers=1 --bail=1`, from their
workspace. Keep broad runs in a log file and avoid parallel subprocess-heavy suites. CI owns
the complete retained test matrix. Build owning workspace declarations before diagnosing types.

`npm run test:miko` covers public service receipts, authentication/permission boundaries,
remote translation and the headless local execution composition. `npm run test:core` covers
inherited manager, provider, request journal, process lock and supervisor behavior. The package
installation smoke starts and stops an isolated installed supervisor and probes its actual port.

For changes at the public boundary, update Hub's exact daemon commit and run its source
workflow suite. Test local and existing-service execution, lost acknowledgements, reconnects,
restart, continuation, required outputs and authorization. See [upstream maintenance](miko-upstream.md).
