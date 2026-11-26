import type {
  AsyncDatabase,
  Pool,
  PoolClient,
  Queryable,
  TransactionIsolation,
  TransactionOptions,
} from "./postgresTypes";

const RETRYABLE_SQL_STATES = new Set(["40001", "40P01"]);
const MAX_TRANSACTION_RETRIES = 3;
const ISOLATION_LEVELS = new Set<TransactionIsolation>([
  "read committed",
  "repeatable read",
  "serializable",
]);

type PgError = Error & { code?: string };

function retryCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TRANSACTION_RETRIES) {
    throw new RangeError(`Transaction retries must be an integer between 0 and ${MAX_TRANSACTION_RETRIES}`);
  }
  return value;
}

function transactionBeginSql(options: TransactionOptions): string {
  const isolation = options.isolation ?? "read committed";
  if (!ISOLATION_LEVELS.has(isolation)) {
    throw new TypeError("Unsupported PostgreSQL transaction isolation level");
  }
  if (options.deferrable && (isolation !== "serializable" || !options.readOnly)) {
    throw new TypeError("DEFERRABLE requires a SERIALIZABLE READ ONLY transaction");
  }
  return [
    "BEGIN",
    `ISOLATION LEVEL ${isolation.toUpperCase()}`,
    options.readOnly ? "READ ONLY" : "READ WRITE",
    options.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE",
  ].join(" ");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function isRetryable(error: unknown): boolean {
  return RETRYABLE_SQL_STATES.has((error as PgError | null)?.code ?? "");
}

/**
 * Async PostgreSQL transaction/repository boundary.
 *
 * Retry callbacks must contain database work only. Never perform network calls,
 * send messages, write files, or mutate external state inside a retryable
 * transaction because PostgreSQL may execute the callback more than once.
 */
export function createPostgresDatabase(pool: Pool): AsyncDatabase {
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error("PostgreSQL database has been closed");
  }

  async function query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ) {
    assertOpen();
    return pool.query<Row>(text, values);
  }

  async function transaction<T>(
    callback: (tx: Queryable) => Promise<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    assertOpen();
    if (typeof callback !== "function") throw new TypeError("Transaction callback is required");

    const retries = retryCount(options.retries);
    const beginSql = transactionBeginSql(options);

    for (let attempt = 0; ; attempt += 1) {
      let client: PoolClient | undefined;
      let began = false;
      let destroyClient = false;
      try {
        client = await pool.connect();
        await client.query(beginSql);
        began = true;
        const result = await callback(client);
        await client.query("COMMIT");
        began = false;
        return result;
      } catch (error) {
        const original = asError(error);
        if (client && began) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            destroyClient = true;
            original.cause ??= asError(rollbackError);
          }
        }
        if (attempt < retries && isRetryable(error) && !destroyClient) {
          // Small bounded exponential delay with deterministic cap.
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25 * 2 ** attempt, 200)));
          continue;
        }
        throw original;
      } finally {
        client?.release(destroyClient);
      }
    }
  }

  return {
    query,
    transaction,
    async healthCheck() {
      const started = performance.now();
      try {
        await query("SELECT 1 AS healthy");
        return { healthy: true, latencyMs: Math.max(0, performance.now() - started) };
      } catch {
        return { healthy: false, latencyMs: Math.max(0, performance.now() - started) };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
