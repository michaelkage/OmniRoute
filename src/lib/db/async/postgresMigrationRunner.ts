import { createHash } from "node:crypto";
import type { Pool } from "./postgresTypes";

export interface PostgresMigration {
  id: string;
  name: string;
  sql: string;
}

export interface AppliedPostgresMigration {
  id: string;
  name: string;
  checksum: string;
}

const LOCK_KEY_A = 0x4f4d4e49; // "OMNI"
const LOCK_KEY_B = 0x524f5554; // "ROUT"
const MIGRATION_ID = /^[0-9]{3,14}$/;
const MIGRATION_NAME = /^[a-z0-9][a-z0-9_-]{0,119}$/;

function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n").trim()).digest("hex");
}

function validateMigrations(migrations: readonly PostgresMigration[]): PostgresMigration[] {
  const ordered = [...migrations].sort((a, b) => Number(a.id) - Number(b.id));
  const seen = new Set<string>();
  for (const migration of ordered) {
    if (!MIGRATION_ID.test(migration.id) || !MIGRATION_NAME.test(migration.name)) {
      throw new Error(`Invalid PostgreSQL migration identity: ${migration.id}_${migration.name}`);
    }
    if (seen.has(migration.id)) throw new Error(`Duplicate PostgreSQL migration id: ${migration.id}`);
    if (!migration.sql.trim()) throw new Error(`Empty PostgreSQL migration: ${migration.id}`);
    seen.add(migration.id);
  }
  return ordered;
}

/**
 * Applies immutable PostgreSQL SQL migrations under a session advisory lock.
 * Each migration and its ledger entry commit atomically. A changed checksum
 * halts startup rather than silently accepting edited historical migrations.
 */
export async function runPostgresMigrations(
  pool: Pool,
  migrations: readonly PostgresMigration[]
): Promise<AppliedPostgresMigration[]> {
  const ordered = validateMigrations(migrations);
  const client = await pool.connect();
  let lockHeld = false;
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [LOCK_KEY_A, LOCK_KEY_B]);
    lockHeld = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS _omniroute_pg_migrations (
        id VARCHAR(14) PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied: AppliedPostgresMigration[] = [];
    for (const migration of ordered) {
      const digest = checksum(migration.sql);
      const existing = await client.query<{ name: string; checksum: string }>(
        "SELECT name, checksum FROM _omniroute_pg_migrations WHERE id = $1",
        [migration.id]
      );
      const row = existing.rows[0];
      if (row) {
        if (row.name !== migration.name || row.checksum !== digest) {
          throw new Error(
            `PostgreSQL migration ${migration.id} was modified after application. ` +
            "Create a new migration instead of editing an applied migration."
          );
        }
        applied.push({ id: migration.id, name: migration.name, checksum: digest });
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO _omniroute_pg_migrations (id, name, checksum) VALUES ($1, $2, $3)",
          [migration.id, migration.name, digest]
        );
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          const failure = error instanceof Error ? error : new Error(String(error));
          failure.cause ??= rollbackError;
          throw failure;
        }
        throw error;
      }
      applied.push({ id: migration.id, name: migration.name, checksum: digest });
    }
    return applied;
  } finally {
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_KEY_A, LOCK_KEY_B]);
      } finally {
        client.release();
      }
    } else {
      client.release();
    }
  }
}
