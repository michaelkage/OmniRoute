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

function toCandidate(model: OpenRouterModel, discoveredAt: string): FreeModelCandidate | null {
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

async function readOpenRouterCatalog(fetchFn: typeof fetch): Promise<OpenRouterModel[]> {
  const response = await fetchFn(OPENROUTER_MODELS_URL, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "OmniRoute-FreeModelDiscovery/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });

  if (!response.ok) {
    throw new Error(`OpenRouter catalog request failed with HTTP ${response.status}`);
  }

  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("OpenRouter catalog response exceeded the configured size limit");
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
  return (parsed as { data: OpenRouterModel[] }).data;
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

export async function runFreeModelDiscovery(
  options: { fetchFn?: typeof fetch; now?: () => Date } = {},
): Promise<{ snapshot: FreeModelDiscoverySnapshot; path: string }> {
  const snapshot = await discoverFreeModels(options);
  const destination = await persistSnapshot(snapshot);
  return { snapshot, path: destination };
}
