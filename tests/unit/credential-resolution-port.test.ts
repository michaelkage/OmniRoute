import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  configureCredentialResolutionPort,
  getCredentialResolutionPort,
  resetCredentialResolutionPort,
} from "../../open-sse/services/credentialResolution.ts";
import type {
  CredentialHeaderWriter,
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

test("credential lease applies authorization without exposing a raw credential field", async () => {
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
        applyAuthorization(headers: CredentialHeaderWriter) {
          headers.set("authorization", "Bearer test-secret");
        },
      };
    },
  };

  const restore = configureCredentialResolutionPort(resolver);
  assert.equal(getCredentialResolutionPort(), resolver);

  const lease = await getCredentialResolutionPort().resolve(reference);
  const headers = new Map<string, string>();
  lease?.applyAuthorization({
    set(name, value) {
      headers.set(name.toLowerCase(), value);
    },
  });
  assert.equal(headers.get("authorization"), "Bearer test-secret");
  assert.equal("apiKey" in (lease ?? {}), false);
  assert.equal("accessToken" in (lease ?? {}), false);
  assert.equal("refreshToken" in (lease ?? {}), false);

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
