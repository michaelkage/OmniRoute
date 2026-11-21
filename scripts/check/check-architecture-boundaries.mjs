#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\\.tsx?$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const contractsPackage = JSON.parse(
  await readFile(join(root, "packages/contracts/package.json"), "utf8"),
);
const openSsePackage = JSON.parse(await readFile(join(root, "open-sse/package.json"), "utf8"));
const tsconfig = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
const manifestGenerator = await readFile(
  join(root, "open-sse/config/providerPluginManifest.ts"),
  "utf8",
);

assert.ok(rootPackage.workspaces.includes("packages/contracts"),
  "packages/contracts must be registered as a root workspace");
assert.equal(openSsePackage.dependencies?.["@omniroute/contracts"], contractsPackage.version,
  "open-sse must declare the exact local contracts package version");
assert.deepEqual(tsconfig.compilerOptions.paths["@omniroute/contracts"],
  ["./packages/contracts/src/index.ts"],
  "root TypeScript config must resolve the contracts package entrypoint");
assert.ok(manifestGenerator.includes(
  '@omniroute/contracts/provider-plugin-manifest',
), "provider manifest generator must consume the shared contract package");

const forbidden = /^(?:@\\/|next(?:\\/|$)|react(?:\\/|$)|better-sqlite3(?:\\/|$)|\\.\\.\\/(?:src|open-sse|app|electron)(?:\\/|$))/;
const files = await sourceFiles(join(root, "packages/contracts/src"));
const violations = [];

for (const path of files) {
  const content = await readFile(path, "utf8");
  const importPattern = /(?:from\\s*|import\\s*\\()\\s*["']([^"']+)["']/g;
  for (const match of content.matchAll(importPattern)) {
    if (forbidden.test(match[1])) {
      violations.push(`${relative(root, path)} imports forbidden dependency ${match[1]}`);
    }
  }
}

assert.deepEqual(violations, [], "contracts must remain a dependency leaf");
console.log(`Architecture boundary check passed (${files.length} contract source files).`);
