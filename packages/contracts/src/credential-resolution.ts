/**
 * Secret-safe credential resolution contracts.
 *
 * Credential material is only exposed inside a callback-scoped lease. It is not
 * stored as a property on the lease, provider metadata, or a serializable DTO.
 */
export type CredentialPurpose = "inference" | "validation";
export type CredentialKind = "api-key" | "oauth" | "session" | "anonymous";

export interface CredentialReference {
  readonly providerId: string;
  readonly connectionId?: string;
  readonly accountId?: string;
  /** Request-local sticky API-key identity used to preserve multi-attempt affinity. */
  readonly selectedKeyId?: string;
  readonly kind: CredentialKind;
  readonly purpose: CredentialPurpose;
}

export type CredentialMaterial =
  | { readonly kind: "api-key"; readonly value: string; readonly keyId: string }
  | {
      readonly kind: "oauth";
      readonly accessToken: string;
      readonly tokenType?: string;
      readonly refreshToken?: string;
    };

export type CredentialConsumer<T> = (credential: CredentialMaterial) => T | Promise<T>;

export interface CredentialLease {
  readonly expiresAt?: string;
  /**
   * Use credential material inside a request-scoped callback.
   * Consumers must not retain, log, persist, or serialize the supplied material.
   * Provider-specific code remains responsible for constructing upstream headers.
   */
  withCredential<T>(consumer: CredentialConsumer<T>): Promise<T>;
}

export interface CredentialResolutionPort {
  /** Return null when the connection is missing, inactive, unsupported or unusable. */
  resolve(reference: CredentialReference): Promise<CredentialLease | null>;
}
