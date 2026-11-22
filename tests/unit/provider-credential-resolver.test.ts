import assert from "node:assert/strict";
import test from "node:test";
import {
  createDatabaseCredentialResolver,
  type StoredProviderConnection,
} from "../../src/lib/credentials/providerCredentialResolver.ts";

function connection(
  overrides: Partial<StoredProviderConnection> = {},
): StoredProviderConnection {
  return {
    id: "connection-1",
    provider: "openai",
    isActive: true,
    apiKey: "stored-api-key",
    accessToken: "stored-access-token",
    refreshToken: "stored-refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    providerSpecificData: {},
    ...overrides,
  };
}

test("API-key resolution delegates key selection and keeps material off the lease object", async () => {
  const stored = connection();
  const resolver = createDatabaseCredentialResolver({
    loadConnection: async () => stored,
    selectApiKey: () => ({ key: "rotated-key", keyId: "extra_0" }),
  });

  const lease = await resolver.resolve({
    providerId: "openai",
    connectionId: "connection-1",
    kind: "api-key",
    purpose: "inference",
  });

  assert.ok(lease);
  assert.equal("value" in lease, false);
  assert.equal("apiKey" in lease, false);
  const material = await lease.withCredential((credential) => credential);
  assert.deepEqual(material, {
    kind: "api-key",
    value: "rotated-key",
    keyId: "extra_0",
  });
});

test("OAuth resolution refreshes expired credentials and returns the persisted connection", async () => {
  const expired = connection({
    accessToken: "expired-token",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const refreshed = connection({
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  let refreshCalls = 0;
  const resolver = createDatabaseCredentialResolver({
    loadConnection: async () => expired,
    selectApiKey: () => null,
    refreshOAuth: async () => {
      refreshCalls++;
      return refreshed;
    },
  });

  const lease = await resolver.resolve({
    providerId: "openai",
    connectionId: "connection-1",
    kind: "oauth",
    purpose: "inference",
  });

  assert.equal(refreshCalls, 1);
  assert.ok(lease);
  assert.equal(
    await lease.withCredential((credential) =>
      credential.kind === "oauth" ? credential.accessToken : null,
    ),
    "new-access-token",
  );
});

test("resolver rejects inactive, mismatched and missing connections", async () => {
  for (const stored of [
    null,
    connection({ isActive: false }),
    connection({ provider: "anthropic" }),
  ]) {
    const resolver = createDatabaseCredentialResolver({
      loadConnection: async () => stored,
      selectApiKey: () => ({ key: "key", keyId: "primary" }),
    });
    assert.equal(
      await resolver.resolve({
        providerId: "openai",
        connectionId: "connection-1",
        kind: "api-key",
        purpose: "inference",
      }),
      null,
    );
  }
});

test("expired OAuth fails closed when no refresh adapter is supplied", async () => {
  const resolver = createDatabaseCredentialResolver({
    loadConnection: async () =>
      connection({
        accessToken: "expired-token",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    selectApiKey: () => null,
  });

  assert.equal(
    await resolver.resolve({
      providerId: "openai",
      connectionId: "connection-1",
      kind: "oauth",
      purpose: "inference",
    }),
    null,
  );
});
