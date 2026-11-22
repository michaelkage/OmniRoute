import type {
  CredentialConsumer,
  CredentialKind,
  CredentialLease,
  CredentialMaterial,
  CredentialReference,
  CredentialResolutionPort,
} from "@omniroute/contracts/credential-resolution";

export interface StoredProviderConnection {
  readonly id: string;
  readonly provider: string;
  readonly isActive: boolean;
  readonly apiKey?: string | null;
  readonly accessToken?: string | null;
  readonly refreshToken?: string | null;
  readonly expiresAt?: string | null;
  readonly tokenExpiresAt?: string | null;
  readonly tokenType?: string | null;
  readonly providerSpecificData?: Record<string, unknown> | null;
}

export interface SelectedApiKey {
  readonly key: string;
  readonly keyId: string;
}

export interface CredentialResolverDependencies {
  loadConnection(connectionId: string): Promise<StoredProviderConnection | null>;
  selectApiKey(connection: StoredProviderConnection): SelectedApiKey | null;
  refreshOAuth?(
    connection: StoredProviderConnection,
  ): Promise<StoredProviderConnection | null>;
}

function isCredentialKind(value: CredentialKind): boolean {
  return value === "api-key" || value === "oauth";
}

function createLease(
  material: CredentialMaterial,
  expiresAt?: string | null,
): CredentialLease {
  return Object.freeze({
    ...(expiresAt ? { expiresAt } : {}),
    async withCredential<T>(consumer: CredentialConsumer<T>): Promise<T> {
      return consumer(material);
    },
  });
}

/**
 * Application-owned adapter over the existing provider-connection store.
 * Storage, decryption, key rotation and OAuth refresh are explicit dependencies;
 * the contracts package remains free of SQLite and provider-executor imports.
 */
export function createDatabaseCredentialResolver(
  dependencies: CredentialResolverDependencies,
): CredentialResolutionPort {
  return {
    async resolve(reference: CredentialReference): Promise<CredentialLease | null> {
      if (!reference.connectionId || !reference.providerId || !isCredentialKind(reference.kind)) {
        return null;
      }

      let connection = await dependencies.loadConnection(reference.connectionId);
      if (
        !connection ||
        connection.id !== reference.connectionId ||
        connection.provider !== reference.providerId ||
        connection.isActive !== true
      ) {
        return null;
      }

      if (reference.kind === "api-key") {
        const selected = dependencies.selectApiKey(connection);
        if (!selected?.key || !selected.keyId) return null;
        return createLease(
          { kind: "api-key", value: selected.key, keyId: selected.keyId },
          connection.expiresAt,
        );
      }

      if (reference.kind === "oauth") {
        const expiry = connection.expiresAt || connection.tokenExpiresAt || undefined;
        if (!connection.accessToken || !expiry || Date.parse(expiry) <= Date.now()) {
          if (!dependencies.refreshOAuth) return null;
          connection = (await dependencies.refreshOAuth(connection)) ?? null;
          if (
            !connection ||
            connection.provider !== reference.providerId ||
            connection.id !== reference.connectionId ||
            connection.isActive !== true
          ) {
            return null;
          }
        }

        if (!connection.accessToken) return null;
        return createLease(
          {
            kind: "oauth",
            accessToken: connection.accessToken,
            ...(connection.tokenType ? { tokenType: connection.tokenType } : {}),
            ...(connection.refreshToken ? { refreshToken: connection.refreshToken } : {}),
          },
          connection.expiresAt || connection.tokenExpiresAt,
        );
      }

      return null;
    },
  };
}
