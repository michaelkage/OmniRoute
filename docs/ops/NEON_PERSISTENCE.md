---
title: "OmniRoute + Neon Snapshot Durability"
version: 3.8.55
lastUpdated: 2026-11-21
---

# OmniRoute + Neon snapshot durability

## What this integration does

OmniRoute continues to use its existing SQLite database at runtime. When explicitly enabled,
the Neon integration stores compressed SQLite recovery snapshots in a PostgreSQL table.

It is **not** a PostgreSQL query adapter, live replication, multi-writer storage, or a substitute
for a mounted persistent volume. The live request path remains SQLite.

The runtime sequence is:

1. Resolve the exact SQLite file through OmniRoute's own database path resolver.
2. Before SQLite initialization, restore the newest Neon snapshot only if the local database
   file is missing.
3. Run the normal SQLite initialization, migration, and health-check path.
4. Create an initial snapshot and then snapshot at the configured interval.
5. During graceful shutdown, wait for any active snapshot and attempt one final snapshot
   before SQLite is closed.

A restore never overwrites an existing database. It also refuses to proceed when orphaned
SQLite WAL/SHM sidecars exist without the main database file.

## Enablement

Set these on the **backend process only**:

~~~dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require
OMNIROUTE_NEON_PERSISTENCE=1
OMNIROUTE_NEON_SNAPSHOT_INTERVAL_MS=300000
OMNIROUTE_NEON_SNAPSHOT_RETENTION=12
~~~

The feature is disabled unless OMNIROUTE_NEON_PERSISTENCE=1 is set. A connection URL alone
does not activate it. Never use a NEXT_PUBLIC_* variable for the connection string.

The runtime needs the psql and sqlite3 executables on PATH. The upstream Docker image
installs both. For a host/PM2 deployment, install the PostgreSQL client and SQLite CLI using
your OS package manager.

## First deployment

1. Create a Neon database and copy its pooled or direct PostgreSQL connection string.
2. Configure the backend environment variables above.
3. Ensure DATA_DIR points to the same writable directory used by the running OmniRoute
   process. If unset, the helper follows the default ~/.omniroute location and XDG/Windows
   data-directory conventions.
4. Run npm run neon:ensure with the same environment as the backend.
5. Start OmniRoute. If no snapshot exists yet, the normal SQLite first-boot initialization
   proceeds and the runtime immediately attempts its first snapshot.
6. Confirm the logs contain [NEON] snapshot saved. A configured URL is not proof that
   snapshots are succeeding.

## Operations

Run commands from the installed package root with the same DATABASE_URL, enable flag, and
DATA_DIR as the backend:

~~~bash
npm run neon:ensure
npm run neon:snapshot
npm run neon:restore
~~~

The restore command is intentionally non-destructive: if the SQLite file already exists it
skips. For recovery, stop the backend first, preserve the current data directory for forensic
inspection, then remove or move only the missing/corrupt main database after confirming the
recovery procedure. Do not remove WAL/SHM files casually; the helper fails closed if sidecars
remain without the main database.

The manual GitHub Actions workflow Neon Persistence Operations supports ensure, snapshot,
and an explicitly confirmed restore. Restore requires the operator to type RESTORE and stops
the PM2 process before applying the snapshot.

## Retention, consistency and recovery point

- Default cadence: 5 minutes; minimum: 1 minute.
- Default retention: 12 snapshots; supported range: 1-100.
- Snapshots use SQLite's online .backup command, then dump and gzip the consistent backup.
- Snapshot failures return a non-zero exit code in manual/workflow operations and are logged
  as non-fatal during periodic runtime operation.
- The expected recovery-point objective is approximately one snapshot interval, plus the time
  since the last successful snapshot. Monitor successful snapshot logs and alert on repeated
  failures.

Do not run multiple active OmniRoute writers against the same Neon snapshot table. Concurrent
instances have independent SQLite files and can overwrite the recovery history with snapshots
from different states. Use one active writer per Neon database unless a coordinated
multi-instance design is implemented separately.

## Security and limitations

- Keep DATABASE_URL in a backend secret manager or GitHub Actions secret.
- Use TLS (sslmode=require or stricter) and rotate the Neon password if it was exposed.
- Neon encrypts its managed storage, but this integration does not add application-level
  encryption to the snapshot payload. Restrict database access and use a dedicated Neon role.
- The snapshot payload contains the full SQLite dump, including encrypted credential fields and
  all other database content. Treat access to the Neon table as access to the application data.
- GitHub Pages can host static assets and docs; it cannot run the Node.js backend or safely
  hold DATABASE_URL.

The deployment topology is:

~~~text
OmniRoute backend (SQLite runtime)
          |
          +---- periodic / shutdown snapshot ----> Neon Postgres
          |
          +---- restore only when local DB absent <----+
~~~
