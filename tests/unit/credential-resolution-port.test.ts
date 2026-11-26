import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  configureCredentialResolutionPort,
  getCredentialResolutionPort,
  resetCredentialResolutionPort,
} from "../../open-sse/services/credentialResolution.ts";
import type {
  CredentialReference,
  CredentialResolutionPort,
} from "@omniroute/contracts/credential-resolution";

afterEach(() => {
  resetCredentialResolutionPort();
});

test("credential resolution fails closed until an application adapter is configured", () => {
  assert.throws(
    () => getCredentialResolutionPort(),
    /Credential resolution port has not been configured/,
  );
});

test("credential lease exposes material only through its scoped callback", async () => {
  const reference: CredentialReference = {
    providerId: "openai",
    connectionId: "connection-1",
    kind: "api-key",
    purpose: "inference",
  };
  const resolver: CredentialResolutionPort = {
    async resolve(received) {
      assert.deepEqual(received, reference);
      return {
        async withCredential(consumer) {
          return consumer({ kind: "api-key", value: "test-secret", keyId: "primary" });
        },
      };
    },
  };

  const restore = configureCredentialResolutionPort(resolver);
  assert.equal(getCredentialResolutionPort(), resolver);

  const lease = await getCredentialResolutionPort().resolve(reference);
  assert.ok(lease);
  assert.equal("value" in lease, false);
  assert.equal("apiKey" in lease, false);
  const material = await lease.withCredential((credential) => credential);
  assert.deepEqual(material, {
    kind: "api-key",
    value: "test-secret",
    keyId: "primary",
  });

  restore();
  assert.throws(
    () => getCredentialResolutionPort(),
    /Credential resolution port has not been configured/,
  );
});

test("an older restore callback cannot replace a newer resolver", () => {
  const first: CredentialResolutionPort = { resolve: async () => null };
  const second: CredentialResolutionPort = { resolve: async () => null };
  const restoreFirst = configureCredentialResolutionPort(first);
  configureCredentialResolutionPort(second);

  restoreFirst();

  assert.equal(getCredentialResolutionPort(), second);
});

test("a configured resolver can report a missing credential without fabricating one", async () => {
  const resolver: CredentialResolutionPort = { resolve: async () => null };
  configureCredentialResolutionPort(resolver);

  assert.equal(
    await getCredentialResolutionPort().resolve({
      providerId: "openai",
      connectionId: "missing",
      kind: "api-key",
      purpose: "inference",
    }),
    null,
  );
});
