import assert from "node:assert/strict";
import test from "node:test";
import { discoverFreeModels } from "../../src/lib/freeModelDiscovery/worker.ts";

test("free-model discovery indexes only public zero-priced OpenRouter models", async () => {
  let requestedUrl = "";
  const fetchFn = async (input: URL | RequestInfo, init?: RequestInit) => {
    requestedUrl = String(input);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({
      data: [
        {
          id: "vendor/free-model:free",
          name: "Free Model",
          context_length: 32768,
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          pricing: { prompt: "0", completion: "0" },
          supported_parameters: ["tools", "temperature"],
        },
        {
          id: "vendor/paid-model",
          name: "Paid Model",
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
        {
          id: "vendor/unverified-price",
          name: "Unknown Price",
          pricing: { prompt: "0", completion: null },
        },
        {
          id: "bad id",
          name: "Invalid ID",
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "vendor/blank-price",
          name: "Blank Price",
          pricing: { prompt: " ", completion: "0" },
        },
        null,
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const snapshot = await discoverFreeModels({
    fetchFn: fetchFn as typeof fetch,
    now: () => new Date("2026-11-22T00:00:00.000Z"),
  });

  assert.equal(requestedUrl, "https://openrouter.ai/api/v1/models");
  assert.equal(snapshot.providerCandidates.length, 1);
  assert.equal(snapshot.providerCandidates[0]?.id, "openrouter");
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0]?.id, "vendor/free-model:free");
  assert.equal(snapshot.models[0]?.requiresUserCredential, true);
  assert.equal(snapshot.models[0]?.activation, "available-after-provider-auth");
  assert.deepEqual(snapshot.models[0]?.inputModalities, ["text", "image"]);
});

test("free-model discovery rejects malformed and oversized catalogue responses", async () => {
  await assert.rejects(
    discoverFreeModels({ fetchFn: (async () => new Response("not-json")) as typeof fetch }),
    /invalid JSON/,
  );

  await assert.rejects(
    discoverFreeModels({
      fetchFn: (async () => new Response("x".repeat(12 * 1024 * 1024 + 1))) as typeof fetch,
    }),
    /size limit/,
  );
});

test("free-model discovery rejects a changed pricing schema before catalogue synchronization", async () => {
  await assert.rejects(
    discoverFreeModels({
      fetchFn: (async () => new Response(JSON.stringify({
        data: [{ id: "vendor/model", name: "Model", pricing: null }],
      }))) as typeof fetch,
    }),
    /pricing metadata failed schema validation/,
  );
});

test("free-model discovery does not accept a non-success upstream response", async () => {
  await assert.rejects(
    discoverFreeModels({ fetchFn: (async () => new Response("denied", { status: 503 })) as typeof fetch }),
    /HTTP 503/,
  );
});
