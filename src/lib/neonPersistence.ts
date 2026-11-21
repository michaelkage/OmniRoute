import { spawn } from "node:child_process";
import path from "node:path";

const REQUESTED = process.env.OMNIROUTE_NEON_PERSISTENCE === "1";
const ENABLED = REQUESTED && Boolean(process.env.DATABASE_URL?.trim());
const parsedInterval = Number(process.env.OMNIROUTE_NEON_SNAPSHOT_INTERVAL_MS || 300_000);
const INTERVAL_MS = Number.isFinite(parsedInterval) && parsedInterval > 0
  ? Math.max(60_000, Math.floor(parsedInterval))
  : 300_000;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
let stopped = false;

type RuntimePaths = { dataDir: string; sqliteFile: string } | null;

async function getRuntimePaths(): Promise<RuntimePaths> {
  // Use OmniRoute's canonical path resolver instead of duplicating DATA_DIR,
  // XDG, Windows and legacy-directory behavior in this integration.
  const { DATA_DIR, SQLITE_FILE, isCloud } = await import("@/lib/db/core");
  if (isCloud || !SQLITE_FILE) return null;
  return { dataDir: DATA_DIR, sqliteFile: SQLITE_FILE };
}

function helperPath(): string {
  const root = process.env.OMNIROUTE_PACKAGE_ROOT || process.cwd();
  return path.resolve(root, "scripts", "neon", "persistence.mjs");
}

function run(command: "restore" | "snapshot"): Promise<void> {
  return new Promise((resolve, reject) => {
    void getRuntimePaths().then((runtimePaths) => {
      if (!runtimePaths) {
        resolve();
        return;
      }

      const child = spawn(process.execPath, [helperPath(), command], {
        env: {
          ...process.env,
          DATA_DIR: runtimePaths.dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer): string =>
        (current + chunk.toString("utf8")).slice(-64 * 1024);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error("Neon " + command + " timed out after " + COMMAND_TIMEOUT_MS + "ms"));
      }, COMMAND_TIMEOUT_MS);
      timeout.unref?.();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          if (stdout.trim()) console.log(stdout.trim());
          resolve();
          return;
        }
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              "Neon " + command + " helper exited with " + (signal || code)
          )
        );
      });
    }).catch(reject);
  });
}

function assertConfiguration(): void {
  if (REQUESTED && !process.env.DATABASE_URL?.trim()) {
    throw new Error("OMNIROUTE_NEON_PERSISTENCE=1 requires DATABASE_URL.");
  }
}

export function isNeonPersistenceEnabled(): boolean {
  return ENABLED;
}

export async function restoreNeonPersistenceIfNeeded(): Promise<boolean> {
  assertConfiguration();
  if (!ENABLED) return false;
  await run("restore");
  return true;
}

async function snapshotOnce(): Promise<void> {
  if (!ENABLED || stopped) return;
  if (inFlight) return inFlight;
  inFlight = run("snapshot");
  try {
    await inFlight;
  } finally {
    inFlight = undefined;
  }
}

export function startNeonPersistence(): boolean {
  assertConfiguration();
  if (!ENABLED || timer || stopped) return false;

  timer = setInterval(() => {
    void snapshotOnce().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[NEON] scheduled snapshot failed (non-fatal): " + message);
    });
  }, INTERVAL_MS);
  timer.unref?.();

  void snapshotOnce().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[NEON] initial snapshot failed (non-fatal): " + message);
  });

  console.log("[NEON] SQLite recovery snapshots enabled; interval " + INTERVAL_MS + "ms");
  return true;
}

export async function stopNeonPersistence(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  stopped = true;
  if (!ENABLED) return;

  // Wait for an active scheduled snapshot before the final one, so shutdown
  // cannot race a second upload against retention pruning.
  if (inFlight) {
    try {
      await inFlight;
    } catch {
      // The final attempt below remains useful and reports its own failure.
    }
    inFlight = undefined;
  }

  try {
    await run("snapshot");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[NEON] final snapshot failed: " + message);
  }
}
