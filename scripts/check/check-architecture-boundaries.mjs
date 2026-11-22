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
assert.ok(databaseCredentialAdapter.includes("requires a proxy"),
  "OAuth refresh must fail closed when a required proxy cannot be resolved");

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
