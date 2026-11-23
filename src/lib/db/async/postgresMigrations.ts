import type { PostgresMigration } from "./postgresMigrationRunner";

/**
 * Initial PostgreSQL-owned schema. This is intentionally a small foundation,
 * not a claim that the full SQLite schema has been migrated.
 */
export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  {
    id: "001",
    name: "key_value",
    sql: `
      CREATE TABLE IF NOT EXISTS key_value (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_key_value_namespace
        ON key_value (namespace);
    `,
  },
];
