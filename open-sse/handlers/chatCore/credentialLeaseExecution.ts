import type { BaseExecutor, ExecuteInput } from "../../executors/base.ts";
import { getCredentialResolutionPort } from "../../services/credentialResolution.ts";

/**
 * Migrate the canonical OpenAI API-key execution path to callback-scoped
 * credential leases. Other providers and OAuth connections retain their
 * existing executor credential flow until their auth schemes are migrated
 * individually.
 *
 * The selected key is copied only into the request-local credentials object.
 * extraApiKeys are removed from that object so BaseExecutor does not perform
 * a second rotation after the lease has selected a health-aware key.
 */
export async function executeOpenAiWithCredentialLease(
  provider: string,
  executor: Pick<BaseExecutor, "execute">,
  input: ExecuteInput,
): ReturnType<BaseExecutor["execute"]> {
  const credentials = input.credentials;
  const connectionId =
    typeof credentials?.connectionId === "string" ? credentials.connectionId.trim() : "";

  if (
    provider !== "openai" ||
    !connectionId ||
    (typeof credentials.accessToken === "string" && credentials.accessToken.length > 0)
  ) {
    return executor.execute(input);
  }

  const resolver = getCredentialResolutionPort();
  const lease = await resolver.resolve({
    providerId: "openai",
    connectionId,
    kind: "api-key",
    purpose: "inference",
    ...(typeof credentials.providerSpecificData?.selectedKeyId === "string"
      ? { selectedKeyId: credentials.providerSpecificData.selectedKeyId }
      : {}),
  });

  // A null lease means the connection was deleted, disabled, mismatched, or
  // has no healthy key. Never fall back to a stale credential snapshot.
  if (!lease) {
    throw new Error("OpenAI credential lease unavailable for the selected connection");
  }

  return lease.withCredential(async (material) => {
    if (material.kind !== "api-key" || !material.value || !material.keyId) {
      throw new Error("OpenAI credential lease returned an incompatible credential");
    }

    const providerSpecificData = {
      ...(credentials.providerSpecificData ?? {}),
      extraApiKeys: [],
      selectedKeyId: material.keyId,
    };

    // Keep the selected identity on the request-local parent credentials so stream
    // recovery and retries retain the same key instead of rotating mid-request.
    credentials.providerSpecificData = {
      ...(credentials.providerSpecificData ?? {}),
      selectedKeyId: material.keyId,
    };

    const leasedInput: ExecuteInput = {
      ...input,
      credentials: {
        ...credentials,
        apiKey: material.value,
        accessToken: undefined,
        providerSpecificData,
      },
    };

    return executor.execute(leasedInput);
  });
}
