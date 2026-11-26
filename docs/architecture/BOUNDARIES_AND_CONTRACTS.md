---
title: "Architecture Boundaries and Contracts"
version: 4.0.0-planning
lastUpdated: 2026-11-21
---

# Architecture boundaries and contracts

This document establishes the first enforceable package boundary for the v4 platform.
It is intentionally incremental: existing runtime ownership stays in place until
characterization tests and dependency checks make extraction safe.

## Package ownership

| Area | Current owner | May depend on | Must not own |
| --- | --- | --- | --- |
| Shared contracts | `@omniroute/contracts` | TypeScript primitives and JSON Schema | Runtime services, framework APIs, database clients, secrets |
| Application shell | Root `omniroute` package | Contracts, core services, UI packages | Provider-specific execution policy hidden in dashboard code |
| Streaming and provider runtime | `@omniroute/open-sse` | Contracts and runtime-safe shared utilities | Dashboard components or Next.js app modules |
| Browser automation | `@omniroute/browser-pool` | Contracts and browser automation dependencies | Core request routing |
| UI system | `@omniroute/ui-kit` | UI primitives and React peer dependencies | Provider execution, database access, credentials |

The root application remains the composition root for now. This change does not claim
that the engine has already been extracted from Next.js or that `open-sse` is fully
independent.

## Dependency direction

Allowed direction:

```text
contracts  <-  core/runtime  <-  application composition root
     ^                ^
     |                |
extensions        adapters / transports

ui-kit <- dashboard / PWA / Electron presentation layers
browser-pool <- explicitly enabled browser-backed runtime features
```

Rules:

1. Contracts are dependency leaves. They cannot import from `src/`, `open-sse/`,
   `app/`, `electron/`, or any framework/database package.
2. Runtime packages may consume contracts, but contracts never consume runtime code.
3. The application shell wires implementations together; domain policy does not import
   dashboard components or Next.js route handlers.
4. UI packages must not import provider executors, credential stores, or persistence code.
5. Cross-package imports use declared package entrypoints. Deep imports are transitional
   and must be removed as each package is extracted.
6. Existing internal modules remain internal until explicitly promoted and covered by
   compatibility tests.

## Contract policy

- Public data contracts are JSON-serializable and versioned.
- A schema version is an integer major contract version. Additive optional fields may be
  introduced within a version; removing or changing the meaning/type of a field requires
  a new version and an explicit compatibility window.
- Never put secrets, credentials, functions, environment values, or runtime handles in
  an extension/sidecar manifest.
- TypeScript interfaces describe compile-time shape; JSON Schema is the runtime
  interchange contract. Both must change together.
- Contract packages use strict TypeScript settings independently of the legacy root
  application settings.
- Runtime validation must happen at trust boundaries. A TypeScript cast is not validation.

## First extracted contract

`@omniroute/contracts` now owns the provider-plugin manifest types previously declared
inside `open-sse/config/providerPluginManifest.ts`. The generator remains in
`@omniroute/open-sse`, preserving provider registry ownership and current output
behavior. The canonical v1 JSON Schema is
`packages/contracts/schemas/provider-plugin-manifest.v1.schema.json`.

This is a type/schema extraction, not a provider executor extraction and not a claim that
all manifest consumers validate against JSON Schema yet.

## Migration sequence

1. Characterize current API and provider-manifest behavior before moving implementation.
2. Extract runtime-neutral contracts and add package-local strict type checking.
3. Add import-boundary checks and migrate consumers to public package entrypoints.
4. Extract domain policy behind interfaces without changing transport behavior.
5. Move adapters and framework composition only after integration tests prove parity.

## Explicit non-goals

- No bulk directory move.
- No change to provider selection, executor dispatch, API payloads, or database schema.
- No public npm release of the contracts package while it remains marked private.
- No change to the v3 validation/release branches.
