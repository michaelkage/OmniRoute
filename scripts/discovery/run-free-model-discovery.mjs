import { ensureDbReadyForBoot } from "../../src/lib/db/core.ts";
import { runFreeModelDiscovery } from "../../src/lib/freeModelDiscovery/worker.ts";

await ensureDbReadyForBoot();
const { snapshot, path } = await runFreeModelDiscovery();
process.stdout.write(
  JSON.stringify({ path, discoveredAt: snapshot.discoveredAt, providerCandidates: snapshot.providerCandidates, models: snapshot.models.length }, null, 2) + "\n",
);
