# PostgreSQL repository migration foundation

## Status

The `feature/async-settings-storage-v3.8.52` branch is based on the synchronized `release/v3.8.52` fork branch and contains an asynchronous PostgreSQL foundation alongside the existing SQLite implementation. It is deliberately **not** enabled by the application composition root. The running application still defaults to the SQLite adapter in `src/lib/db/core.ts`. `src/lib/db/settings.ts` now accesses settings rows and revisioned writes through `SettingsStorage`; server composition can inject the PostgreSQL implementation with `configureSettingsStorage()` once a real PostgreSQL pool is available.

Included:

- `postgresTypes.ts`: driver-neutral Pool, PoolClient, Queryable and AsyncDatabase contracts.
- `postgresDatabase.ts`: parameterized query boundary, transaction lifecycle, rollback, bounded retries for PostgreSQL serialization/deadlock SQLSTATEs, health check and idempotent close.
- `settingsRepository.ts`: PostgreSQL settings reads and revision-checked writes using row-level locking.
- `settingsStorage.ts`: common storage contract with SQLite and PostgreSQL adapters. The SQLite adapter preserves the existing synchronous driver's transaction boundary; the PostgreSQL adapter delegates to the async repository and retries compare-and-swap conflicts only for writes without an explicit expected revision.
- `postgresMigrationRunner.ts`: advisory-lock-protected, transactional SQL migration runner with immutable SHA-256 checksums.
- `postgresMigrations.ts`: initial PostgreSQL-owned `key_value` schema.
- Unit tests using structural fake pools, with no database service required.

## Why it is not wired into production yet

The current application imports synchronous SQLite statements across `core.ts` and many domain modules. PostgreSQL is network I/O and cannot implement that API honestly. Replacing the singleton now would either break callers or hide asynchronous work behind blocking/unsafe behavior.

The existing SQLite migration system contains a large, versioned migration history with SQLite-specific DDL and compatibility handling. It must not be replayed blindly against PostgreSQL. The new PostgreSQL migration runner is a separate ledger; it currently owns only the small key-value schema declared in `postgresMigrations.ts`.

The repository currently does not declare a PostgreSQL client package. The foundation accepts a structurally compatible pool so that a concrete driver can be added together with its lockfile update and runtime packaging verification. No undeclared runtime import is introduced here.

## Transaction rules

- Always use `db.transaction(async tx => ...)` for atomic multi-statement work.
- Pass `tx` to repository methods participating in that transaction.
- Keep callbacks database-only when retries are enabled. A serialization failure can cause the callback to execute again.
- Retries are opt-in and capped at three; only SQLSTATE `40001` and `40P01` are retried.
- Never interpolate user input into SQL. Use positional parameters.
- Historical migrations are immutable. Add a new migration instead of editing one that has been applied.

## Next integration gates

1. Add and lock a supported PostgreSQL driver, then create a server-only pool factory with TLS, bounded pool size, connection timeout and shutdown integration.
2. Continue migrating synchronous settings consumers, including the deprecated synchronous request-body-limit accessor, then introduce async repository interfaces for provider connections, API keys, usage history, call logs, teams, webhooks and the remaining domains.
3. Move domain call sites incrementally. Keep SQLite repositories for local mode and compatibility.
4. Build an explicit SQLite export/import pipeline. Convert types, booleans, timestamps, JSON text, autoincrement identifiers, indexes and foreign keys; validate row counts and canonical checksums before cutover.
5. Add full PostgreSQL schema migrations and dual-backup rollback procedures before allowing PostgreSQL to become the production source of truth.
6. Add object storage and shared session adapters before enabling more than one application instance.

## Validation

Run the new unit tests with the repository's normal TypeScript test runner:

```sh
node --import tsx --test \
  tests/unit/db-adapters/postgresDatabase.test.ts \
  tests/unit/db-adapters/postgresKeyValueRepository.test.ts \
  tests/unit/db-adapters/postgresMigrationRunner.test.ts
```

These tests have been authored but were not executed in this environment. A successful unit run does not replace integration tests against a real PostgreSQL service.
