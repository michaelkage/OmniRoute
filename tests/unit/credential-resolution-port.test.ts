import { afterEach, describe, expect, it } from "vitest";
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

describe("credential resolution port", () => {
  it("fails closed until an application adapter is configured", () => {
    expect(() => getCredentialResolutionPort()).toThrow(
      "Credential resolution port has not been configured",
    );
  });

  it("installs and restores an application-owned resolver", async () => {
    const reference: CredentialReference = {
      providerId: "openai",
      connectionId: "connection-1",
      kind: "api-key",
      purpose: "inference",
    };
    const resolver: CredentialResolutionPort = {
      async resolve(received) {
        expect(received).toEqual(reference);
        return {
          applyAuthorization(headers: CredentialHeaderWriter) {
            headers.set("authorization", "Bearer test-secret");
          },
        };
      },
    };

    const restore = configureCredentialResolutionPort(resolver);
    expect(getCredentialResolutionPort()).toBe(resolver);

    const lease = await getCredentialResolutionPort().resolve(reference);
    const headers = new Map<string, string>();
    lease?.applyAuthorization({
      set(name, value) {
        headers.set(name.toLowerCase(), value);
      },
    });
    expect(headers.get("authorization")).toBe("Bearer test-secret");

    restore();
    expect(() => getCredentialResolutionPort()).toThrow(
      "Credential resolution port has not been configured",
    );
  });

  it("does not overwrite a newer resolver when an older restore callback runs", () => {
    const first: CredentialResolutionPort = { resolve: async () => null };
    const second: CredentialResolutionPort = { resolve: async () => null };
    const restoreFirst = configureCredentialResolutionPort(first);
    configureCredentialResolutionPort(second);

    restoreFirst();

    expect(getCredentialResolutionPort()).toBe(second);
  });

  it("allows a configured resolver to report a missing credential without fabricating one", async () => {
    const resolver: CredentialResolutionPort = { resolve: async () => null };
    configureCredentialResolutionPort(resolver);

    await expect(
      getCredentialResolutionPort().resolve({
        providerId: "openai",
        connectionId: "missing",
        kind: "api-key",
        purpose: "inference",
      }),
    ).resolves.toBeNull();
  });
});
