import type {
  CredentialReference,
  CredentialResolutionPort,
} from "@omniroute/contracts/credential-resolution";

let activeResolver: CredentialResolutionPort | null = null;

/**
 * Return the configured credential resolver.
 *
 * There is intentionally no implicit fallback to provider metadata or environment
 * variables here. Until the application composition root installs the storage-backed
 * adapter, attempting to resolve credentials through this port fails closed.
 */
export function getCredentialResolutionPort(): CredentialResolutionPort {
  if (!activeResolver) {
    throw new Error("Credential resolution port has not been configured");
  }
  return activeResolver;
}

/** Install the application-owned secret-storage adapter during server bootstrap. */
export function configureCredentialResolutionPort(
  resolver: CredentialResolutionPort,
): () => void {
  const previous = activeResolver;
  activeResolver = resolver;
  return () => {
    if (activeResolver === resolver) activeResolver = previous;
  };
}

/** Reset only for isolated tests and controlled process teardown. */
export function resetCredentialResolutionPort(): void {
  activeResolver = null;
}
