import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-free-model-reconcile-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET ||= "free-model-reconcile-test-secret";

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");

test.beforeEach(() => {
  core.resetDbInstance();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const discovered = (id: string, name = id, supportsVision = false) => ({
  id,
  name,
  source: "free-model-discovery" as const,
  apiFormat: "chat-completions",
  supportedEndpoints: ["chat"],
  supportsVision,
  isFree: true as const,
});

test("free-model reconciliation preserves operator-owned rows and wins ID collisions", async () => {
  await modelsDb.addCustomModel(
    "openrouter",
    "operator/private-model",
    "Operator Private Model",
    "manual",
  );

  const result = modelsDb.syncDiscoveredCustomModels("openrouter", [
    discovered("vendor/free-model", "Free Model"),
    discovered("operator/private-model", "Discovered Collision"),
  ]);

  assert.equal(result.changed, true);
  const rows = await modelsDb.getCustomModels("openrouter");
  assert.deepEqual(
    rows.map((model: { id: string }) => model.id),
    ["operator/private-model", "vendor/free-model"],
  );
  assert.equal(rows[0].name, "Operator Private Model");
  assert.equal(rows[0].source, "manual");
  assert.equal(rows[1].source, "free-model-discovery");
  assert.equal(rows[1].isFree, true);
});

test("free-model reconciliation removes stale managed rows but retains operator rows", async () => {
  await modelsDb.addCustomModel(
    "openrouter",
    "operator/private-model",
    "Operator Private Model",
    "manual",
  );
  modelsDb.syncDiscoveredCustomModels("openrouter", [
    discovered("vendor/stale-model", "Stale Model"),
  ]);

  const result = modelsDb.syncDiscoveredCustomModels("openrouter", []);
  assert.equal(result.changed, true);
  assert.deepEqual(
    (await modelsDb.getCustomModels("openrouter")).map((model: { id: string }) => model.id),
    ["operator/private-model"],
  );
});

test("free-model reconciliation is idempotent and refreshes discovered metadata", async () => {
  const first = modelsDb.syncDiscoveredCustomModels("openrouter", [
    discovered("vendor/vision-model", "Vision Model", false),
  ]);
  assert.equal(first.changed, true);

  const repeated = modelsDb.syncDiscoveredCustomModels("openrouter", [
    discovered("vendor/vision-model", "Vision Model", false),
  ]);
  assert.equal(repeated.changed, false);

  const refreshed = modelsDb.syncDiscoveredCustomModels("openrouter", [
    discovered("vendor/vision-model", "Vision Model v2", true),
  ]);
  assert.equal(refreshed.changed, true);
  const [model] = await modelsDb.getCustomModels("openrouter");
  assert.equal(model.name, "Vision Model v2");
  assert.equal(model.supportsVision, true);
});

test("free-model reconciliation fails closed on malformed persisted catalogues", () => {
  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('customModels', ?, ?)",
  ).run("openrouter", "{malformed-json");

  assert.throws(
    () => modelsDb.syncDiscoveredCustomModels("openrouter", [discovered("vendor/model")]),
    /stored custom-model JSON is malformed/,
  );
  assert.equal(
    db.prepare("SELECT value FROM key_value WHERE namespace = 'customModels' AND key = ?")
      .get("openrouter").value,
    "{malformed-json",
  );
});
