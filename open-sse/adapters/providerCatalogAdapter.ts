import type {
  ProviderCatalogPort,
  ProviderMetadata,
  ProviderModelMetadata,
} from "@omniroute/contracts/provider-catalog";
import type { RegistryEntry, RegistryModel } from "../config/providers/shared.ts";

type ProviderRegistry = Readonly<Record<string, RegistryEntry>>;

function projectModel(model: RegistryModel): ProviderModelMetadata {
  return {
    id: model.id,
    name: model.name,
    ...(model.aliases ? { aliases: model.aliases } : {}),
    ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
    ...(model.maxInputTokens !== undefined ? { maxInputTokens: model.maxInputTokens } : {}),
    ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(model.toolCalling !== undefined ? { toolCalling: model.toolCalling } : {}),
    ...(model.supportsReasoning !== undefined ? { supportsReasoning: model.supportsReasoning } : {}),
    ...(model.supportsVision !== undefined ? { supportsVision: model.supportsVision } : {}),
    ...(model.supportsAudio !== undefined ? { supportsAudio: model.supportsAudio } : {}),
    ...(model.supportsVideo !== undefined ? { supportsVideo: model.supportsVideo } : {}),
    ...(model.supportsXHighEffort !== undefined ? { supportsXHighEffort: model.supportsXHighEffort } : {}),
    ...(model.targetFormat !== undefined ? { targetFormat: model.targetFormat } : {}),
    ...(model.unsupportedParams ? { unsupportedParams: model.unsupportedParams } : {}),
    ...(model.supportedThinkingEfforts ? { supportedThinkingEfforts: model.supportedThinkingEfforts } : {}),
    ...(model.requiresProviderPrefix !== undefined ? { requiresProviderPrefix: model.requiresProviderPrefix } : {}),
  };
}

function projectProvider(id: string, entry: RegistryEntry): ProviderMetadata {
  return {
    id: entry.id || id,
    alias: entry.alias || entry.id || id,
    format: entry.format,
    executor: entry.executor,
    authType: entry.authType,
    passthroughModels: entry.passthroughModels === true,
    models: (entry.models ?? []).map(projectModel),
  };
}

/** Adapt the existing implementation registry to the runtime-neutral catalog port. */
export function createProviderCatalogAdapter(registry: ProviderRegistry): ProviderCatalogPort {
  const providers = Object.entries(registry).map(([id, entry]) => projectProvider(id, entry));
  const byId = new Map<string, ProviderMetadata>();
  const byAlias = new Map<string, ProviderMetadata>();

  for (const provider of providers) {
    byId.set(provider.id, provider);
    byAlias.set(provider.alias, provider);
  }

  const resolve = (idOrAlias: string) => byId.get(idOrAlias) ?? byAlias.get(idOrAlias) ?? null;

  return Object.freeze({
    getProvider: resolve,
    listProviders: () => providers,
    getModel: (providerIdOrAlias: string, modelId: string) => {
      const provider = resolve(providerIdOrAlias);
      if (!provider) return null;
      return provider.models.find(
        (model) => model.id === modelId || model.aliases?.includes(modelId),
      ) ?? null;
    },
    listModels: (providerIdOrAlias: string) => resolve(providerIdOrAlias)?.models ?? [],
  });
}
