/**
 * Runtime-neutral provider catalog ports.
 *
 * These projections deliberately exclude credentials, OAuth secrets, request headers,
 * executable URL builders, session pools and provider implementation objects.
 */

export interface ProviderModelMetadata {
  readonly id: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly contextLength?: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly toolCalling?: boolean;
  readonly supportsReasoning?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsAudio?: boolean;
  readonly supportsVideo?: boolean;
  readonly supportsXHighEffort?: boolean;
  readonly targetFormat?: string;
  readonly unsupportedParams?: readonly string[];
  readonly supportedThinkingEfforts?: readonly string[];
  readonly requiresProviderPrefix?: boolean;
}

export interface ProviderMetadata {
  readonly id: string;
  readonly alias: string;
  readonly format: string;
  readonly executor: string;
  readonly authType: string;
  readonly passthroughModels: boolean;
  readonly models: readonly ProviderModelMetadata[];
}

export interface ProviderCatalogPort {
  /** Resolve a canonical provider ID or public alias. */
  getProvider(providerIdOrAlias: string): ProviderMetadata | null;
  /** Return provider metadata in deterministic registry order. */
  listProviders(): readonly ProviderMetadata[];
  /** Resolve a model within a provider, accepting its declared aliases. */
  getModel(providerIdOrAlias: string, modelId: string): ProviderModelMetadata | null;
  /** Return the static models declared for a provider. */
  listModels(providerIdOrAlias: string): readonly ProviderModelMetadata[];
}
