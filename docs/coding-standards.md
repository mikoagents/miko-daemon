# Coding standards

Preserve native execution module paths and symbols so upstream changes can be selected by
module. Keep Miko-specific behavior at the bootstrap and execution boundary. Every new
abstraction needs a concrete execution use; removed product code stays in Git history.

Use strict TypeScript without `any`, suppression comments or casts that hide errors. Prefer
interfaces for object shapes and discriminated unions for distinct states. Derive types from
existing schemas. Validate network, IPC, configuration and persisted-data boundaries; trust
the resulting types internally.

Keep native provider configuration and permissions explicit. Unknown options and unsupported
capabilities fail with useful errors. Do not rewrite prompts, inject hidden context, approve
permission requests, or retry a request whose outcome remains unknown.

Use atomic private files for durable state and serialize mutations that share identity.
Every admitted process, listener and session needs an owner and shutdown path. Event gaps
are not proof of success; recovery reads an authoritative snapshot or persisted receipt.

Tests assert behavior using isolated state and deterministic synchronization. See [testing](testing.md).
Build owning workspace declarations before interpreting types. Run formatting and linting
through npm scripts; the formatter is Oxfmt.
