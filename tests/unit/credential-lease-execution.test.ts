import assert from "node:assert/strict";
import test from "node:test";
import type { BaseExecutor, ExecuteInput } from "../../open-sse/executors/base.ts";
import { DefaultExecutor } from "../../open-sse/executors/default.ts";
import {
  configureCredentialResolutionPort,
  resetCredentialResolutionPort,
} from "../../open-sse/services/credentialResolution.ts";
import { executeOpenAiWithCredentialLease } from "../../open-sse/handlers/chatCore/credentialLeaseExecution.ts";

test("OpenAI API-key execution consumes a callback-scoped lease and preserves selected-key affinity", async () => {
  let received: ExecuteInput | null = null;
  let requestedKeyId: string | undefined;
  const restore = configureCredentialResolutionPort({
    async resolve(reference) {
      requestedKeyId = reference.selectedKeyId;
      return {
        async withCredential(consumer) {
          return consumer({ kind: "api-key", value: "leased-secret", keyId: "extra_1" });
        },
      };
    },
  });

  try {
    const input = {
      model: "gpt-test",
      body: { model: "gpt-test" },
      stream: false,
      credentials: {
        connectionId: "connection-1",
        apiKey: "stale-secret",
        providerSpecificData: {
          selectedKeyId: "extra_0",
          extraApiKeys: ["old-secret"],
        },
      },
    } as unknown as ExecuteInput;
    const expected = { response: new Response("ok") };
    const executor = {
      getProvider() { return "openai"; },
      async execute(next: ExecuteInput) {
        received = next;
        return expected;
      },
    } as unknown as BaseExecutor;

    const result = await executeOpenAiWithCredentialLease("openai", executor, input);

    assert.equal(result, expected);
    assert.ok(received);
    assert.equal(requestedKeyId, "extra_0");
    assert.equal(received?.credentials.apiKey, "leased-secret");
    const defaultExecutor = new DefaultExecutor("openai");
    const upstreamHeaders = defaultExecutor.buildHeaders(received.credentials, false);
    assert.equal(upstreamHeaders.Authorization, "Bearer leased-secret");
    assert.equal(received.credentials.providerSpecificData?.selectedKeyId, "extra_1");
    assert.deepEqual(received?.credentials.providerSpecificData?.extraApiKeys, []);
    assert.equal(input.credentials.providerSpecificData?.selectedKeyId, "extra_1");
    assert.deepEqual(input.credentials.providerSpecificData?.extraApiKeys, ["old-secret"]);
    assert.equal(input.credentials.apiKey, "stale-secret");
  } finally {
    restore();
    resetCredentialResolutionPort();
  }
});

test("non-OpenAI executors retain their original credential path", async () => {
  resetCredentialResolutionPort();
  const input = {
    model: "claude-test",
    body: {},
    stream: false,
    credentials: { connectionId: "connection-1", apiKey: "provider-key" },
  } as unknown as ExecuteInput;
  let received: ExecuteInput | null = null;
  const executor = {
    async execute(next: ExecuteInput) {
      received = next;
      return { response: new Response("ok") };
    },
  } as unknown as BaseExecutor;

  await executeOpenAiWithCredentialLease("anthropic", executor, input);
  assert.equal(received, input);
});

test("strict validation dispatch keeps the existing credential guard and bypasses inference leases", async () => {
  resetCredentialResolutionPort();
  const input = {
    model: "gpt-test",
    body: {},
    stream: false,
    credentials: {
      connectionId: "connection-1",
      apiKey: "validation-key",
      providerSpecificData: { extraApiKeys: ["secondary-key"] },
    },
    validationDispatch: { reject() { throw new Error("validation fence"); } },
  } as unknown as ExecuteInput;
  let received: ExecuteInput | null = null;
  const executor = {
    getProvider() { return "openai"; },
    async execute(next: ExecuteInput) {
      received = next;
      return { response: new Response("ok") };
    },
  } as unknown as BaseExecutor;

  await executeOpenAiWithCredentialLease("openai", executor, input);
  assert.equal(received, input);
});

test("OpenAI provider proxy executors keep their dedicated authentication wrappers", async () => {
  const restore = configureCredentialResolutionPort({
    async resolve() {
      throw new Error("proxy executor must not request an OpenAI key lease");
    },
  });
  const input = {
    model: "gpt-test",
    body: {},
    stream: false,
    credentials: { connectionId: "connection-1", apiKey: "native-openai-key" },
  } as unknown as ExecuteInput;
  let received: ExecuteInput | null = null;
  const executor = {
    getProvider() { return "cliproxyapi"; },
    async execute(next: ExecuteInput) {
      received = next;
      return { response: new Response("ok") };
    },
  } as unknown as BaseExecutor;

  try {
    await executeOpenAiWithCredentialLease("openai", executor, input);
    assert.equal(received, input);
  } finally {
    restore();
    resetCredentialResolutionPort();
  }
});
