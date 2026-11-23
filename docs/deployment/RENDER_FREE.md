# OmniRoute on Render Free

This deployment uses **one Render web service** and an external PostgreSQL service (Neon or Supabase). It does not create a Render Postgres database, Redis service, worker, cron job, or persistent disk.

## Important: what persistence means today

OmniRoute's live application database is still synchronous SQLite. The current PostgreSQL integration is a **single-instance recovery-snapshot mechanism**, not a live PostgreSQL adapter:

1. On boot, if the local SQLite file is absent, OmniRoute downloads the latest PostgreSQL snapshot and restores SQLite.
2. While running, OmniRoute creates a SQLite-consistent backup and uploads a compressed SQL dump periodically.
3. PostgreSQL is not used for live request queries. Multiple active OmniRoute instances must not share this snapshot table.

Render Free has ephemeral filesystems, so this is best-effort recovery rather than equivalent to a persistent disk or transactional live database. A crash, forced shutdown, failed upload, or spin-down can lose changes made since the last successful snapshot. The blueprint uses a 10-minute interval. Do not use this design for workloads that require zero data loss, multiple instances, or strict durability.

The snapshot helper is deliberately memory-bounded for the 512 MB service: it refuses databases larger than 16 MiB by default, caps helper V8 heap at 64 MiB, and caps child-process buffers. If the database grows beyond the limit, snapshots fail safely and logs contain a `[NEON]` warning. The service may continue running, but new changes are no longer protected. Monitor those logs.

The 256 MiB `OMNIROUTE_MEMORY_MB` value caps the main Node V8 heap; it does **not** cap total RSS or native allocations. Provider response buffers, Next.js, SQLite native memory, WebSockets, and child processes also consume RAM. This is a conservative starting profile, not a proof that every provider workload fits 512 MB. Keep concurrency low and load-test your actual traffic.

## 1. Create external PostgreSQL

Create a database on Neon or Supabase. Do not use Render's free PostgreSQL plan for this deployment: Render's free database is temporary.

Copy the provider's PostgreSQL connection string. It must use `postgres://` or `postgresql://`, include host/user/database, and support TLS. Use the provider's pooled URL only if its pooler supports the required `psql` session and COPY operations; otherwise use its direct connection URL.

The PostgreSQL role must be allowed to create a table and index and to insert, select, and delete rows in the database. OmniRoute creates `omniroute_sqlite_snapshots` automatically.

## 2. Deploy the Blueprint

1. Push this branch (or merge it into your deployment branch) to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Render reads the root `render.yaml`.
4. During initial Blueprint creation, provide `DATABASE_URL` when prompted.
5. Deploy the service and wait for the Docker build and health check.

The Blueprint generates `JWT_SECRET`, `API_KEY_SECRET`, and `INITIAL_PASSWORD`. Keep those values private. Changing either secret after data has been written can invalidate sessions or make previously encrypted data unreadable. Save a secure copy of them.

The service binds through OmniRoute's existing runtime port handling. Render supplies `PORT`; do not hard-code a different public port.

## 3. First login and API security

- Open the deployed service URL.
- Retrieve the generated `INITIAL_PASSWORD` from the Render service environment settings.
- Sign in and immediately change the administrator password.
- Keep `REQUIRE_API_KEY=true`; create an API key in the dashboard before using `/v1`.
- Add provider credentials through the dashboard. Never put provider secrets in `render.yaml`, source control, or browser code.

## 4. Verify persistence

After first deployment:

1. Confirm the service logs show Neon persistence enabled.
2. Wait for a successful `[NEON] snapshot saved` message.
3. Add a harmless setting or test API key.
4. Wait for another successful snapshot.
5. Trigger a Render restart.
6. Confirm logs show the database was restored from Neon, or that an existing local database was retained.
7. Confirm the setting/API key remains present.
8. Repeat after allowing the service to spin down.

A successful liveness check at `/api/health` only proves that the HTTP process is alive. `/api/health/ping` also probes SQLite and can be used for manual readiness checks.

## 5. Free-tier operating constraints

- One web service only. Do not add a worker or second always-on service; this consumes the workspace's shared monthly compute-hour allowance.
- Render sleeps the free service after inactivity. The first request after sleep experiences a cold start.
- The filesystem under `/tmp/omniroute-data` is disposable. Do not rely on local uploads, logs, SQLite backups, or artifacts surviving a restart.
- The 16 MiB snapshot database limit is intentional. Raising it increases peak memory in the snapshot helper and must be accompanied by measured RSS tests.
- The periodic snapshot interval means a non-zero recovery-point window. Lowering it increases database traffic and CPU/memory pressure.
- Keep one Render instance. This snapshot scheme has no distributed lock or multi-writer coordination.
- Keep an eye on Render's outbound bandwidth, build-minute, and compute-hour usage, and on the external database provider's storage/compute limits.

## 6. Local development

The default local path remains SQLite and requires no cloud database:

```bash
cp .env.example .env
# Set unique JWT_SECRET and API_KEY_SECRET values in .env.
# Keep OMNIROUTE_NEON_PERSISTENCE unset for normal local development.
npm ci
npm run dev
```

Open `http://localhost:20128` unless `PORT` is changed. To keep local data in the repository's ignored `data/` directory, set `DATA_DIR=./data`. The default data location is under the user's home directory.

To exercise PostgreSQL snapshot recovery locally, install the `sqlite3` and `psql` command-line tools, set `DATABASE_URL`, `OMNIROUTE_NEON_PERSISTENCE=1`, and run:

```bash
node scripts/neon/persistence.mjs ensure
node scripts/neon/persistence.mjs snapshot
```

To test restore, stop OmniRoute, move the local `storage.sqlite` and its `-wal`/`-shm` sidecars out of `DATA_DIR`, then run:

```bash
node scripts/neon/persistence.mjs restore
```

Do this only against a disposable test database and a copy of local data.

## 7. When to upgrade the architecture

Use a paid persistent disk if you want to keep SQLite as the live database. Use a real asynchronous PostgreSQL repository/adapter migration before running multiple instances or relying on PostgreSQL as the live transactional store. Move user-uploaded files and generated artifacts to object storage before exposing those features on an ephemeral host.

This Render profile is a low-cost single-instance deployment path, not a replacement for a production database architecture.
