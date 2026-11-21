/**
 * Secret-safe credential resolution contracts.
 *
 * Credentials are never part of provider metadata or serializable contract objects.
 * Implementations keep secret material in a closure-backed lease and expose only
 * an operation that applies authorization to a request-local header sink.
 */

export type CredentialPurpose = "inference" | "validation";

export type CredentialKind = "api-key" | "oauth" | "session" | "anonymous";

export interface CredentialReference {
  /** Canonical provider ID, never a display label or user-supplied URL. */
  readonly providerId: string;
  /** Persisted connection identifier. Omit only for anonymous credentials. */
  readonly connectionId?: string;
  /** Optional account selector for multi-account providers. */
  readonly accountId?: string;
  readonly kind: CredentialKind;
  readonly purpose: CredentialPurpose;
}

export interface CredentialHeaderWriter {
  /** Set or replace one outbound request header. */
  set(name: string, value: string): void;
}

export interface CredentialLease {
  /** Optional expiry metadata; never contains credential material. */
  readonly expiresAt?: string;
  /**
   * Apply authorization to a request-local header writer.
   *
   * Implementations must not return, log, persist, or attach secret material to
   * the writer object. Callers must not serialize the resulting request headers.
   */
  applyAuthorization(headers: CredentialHeaderWriter): void;
}

export interface CredentialResolutionPort {
  /**
   * Resolve an active credential lease for this request. Implementations own
   * storage access, OAuth refresh coordination, API-key rotation and secret
   * decryption. Return null when no usable credential exists.
   */
  resolve(reference: CredentialReference): Promise<CredentialLease | null>;
}
