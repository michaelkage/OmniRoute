#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const layers = [
  ["app", "src/app"],
  ["domain", "src/domain"],
  ["application", "src/lib"],
  ["streaming", "open-sse"],
  ["ui", "packages/ui-kit/src"],
  ["browser", "packages/browser-pool/src"],
  ["contracts", "packages/contracts/src"],
];

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collect(path);
    return /\.(?:[cm]?js|[jt]sx?)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

function resolveImport(fromFile, specifier) {
  if (specifier.startsWith("@/")) return resolve(root, "src", specifier.slice(2));
  if (specifier.startsWith("@omniroute/open-sse/")) {
    return resolve(root, "open-sse", specifier.slice("@omniroute/open-sse/".length));
  }
  if (specifier === "@omniroute/open-sse") return resolve(root, "open-sse/index.ts");
  if (specifier.startsWith("@omniroute/ui-kit/")) {
    return resolve(root, "packages/ui-kit/src", specifier.slice("@omniroute/ui-kit/".length));
  }
  if (specifier === "@omniroute/ui-kit") return resolve(root, "packages/ui-kit/src/index.ts");
  if (specifier.startsWith("@omniroute/browser-pool/")) {
    return resolve(root, "packages/browser-pool/src", specifier.slice("@omniroute/browser-pool/".length));
  }
  if (specifier === "@omniroute/browser-pool") return resolve(root, "packages/browser-pool/src/index.ts");
  if (specifier.startsWith("@omniroute/contracts/")) {
    return resolve(root, "packages/contracts/src", specifier.slice("@omniroute/contracts/".length));
  }
  if (specifier === "@omniroute/contracts") return resolve(root, "packages/contracts/src/index.ts");
  if (specifier.startsWith(".")) return resolve(dirname(fromFile), specifier);
  return null;
}

function layerFor(absPath) {
  const rel = relative(root, absPath).split(sep).join("/");
  return layers.find(([, prefix]) => rel === prefix || rel.startsWith(prefix + "/"))?.[0] ?? null;
}

const graph = [];
for (const [layer, directory] of layers) {
  for (const file of await collect(join(root, directory))) {
    const source = await readFile(file, "utf8");
    const imports = /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      const resolved = resolveImport(file, match[1]);
      const target = resolved ? layerFor(resolved) : null;
      if (target && target !== layer) {
        graph.push({ from: layer, to: target, file: relative(root, file).split(sep).join("/"), specifier: match[1] });
      }
    }
  }
}

const counts = new Map();
for (const edge of graph) {
  const key = edge.from + " -> " + edge.to;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log("OmniRoute architecture dependency edges:");
for (const [edge, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
  console.log("  " + edge + ": " + count);
}

const violations = graph.filter((edge) =>
  (edge.from === "ui" && ["app", "domain", "application", "streaming", "browser"].includes(edge.to)) ||
  (edge.from === "browser" && ["app", "domain", "application", "streaming", "ui"].includes(edge.to)) ||
  (edge.from === "contracts" && edge.to !== "contracts")
);
if (violations.length) {
  console.error("\nForbidden leaf-package dependencies:");
  for (const edge of violations) console.error("  " + edge.file + " -> " + edge.specifier);
}
assert.deepEqual(violations, [], "UI, browser-pool, and contracts must remain infrastructure leaves");

const debt = graph.filter((edge) =>
  (edge.from === "app" && edge.to === "streaming") ||
  (edge.from === "streaming" && ["app", "application"].includes(edge.to)) ||
  (edge.from === "domain" && edge.to === "application")
);
console.log("\nTransitional coupling edges requiring staged extraction: " + debt.length);
for (const edge of debt.slice(0, 30)) {
  console.log("  " + edge.file + " -> " + edge.specifier);
}
if (debt.length > 30) console.log("  ... " + (debt.length - 30) + " more");
