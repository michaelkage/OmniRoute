import type { Queryable } from "./postgresTypes";

export interface KeyValueRecord {
  namespace: string;
  key: string;
  value: string;
}

/**
 * PostgreSQL implementation of OmniRoute's existing key_value data shape.
 * Values remain strings intentionally: the current SQLite contract stores
 * serialized JSON in TEXT and callers own serialization/deserialization.
 */
export interface KeyValueRepository {
  get(namespace: string, key: string, tx?: Queryable): Promise<string | null>;
  set(record: KeyValueRecord, tx?: Queryable): Promise<void>;
  delete(namespace: string, key: string, tx?: Queryable): Promise<boolean>;
  list(namespace: string, tx?: Queryable): Promise<KeyValueRecord[]>;
}

export function createPostgresKeyValueRepository(db: Queryable): KeyValueRepository {
  const executor = (tx?: Queryable) => tx ?? db;

  return {
    async get(namespace, key, tx) {
      const result = await executor(tx).query<{ value: string }>(
        "SELECT value FROM key_value WHERE namespace = $1 AND key = $2 LIMIT 1",
        [namespace, key]
      );
      return result.rows[0]?.value ?? null;
    },

    async set({ namespace, key, value }, tx) {
      await executor(tx).query(
        `INSERT INTO key_value (namespace, key, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (namespace, key)
         DO UPDATE SET value = EXCLUDED.value`,
        [namespace, key, value]
      );
    },

    async delete(namespace, key, tx) {
      const result = await executor(tx).query(
        "DELETE FROM key_value WHERE namespace = $1 AND key = $2",
        [namespace, key]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async list(namespace, tx) {
      const result = await executor(tx).query<KeyValueRecord>(
        "SELECT namespace, key, value FROM key_value WHERE namespace = $1 ORDER BY key ASC",
        [namespace]
      );
      return result.rows;
    },
  };
}
