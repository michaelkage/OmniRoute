#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const contractsPackage = JSON.parse(
  await readFile(join(root, "packages/contracts/package.json"), "utf8"),
);
const openSsePackage = JSON.parse(await readFile(join(root, "open-sse/package.json"), "utf8"));
const contractsSource = join(root, "packages/contracts/src");
const tsconfig = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
const providerCatalogContract = await readFile(
  join(contractsSource, "provider-catalog.ts"),
  "utf8",
);
const providerCatalogAdapter = await readFile(
  join(root, "open-sse/adapters/providerCatalogAdapter.ts"),
  "utf8",
);
const providerCatalogService = await readFile(
  join(root, "open-sse/services/providerCatalog.ts"),
  "utf8",
);
const credentialContract = await readFile(
  join(contractsSource, "credential-resolution.ts"),
  "utf8",
);
const credentialService = await readFile(
  join(root, "open-sse/services/credentialResolution.ts"),
  "utf8",
);
const manifestGenerator = await readFile(
  join(root, "open-sse/config/providerPluginManifest.ts"),
  "utf8",
);

assert.deepEqual(contractsPackage.dependencies ?? {}, {},
  "contracts must not add runtime or framework dependencies");
assert.ok(rootPackage.workspaces.includes("packages/contracts"),
  "packages/contracts must be registered as a root workspace");
assert.equal(openSsePackage.dependencies?.["@omniroute/contracts"], contractsPackage.version,
  "open-sse must declare the exact local contracts package version");
assert.deepEqual(tsconfig.compilerOptions.paths["@omniroute/contracts"],
  ["./packages/contracts/src/index.ts"],
  "root TypeScript config must resolve the contracts package entrypoint");
assert.equal(contractsPackage.exports["./provider-catalog"], "./src/provider-catalog.ts",
  "provider catalog contract must have an explicit package export");
assert.equal(contractsPackage.exports["./credential-resolution"], "./src/credential-resolution.ts",
  "credential resolution contract must have an explicit package export");
assert.ok(providerCatalogContract.includes("export interface ProviderCatalogPort"),
  "provider catalog contract must define the runtime port");
assert.ok(providerCatalogAdapter.includes("@omniroute/contracts/provider-catalog"),
  "provider catalog adapter must depend on the shared contract");
assert.equal(providerCatalogAdapter.includes("@/"), false,
  "provider catalog adapter must not import root application aliases");
assert.ok(providerCatalogService.includes("configureProviderCatalog"),
  "provider catalog must expose composition-time adapter injection");
assert.ok(credentialContract.includes("export interface CredentialResolutionPort"),
  "credential contract must define the resolver port");
assert.ok(credentialContract.includes("withCredential"),
  "credential lease must expose callback-scoped credential access");
assert.ok(!/\b(apiKey|accessToken|refreshToken|clientSecret)\s*\??\s*:/i.test(credentialContract),
  "credential contract must not expose raw secret properties");
assert.ok(credentialService.includes("configureCredentialResolutionPort"),
  "credential resolution must expose composition-time adapter injection");
assert.ok(credentialService.includes("has not been configured"),
  "credential resolution must fail closed without an installed adapter");
const databaseCredentialAdapter = await readFile(
  join(root, "src/lib/credentials/providerCredentialResolver.ts"),
  "utf8",
);
assert.ok(databaseCredentialAdapter.includes("getProviderConnectionById"),
  "production credential adapter must use the existing encrypted connection store");
assert.ok(databaseCredentialAdapter.includes("getValidApiKey"),
  "production credential adapter must preserve per-key rotation and health");
assert.ok(databaseCredentialAdapter.includes("getAccessToken"),
  "production credential adapter must preserve the OAuth refresh orchestrator");
assert.ok(databaseCredentialAdapter.includes("updateProviderConnection"),
  "production credential adapter must persist rotated OAuth tokens through the existing write path");
assert.ok(databaseCredentialAdapter.includes("resolveProxy"),
  "OAuth refresh must use the injected connection proxy resolver");
assert.ok(databaseCredentialAdapter.includes("Resolution errors still propagate"),
  "OAuth refresh must not silently bypass a failed proxy lookup");
const instrumentation = await readFile(join(root, "src/instrumentation-node.ts"), "utf8");
assert.ok(instrumentation.includes("configureCredentialResolutionPort"),
  "server composition must install the production credential resolver");
assert.ok(instrumentation.indexOf("await ensureDbReadyForBoot()") <
  instrumentation.indexOf("configureCredentialResolutionPort"),
  "credential resolver must be installed after database readiness");
const credentialLeaseExecution = await readFile(
  join(root, "open-sse/handlers/chatCore/credentialLeaseExecution.ts"),
  "utf8",
);
const providerRequestExecution = await readFile(
  join(root, "open-sse/handlers/chatCore/executeProviderRequest.ts"),
  "utf8",
);
assert.ok(credentialLeaseExecution.includes("lease.withCredential"),
  "OpenAI execution must consume secret material inside the lease callback");
assert.ok(credentialLeaseExecution.includes('provider !== "openai"'),
  "the first credential migration must remain scoped to the OpenAI executor");
assert.ok(credentialLeaseExecution.includes('executorProvider !== "openai"'),
  "provider-level proxy wrappers must retain their dedicated authentication paths");
assert.equal(
  providerRequestExecution.split("executeOpenAiWithCredentialLease(provider, executor, {").length - 1,
  2,
  "initial and stream-recovery sends must both use the same lease execution boundary",
);
const discoveryWorker = await readFile(
  join(root, "src/lib/freeModelDiscovery/worker.ts"),
  "utf8",
);
assert.ok(discoveryWorker.includes("https://openrouter.ai/api/v1/models"),
  "free-model discovery must use the public OpenRouter model catalogue");
assert.ok(discoveryWorker.includes("replaceCustomModels"),
  "verified free models must be synchronized into the existing OpenRouter model catalogue");
assert.ok(discoveryWorker.includes("requiresUserCredential: true"),
  "discovered models must require the operator's own provider credential");
assert.ok(rootPackage.files.includes("scripts/discovery/"),
  "the manual discovery command must be included in published packages");

assert.ok(manifestGenerator.includes(
  '@omniroute/contracts/provider-plugin-manifest',
), "provider manifest generator must consume the shared contract package");

const files = await sourceFiles(contractsSource);
const violations = [];

for (const path of files) {
  const content = await readFile(path, "utf8");
  const importPattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1];
    const target = resolve(dirname(path), specifier);
    const targetRelativeToContracts = relative(contractsSource, target);
    if (
      !specifier.startsWith("./") && !specifier.startsWith("../") ||
      targetRelativeToContracts.startsWith("..") ||
      isAbsolute(targetRelativeToContracts)
    ) {
      violations.push(relative(root, path) + " imports outside the contracts boundary: " + specifier);
    }
  }
}

assert.deepEqual(violations, [], "contracts must remain a dependency leaf");
console.log("Architecture boundary check passed (" + files.length + " contract source files).");
