# Deploy OmniRoute to Render

This guide deploys the maintained Render profile directly from GitHub. No AI assistant,
local checkout, shell session, or hand-written environment configuration is required.

## What you need

- A GitHub account.
- A Render account.
- A Neon account and a PostgreSQL database. Render's free web-service filesystem is
  ephemeral, so the Neon snapshot integration is required if you want data to survive
  restarts and instance replacement.
- The Neon PostgreSQL connection string. Use a connection string with TLS enabled
  (Neon connection strings normally include `sslmode=require`).

## Deploy

1. Create a Neon project and database. Copy its PostgreSQL connection string and keep it
   private.
2. Open the **Deploy to Render** link in the repository README.
3. Sign in to Render and authorize access to the repository fork if prompted.
4. Review the Blueprint plan and apply it. Render generates `JWT_SECRET`,
   `API_KEY_SECRET`, and `INITIAL_PASSWORD` automatically.
5. Before the first successful boot, open the new service in Render, go to **Environment**,
   and add `DATABASE_URL` with the Neon connection string. Do not put it in source control,
   a Docker build argument, or a `NEXT_PUBLIC_*` variable. Save the change to trigger a deploy.
6. Wait for the deployment to become Live, then open the service URL.
7. In the Render service's Environment page, reveal/copy the generated
   `INITIAL_PASSWORD` and use it for the first dashboard login. Change it immediately
   in the dashboard. The password is persisted in the application database, so changing
   the environment variable later does not reset an already initialized password.

## What the Blueprint configures

- Docker build from the repository's production Dockerfile.
- `/api/health` health checks.
- Production host binding and the writable SQLite data directory.
- Conservative memory/concurrency settings for the Render Free 512 MiB instance.
- Neon snapshot persistence, a 10-minute snapshot interval, and three retained snapshots.
- Generated JWT, API-key and initial dashboard-password secrets.
- A manual `DATABASE_URL` prompt so each deployment uses its own Neon database.

The Neon snapshot helper streams SQLite dumps, compression, Base64 transfer, restore
decoding and SQLite reconstruction. It avoids loading the complete database or SQL dump
into Node.js memory. The configured snapshot database-file ceiling is 64 MiB; databases
larger than that are refused rather than risking an out-of-memory restart.

## Verify the deployment

- Render reports the service as **Live**.
- `https://YOUR-SERVICE.onrender.com/api/health` returns a healthy response.
- The service logs contain `[NEON] SQLite recovery snapshots enabled` and, after the
  first successful snapshot, `[NEON] snapshot saved`.
- Complete the dashboard's first-login password change.
- Add at least one provider and verify a test request before importing production data.

A configured `DATABASE_URL` is not proof that snapshots are working. Check for the
successful snapshot log entry.

## Updating

The Blueprint disables automatic deploys intentionally. This prevents a maintainer's
push from unexpectedly redeploying every independent instance created from the public
Deploy button. To update later, open the service in Render and use **Manual Deploy → Deploy
latest commit** when you are ready. Keep `render.yaml` and this guide together when changing
deployment requirements. Review the Render Blueprint plan before applying infrastructure
changes.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Blueprint asks for `DATABASE_URL` | Paste the Neon PostgreSQL connection string, including TLS settings |
| Container exits because `DATABASE_URL` is missing | Confirm the value was saved in Render Environment and redeploy |
| Login says too many failed attempts | Wait for the rate limit to clear; use the dashboard password already stored in the database |
| Neon snapshot fails | Check the Neon URL, database permissions, and `psql`/SQLite helper logs |
| Snapshot refuses the database size | The current safety ceiling is 64 MiB; do not raise it without validating cold-start restore memory |
| Service loses data after restart | Confirm Neon snapshots are succeeding; the Render Free filesystem is not durable |

## Other hosting

For Docker, VPS, or a platform with persistent disks, follow the normal Docker deployment
and set a persistent `DATA_DIR`. Neon snapshot persistence is optional when the host
provides reliable durable storage and backups.
