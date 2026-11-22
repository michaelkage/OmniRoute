import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_CANDIDATES = 500;
const REQUEST_TIMEOUT_MS = 15_000;

export type FreeModelCandidate = {
  id: string;
  name: string;
  providerId: "openrouter";
  providerName: "OpenRouter";
  baseUrl: "https://openrouter.ai/api/v1";
  pricing: { prompt: 0; completion: 0 };
  contextLength: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  sourceUrl: typeof OPENROUTER_MODELS_URL;
  discoveredAt: string;
  requiresUserCredential: true;
  activation: "available-after-provider-auth";
};

export type FreeModelDiscoverySnapshot = {
  schemaVersion: 1;
  source: typeof OPENROUTER_MODELS_URL;
  discoveredAt: string;
  providerCandidates: Array<{
    id: "openrouter";
    name: "OpenRouter";
    status: "existing-provider";
    requiresUserCredential: true;
    modelCount: number;
  }>;
  models: FreeModelCandidate[];
};

type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
  supported_parameters?: unknown;
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function isFreePrice(value: unknown): boolean {
  if (typeof value === "string" && !value.trim()) return false;
  if (typeof value !== "string" && typeof value !== "number") return false;
  const price = Number(value);
  return Number.isFinite(price) && price === 0;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && /^[a-z0-9_-]{1,40}$/i.test(item)
  ))].slice(0, 32);
}

function isSafeModelId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}

function toCandidate(value: unknown, discoveredAt: string): FreeModelCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const model = value as OpenRouterModel;
  if (!isSafeModelId(model.id)) return null;
  if (!isFreePrice(model.pricing?.prompt) || !isFreePrice(model.pricing?.completion)) return null;

  const name = typeof model.name === "string" && model.name.trim()
    ? model.name.trim().slice(0, 256)
    : model.id;

  return {
    id: model.id,
    name,
    providerId: "openrouter",
    providerName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    pricing: { prompt: 0, completion: 0 },
    contextLength: finiteNumber(model.context_length),
    inputModalities: stringList(model.architecture?.input_modalities),
    outputModalities: stringList(model.architecture?.output_modalities),
    supportedParameters: stringList(model.supported_parameters),
    sourceUrl: OPENROUTER_MODELS_URL,
    discoveredAt,
    requiresUserCredential: true,
    activation: "available-after-provider-auth",
  };
}

async function readOpenRouterCatalog(fetchFn: typeof fetch): Promise<unknown[]> {
  const response = await fetchFn(OPENROUTER_MODELS_URL, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "OmniRoute-FreeModelDiscovery/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(`OpenRouter catalog request failed with HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("OpenRouter catalog response had no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OpenRouter catalog response exceeded the configured size limit");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("OpenRouter catalog returned invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { data?: unknown }).data)) {
    throw new Error("OpenRouter catalog response did not contain a model list");
  }
  return (parsed as { data: unknown[] }).data;
}

function getSnapshotPath(): string {
  const dataDir = process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
  return path.join(path.resolve(dataDir), "free-model-discovery.json");
}

async function persistSnapshot(snapshot: FreeModelDiscoverySnapshot): Promise<string> {
  const destination = getSnapshotPath();
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  return destination;
}

/**
 * Discover public, zero-priced OpenRouter model metadata.
 *
 * This worker never searches for, extracts, validates, stores, or imports API
 * keys. It only adds models to the existing OpenRouter provider catalogue.
 * The provider becomes routable when the operator configures their own
 * OpenRouter connection through OmniRoute's normal credential flow.
 */
export async function discoverFreeModels(
  options: { fetchFn?: typeof fetch; now?: () => Date } = {},
): Promise<FreeModelDiscoverySnapshot> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const discoveredAt = (options.now ?? (() => new Date()))().toISOString();
  const rawModels = await readOpenRouterCatalog(fetchFn);
  const unique = new Map<string, FreeModelCandidate>();

  for (const raw of rawModels) {
    const candidate = toCandidate(raw, discoveredAt);
    if (candidate) unique.set(candidate.id, candidate);
  }

  const models = [...unique.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_CANDIDATES);

  return {
    schemaVersion: 1,
    source: OPENROUTER_MODELS_URL,
    discoveredAt,
    providerCandidates: [{
      id: "openrouter",
      name: "OpenRouter",
      status: "existing-provider",
      requiresUserCredential: true,
      modelCount: models.length,
    }],
    models,
  };
}

async function syncOpenRouterModelCatalog(
  candidates: readonly FreeModelCandidate[],
): Promise<void> {
  const { getCustomModels, replaceCustomModels } = await import("@/lib/db/models");
  type CustomModelInput = Parameters<typeof replaceCustomModels>[1][number];
  const existing = await getCustomModels("openrouter");
  const current = Array.isArray(existing)
    ? existing as Array<CustomModelInput & { supportsVision?: boolean }>
    : [];
  const operatorOwned = current.filter((model) =>
    typeof model.id === "string" && model.source !== "free-model-discovery"
  );
  const operatorOwnedIds = new Set(
    operatorOwned
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string"),
  );

  const managed = candidates
    .filter((candidate) => !operatorOwnedIds.has(candidate.id))
    .map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      source: "free-model-discovery",
      apiFormat: "chat-completions",
      supportedEndpoints: ["chat"],
      ...(candidate.inputModalities.includes("image") ? { supportsVision: true } : {}),
      isFree: true,
    }));

  await replaceCustomModels(
    "openrouter",
    [...operatorOwned, ...managed] as CustomModelInput[],
    { allowEmpty: true },
  );
}

export async function runFreeModelDiscovery(
  options: { fetchFn?: typeof fetch; now?: () => Date } = {},
): Promise<{ snapshot: FreeModelDiscoverySnapshot; path: string }> {
  const snapshot = await discoverFreeModels(options);
  await syncOpenRouterModelCatalog(snapshot.models);
  const destination = await persistSnapshot(snapshot);
  return { snapshot, path: destination };
}
