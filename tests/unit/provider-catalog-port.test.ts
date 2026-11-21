import test from "node:test";
import assert from "node:assert/strict";

import { REGISTRY } from "../../open-sse/config/providers/index.ts";
import { createProviderCatalogAdapter } from "../../open-sse/adapters/providerCatalogAdapter.ts";
import {
  configureProviderCatalog,
  getProviderCatalog,
  resetProviderCatalog,
} from "../../open-sse/services/providerCatalog.ts";

test("provider catalog projects stable provider and model metadata", () => {
  const catalog = createProviderCatalogAdapter(REGISTRY);
  const provider = catalog.getProvider("openai");

  assert.ok(provider);
  assert.equal(provider.id, "openai");
  assert.equal(provider.format, REGISTRY.openai.format);
  assert.equal(provider.executor, REGISTRY.openai.executor);
  assert.ok(provider.models.length > 0);

  const firstModel = provider.models[0];
  assert.ok(firstModel.id);
  assert.equal(catalog.getModel("openai", firstModel.id)?.id, firstModel.id);
  assert.deepEqual(catalog.listModels("openai"), provider.models);
  assert.equal(catalog.getProvider("missing-provider"), null);
  assert.equal(catalog.getModel("missing-provider", "missing-model"), null);
});

test("provider catalog does not expose credential or executable registry internals", () => {
  const catalog = createProviderCatalogAdapter(REGISTRY);
  const provider = catalog.getProvider("openai");
  assert.ok(provider);

  const serialized = JSON.stringify(provider);
  for (const forbidden of [
    "clientSecret",
    "clientId",
    "tokenUrl",
    "urlBuilder",
    "headers",
    "poolConfig",
    "oauth",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
  }
});

test("provider catalog supports composition-time adapter injection and restoration", () => {
  const original = getProviderCatalog();
  const injected = createProviderCatalogAdapter({
    fixture: {
      id: "fixture",
      alias: "fx",
      format: "openai",
      executor: "default",
      authType: "apikey",
      models: [{ id: "fixture-model", name: "Fixture Model" }],
    } as (typeof REGISTRY)[string],
  });

  const restore = configureProviderCatalog(injected);
  assert.equal(getProviderCatalog(), injected);
  assert.equal(getProviderCatalog().getProvider("fx")?.id, "fixture");
  restore();
  assert.equal(getProviderCatalog(), original);

  configureProviderCatalog(injected);
  resetProviderCatalog();
  assert.notEqual(getProviderCatalog(), injected);
});
