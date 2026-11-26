/**
 * Versioned, JSON-safe provider metadata contract.
 *
 * This contract intentionally excludes executable functions, credentials, OAuth
 * secrets, dynamic URL builders, request headers, and session-pool internals.
 */

export type ProviderPluginCapability =
  | "apikey"
  | "custom-executor"
  | "free-tier"
  | "oauth"
  | "passthrough-models"
  | "responses"
  | "sidecar-candidate"
  | "usage-fetch"
  | "usage-supported";

export interface ProviderPluginModel {
  id: string;
  name: string;
  contextLength?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  supportsVideo?: boolean;
  unsupportedParams?: readonly string[];
  targetFormat?: string;
}

export interface ProviderPluginManifestEntry {
  id: string;
  alias?: string;
  format: string;
  executor: string;
  auth: {
    type: string;
    header: string;
    prefix?: string;
  };
  endpoints: {
    baseUrl?: string;
    baseUrls?: string[];
    responsesBaseUrl?: string;
    chatPath?: string;
    modelsUrl?: string;
  };
  capabilities: ProviderPluginCapability[];
  passthroughModels: boolean;
  defaultContextLength?: number;
  timeoutMs?: number;
  models: ProviderPluginModel[];
  sidecar: {
    eligible: boolean;
    reasons: string[];
  };
}

export interface ProviderPluginManifest {
  schemaVersion: 1;
  generatedFrom: "open-sse/config/providers";
  providers: ProviderPluginManifestEntry[];
}
