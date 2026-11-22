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
  readonly proxyEnabled?: boolean;
  readonly projectId?: string | null;
  readonly providerSpecificData?: Record<string, unknown> | null;
}

export interface SelectedApiKey {
  readonly key: string;
  readonly keyId: string;
}

export interface CredentialResolverDependencies {
  loadConnection(connectionId: string): Promise<StoredProviderConnection | null>;
  selectApiKey(
    connection: StoredProviderConnection,
    reference: CredentialReference,
  ): SelectedApiKey | null | Promise<SelectedApiKey | null>;
  shouldRefreshOAuth?(
    connection: StoredProviderConnection,
  ): boolean | Promise<boolean>;
  refreshOAuth?(
    connection: StoredProviderConnection,
  ): Promise<StoredProviderConnection | null>;
}

function isCredentialKind(value: CredentialKind): boolean {
  return value === "api-key" || value === "oauth";
}

function isExpiryDue(value: string): boolean {
  const trimmed = value.trim();
  const numeric = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : null;
  const expiryMs =
    numeric !== null
      ? numeric > 0 && numeric < 1e12
        ? numeric * 1000
        : numeric
      : Date.parse(trimmed);
  return !Number.isFinite(expiryMs) || expiryMs <= Date.now();
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
        const selected = await dependencies.selectApiKey(connection, reference);
        if (!selected?.key || !selected.keyId) return null;
        return createLease(
          { kind: "api-key", value: selected.key, keyId: selected.keyId },
          connection.expiresAt,
        );
      }

      if (reference.kind === "oauth") {
        const expiry = connection.expiresAt || connection.tokenExpiresAt || undefined;
        const shouldRefresh = !connection.accessToken || (
          !!expiry &&
          (dependencies.shouldRefreshOAuth
            ? await dependencies.shouldRefreshOAuth(connection)
            : isExpiryDue(expiry))
        );
        if (shouldRefresh) {
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


export interface ProductionCredentialResolverOptions {
  /**
   * Resolve the configured proxy through OmniRoute's existing scope cascade.
   * A null result is a legitimate direct-egress configuration; resolver errors
   * propagate and prevent an unsafe direct retry.
   */
  resolveProxy?(connection: StoredProviderConnection): Promise<unknown>;
  logger?: {
    info?(category: string, message: string, metadata?: Record<string, unknown>): void;
    warn?(category: string, message: string, metadata?: Record<string, unknown>): void;
    error?(category: string, message: string, metadata?: Record<string, unknown>): void;
  };
}

/**
 * Build the SQLite-backed production adapter using OmniRoute's existing
 * lazy-decrypting connection store, per-key health/rotation, and serialized
 * OAuth refresh + compare-and-swap persistence.
 */
export function createProductionCredentialResolver(
  options: ProductionCredentialResolverOptions,
): CredentialResolutionPort {
  return createDatabaseCredentialResolver({
    async loadConnection(connectionId) {
      const { getProviderConnectionById } = await import("@/lib/db/providers");
      return (await getProviderConnectionById(connectionId)) as StoredProviderConnection | null;
    },

    async selectApiKey(connection, reference) {
      const providerData = connection.providerSpecificData ?? {};
      const health =
        providerData.apiKeyHealth && typeof providerData.apiKeyHealth === "object"
          ? (providerData.apiKeyHealth as Record<
              string,
              import("../../../open-sse/services/apiKeyRotator.ts").KeyHealth
            >)
          : undefined;
      const extras = Array.isArray(providerData.extraApiKeys)
        ? providerData.extraApiKeys.filter(
            (key): key is string => typeof key === "string" && key.trim().length > 0,
          )
        : [];
      const primary = typeof connection.apiKey === "string" ? connection.apiKey : "";
      if (!primary && extras.length === 0) return null;

      const { getValidApiKey, resolveKeyForRequest, syncHealthFromDB } = await import(
        "../../../open-sse/services/apiKeyRotator.ts"
      );
      syncHealthFromDB(connection.id, health);
      return reference.selectedKeyId
        ? resolveKeyForRequest(connection.id, primary, extras, reference.selectedKeyId)
        : getValidApiKey(connection.id, primary, extras, health);
    },

    async shouldRefreshOAuth(connection) {
      const { getRefreshLeadMs } = await import("../../../open-sse/services/tokenRefresh.ts");
      const { parseTokenExpiryMs } = await import("@/lib/tokenHealthCheckExpiry");
      const expiryValue = connection.expiresAt || connection.tokenExpiresAt;
      if (!expiryValue) return false;
      const expiryMs = parseTokenExpiryMs(expiryValue);
      if (!Number.isFinite(expiryMs) || expiryMs <= 0) return true;
      const leadMs = getRefreshLeadMs(connection.provider, connection.providerSpecificData);
      return expiryMs <= Date.now() + leadMs;
    },

    async refreshOAuth(connection) {
      const { getAccessToken } = await import("../../../open-sse/services/tokenRefresh.ts");
      if (!connection.refreshToken) return null;

      let proxy: unknown = null;
      if (connection.proxyEnabled === true) {
        if (!options.resolveProxy) {
          options.logger?.error?.(
            "CREDENTIAL_RESOLUTION",
            "OAuth refresh blocked because no proxy resolver is installed",
            { provider: connection.provider, connectionId: connection.id },
          );
          return null;
        }
        proxy = await options.resolveProxy(connection);
        // A null proxy is a valid result from OmniRoute's resolver: it means
        // the global proxy switch is off, the connection explicitly bypasses
        // proxies, or no proxy is configured at any applicable scope. Resolution
        // errors still propagate, so a broken proxy lookup never silently falls
        // back to direct egress.
      }

      const refreshed = await getAccessToken(
        connection.provider,
        {
          connectionId: connection.id,
          accessToken: connection.accessToken ?? null,
          refreshToken: connection.refreshToken,
          expiresAt: connection.expiresAt ?? connection.tokenExpiresAt ?? null,
          providerSpecificData: connection.providerSpecificData ?? {},
          projectId: connection.projectId ?? undefined,
        },
        options.logger,
        proxy,
        async (result: Record<string, unknown>) => {
          const { updateProviderConnection } = await import("@/lib/db/providers");
          const persisted = await updateProviderConnection(connection.id, result);
          if (!persisted) {
            throw new Error("OAuth token rotation was not persisted for the connection");
          }
        },
      );

      if (!refreshed || typeof refreshed !== "object" || !("accessToken" in refreshed)) {
        return null;
      }

      const { getProviderConnectionById } = await import("@/lib/db/providers");
      return (await getProviderConnectionById(connection.id)) as StoredProviderConnection | null;
    },
  });
}
