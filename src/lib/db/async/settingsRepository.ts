import type { Queryable } from "./postgresTypes";

export interface StoredSetting {
  namespace: "settings" | "databaseSettings";
  key: string;
  value: string;
}

export interface SettingsSnapshot {
  settings: StoredSetting[];
  revision: number;
}

export interface SettingsUpdate {
  namespace?: "settings" | "databaseSettings";
  key: string;
  /** Already serialized using the existing SQLite settings wire format. */
  value: string;
}

export class SettingsRevisionConflictError extends Error {
  readonly code = "SETTINGS_REVISION_CONFLICT" as const;

  constructor(public readonly currentRevision: number) {
    super("Settings revision mismatch");
    this.name = "SettingsRevisionConflictError";
  }
}

export const SETTINGS_REVISION_KEY = "_settingsRevision";

function parseRevision(value: unknown): number {
  if (typeof value !== "string") return 0;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
      ? parsed
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Async PostgreSQL settings persistence. This is intentionally a repository,
 * not a replacement for the synchronous SQLite settings module. Callers must
 * serialize values and perform secret encryption/decryption at the domain edge.
 */
export interface SettingsRepository {
  read(): Promise<SettingsSnapshot>;
  update(expectedRevision: number, updates: readonly SettingsUpdate[]): Promise<number>;
}

export function createPostgresSettingsRepository(db: {
  query: Queryable["query"];
  transaction<T>(callback: (tx: Queryable) => Promise<T>): Promise<T>;
}): SettingsRepository {
  return {
    async read() {
      const result = await db.query<{
        namespace: string;
        key: string;
        value: string;
      }>(
        `SELECT namespace, key, value
         FROM key_value
         WHERE namespace IN ('settings', 'databaseSettings')
         ORDER BY CASE WHEN namespace = 'databaseSettings' THEN 0 ELSE 1 END, key ASC`
      );
      const settings = result.rows
        .filter(
          (row): row is typeof row & { namespace: StoredSetting["namespace"] } =>
            row.namespace === "settings" || row.namespace === "databaseSettings"
        )
        .map((row) => ({
          namespace: row.namespace,
          key: row.key,
          value: row.value,
        }));
      const revisionRow = settings.find(
        (row) => row.namespace === "settings" && row.key === SETTINGS_REVISION_KEY
      );
      return {
        settings,
        revision: parseRevision(revisionRow?.value),
      };
    },

    async update(expectedRevision, updates) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError("expectedRevision must be a non-negative safe integer");
      }
      const normalized = updates.map((update) => ({
        namespace: update.namespace ?? "settings",
        key: update.key,
        value: update.value,
      }));
      for (const update of normalized) {
        if (!update.key || update.key === SETTINGS_REVISION_KEY) {
          throw new TypeError("Setting keys must be non-empty and cannot write the revision key");
        }
        if (typeof update.value !== "string") {
          throw new TypeError("Setting values must be serialized strings");
        }
      }

      return db.transaction(async (tx) => {
        // Ensure a stable row exists, then lock it. Every settings writer must
        // follow this protocol so revision checks serialize across instances.
        await tx.query(
          "INSERT INTO key_value (namespace, key, value) VALUES ('settings', $1, $2) ON CONFLICT (namespace, key) DO NOTHING",
          [SETTINGS_REVISION_KEY, "0"]
        );
        const locked = await tx.query<{ value: string }>(
          "SELECT value FROM key_value WHERE namespace = 'settings' AND key = $1 FOR UPDATE",
          [SETTINGS_REVISION_KEY]
        );
        const currentRevision = parseRevision(locked.rows[0]?.value);
        if (currentRevision !== expectedRevision) {
          throw new SettingsRevisionConflictError(currentRevision);
        }

        for (const update of normalized) {
          await tx.query(
            `INSERT INTO key_value (namespace, key, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (namespace, key)
             DO UPDATE SET value = EXCLUDED.value`,
            [update.namespace, update.key, update.value]
          );
        }

        const nextRevision = currentRevision + 1;
        await tx.query(
          `UPDATE key_value
           SET value = $2
           WHERE namespace = 'settings' AND key = $1`,
          [SETTINGS_REVISION_KEY, JSON.stringify(nextRevision)]
        );
        return nextRevision;
      });
    },
  };
}
