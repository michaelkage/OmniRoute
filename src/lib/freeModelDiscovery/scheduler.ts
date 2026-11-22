import { runFreeModelDiscovery } from "./worker";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
let interval: ReturnType<typeof setInterval> | null = null;
let activeRun: Promise<void> | null = null;

function configuredInterval(): number {
  const raw = Number(process.env.OMNIROUTE_FREE_MODEL_DISCOVERY_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw < 60 * 60 * 1000) return DEFAULT_INTERVAL_MS;
  return Math.min(Math.floor(raw), 24 * 60 * 60 * 1000);
}

async function runOnce(): Promise<void> {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    try {
      const { snapshot, path } = await runFreeModelDiscovery();
      console.info(
        `[FREE_MODEL_DISCOVERY] Indexed ${snapshot.models.length} free OpenRouter models at ${path}`,
      );
    } catch (error) {
      console.warn(
        "[FREE_MODEL_DISCOVERY] Discovery failed; retaining the previous catalogue:",
        error instanceof Error ? error.message : String(error),
      );
    }
  })();

  try {
    await activeRun;
  } finally {
    activeRun = null;
  }
}

/** Start one immediate discovery pass and a bounded six-hour refresh schedule. */
export function startFreeModelDiscoveryScheduler(): void {
  if (interval) return;
  if (process.env.OMNIROUTE_FREE_MODEL_DISCOVERY_ENABLED === "0") return;

  void runOnce();
  interval = setInterval(() => void runOnce(), configuredInterval());
  interval.unref?.();
}

export function stopFreeModelDiscoveryScheduler(): void {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}

export async function runFreeModelDiscoveryNow(): Promise<void> {
  await runOnce();
}
