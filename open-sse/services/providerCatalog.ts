import type { ProviderCatalogPort } from "@omniroute/contracts/provider-catalog";
import { REGISTRY } from "../config/providers/index.ts";
import { createProviderCatalogAdapter } from "../adapters/providerCatalogAdapter.ts";

const builtInCatalog = createProviderCatalogAdapter(REGISTRY);
let activeCatalog: ProviderCatalogPort = builtInCatalog;

/**
 * Resolve provider/model metadata through the runtime port.
 * The built-in registry adapter is the default; the application composition root
 * may replace it with a compatible adapter during bootstrap.
 */
export function getProviderCatalog(): ProviderCatalogPort {
  return activeCatalog;
}

/** Install an application-owned provider catalog adapter. */
export function configureProviderCatalog(catalog: ProviderCatalogPort): () => void {
  const previous = activeCatalog;
  activeCatalog = catalog;
  return () => {
    if (activeCatalog === catalog) activeCatalog = previous;
  };
}

/** Restore the built-in registry adapter, primarily for isolated tests. */
export function resetProviderCatalog(): void {
  activeCatalog = builtInCatalog;
}
