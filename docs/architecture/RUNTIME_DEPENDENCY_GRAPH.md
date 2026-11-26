---
title: "Runtime dependency graph and boundary rules"
version: 4.0.0-planning
lastUpdated: 2026-11-21
---

# Runtime dependency graph and boundary rules

This is a source-backed map of the current v4 staging baseline. It distinguishes
observed imports from the target architecture. The graph audit is deliberately
incremental: it reports transitional coupling while failing on dependencies that
would break the UI, browser-pool, or contracts package boundaries.

## Current ownership map

| Layer | Current location | Responsibility |
| --- | --- | --- |
| Next.js transport | `src/app` | App Router pages and HTTP route handlers |
| Transport adapters | `src/sse` | Route-facing SSE handler adapters and request orchestration |
| Shared runtime utilities | `src/shared` | Cross-cutting constants, middleware, validation, HTTP and resilience helpers |
| Domain policy | `src/domain` | Routing, fallback, quota, access and model policy |
| Persistence adapters | `src/lib/db` | SQLite driver, schema/migrations, queries, repositories and storage lifecycle |
| Application services | `src/lib` | Application composition, auth, cache, services, jobs and infrastructure |
| Streaming/provider engine | `open-sse` | Provider registry, executors, protocol translation, dispatch and streaming |
| UI kit | `packages/ui-kit` | React presentation primitives and design tokens |
| Browser runtime | `packages/browser-pool` | Optional Playwright/CloakBrowser pool |
| Shared contracts | `packages/contracts` | Runtime-neutral package and API contracts |

## Observed dependency edges

### Next.js routes to streaming and application internals

The current `/v1/chat/completions` route imports both `src/sse/handlers/chat`
and multiple deep modules from `@omniroute/open-sse`, including self-hosted entry,
translator initialization, stream framing, deadlines and error helpers. It also
coordinates auth, request admission, guardrails, quota recovery, semantic cache and
Bifrost routing from `src/lib` and `src/shared`.

The `/v1/responses` route follows a similar pattern: it calls the shared chat handler,
imports model resolution from another route's internal directory, and imports stream
transport helpers directly from `open-sse`.

**Finding:** route handlers are not thin transport adapters yet. They currently
coordinate application policy, admission control and streaming runtime behavior.
The route-to-route import in Responses is an additional boundary smell.

### Streaming engine back into the application

The streaming workspace is not an independent runtime package yet:

- `open-sse/tsconfig.json` maps the root `@/*` alias to `../src/*`.
- Provider executor base code imports root shared resilience and utility modules.
- The provider registry imports root OAuth implementation and root service types.
- `open-sse/services/combo/strategyRegistry.ts` now imports the canonical strategy
  vocabulary from `@omniroute/contracts/routing-strategy`. The root
  `src/shared/constants/routingStrategies.ts` module remains a compatibility facade for
  application/UI consumers, re-exporting the same contract.

**Finding:** the dependency direction is currently bidirectional at the package level.
The root application calls into the streaming engine, while streaming/provider code
reaches back into root application modules. The streaming package is a workspace
boundary, not yet an independently buildable engine boundary.

### Provider lookup and model metadata ports

The contracts package now defines a runtime-neutral `ProviderCatalogPort` with
provider lookup/list and model lookup/list operations. Its projections include only
stable routing metadata and model capabilities; credentials, OAuth material, request
headers, URL builder functions and session-pool internals are intentionally excluded.

`open-sse/adapters/providerCatalogAdapter.ts` adapts the existing provider registry to
that port. `open-sse/services/providerCatalog.ts` provides the built-in adapter by
default and exposes a composition-time configuration hook for an application-owned
adapter. The adapter uses local structural types rather than importing the registry's
implementation types, so this boundary does not create a new back-edge into application
code.

Existing provider consumers have not all been migrated to the port; the legacy registry
remains authoritative during the transition.

### Credential resolution and secret isolation

The contracts package defines `CredentialResolutionPort` using a request reference
(provider, connection/account identifiers, credential kind and purpose) and a
closure-backed `CredentialLease`. Secret material is available only through the
lease's `withCredential` callback; it is not stored as a property on the lease or
provider metadata. Provider-specific code remains responsible for constructing the
correct upstream authorization headers.

`src/lib/credentials/providerCredentialResolver.ts` now contains a database-backed
adapter factory. It reads through `getProviderConnectionById`, preserving the existing
lazy-decryption boundary, and delegates API-key choice to the existing key rotator after
hydrating per-key health state. OAuth refresh delegates to `getAccessToken`, persists
rotated values through `updateProviderConnection` inside the refresh callback, and
requires proxy resolution for connections marked as proxy-enabled. The adapter reloads
the connection after persistence rather than trusting the in-memory refresh result.

`open-sse/services/credentialResolution.ts` remains the fail-closed composition seam.
The new production adapter factory is not yet installed by the application composition
root, and no request-path consumer is migrated. This is intentional: executor-specific
header construction, sticky multi-turn key selection, per-key health persistence and
proxy resolver wiring must be moved without changing existing request behavior.

## Domain policy to persistence

The domain directory contains useful policy modules and repository interfaces, but
some policies still own their storage lifecycle. For example,
`src/domain/fallbackPolicy.ts` directly imports load/save/delete functions from
`src/lib/db/domainState` and hydrates an in-memory cache itself.

The `src/domain/persistence/comboRepositories.ts` file defines repository interfaces,
which is the right direction, but its presence does not mean all domain modules use
ports yet. The database core remains a large infrastructure module responsible for
driver selection, migrations, paths, health checks, backups, and SQLite lifecycle.

**Finding:** the domain/persistence boundary exists in fragments. Domain policy must
depend on repository ports; SQLite implementations and transaction details must stay
behind adapters.

### UI and optional browser runtime

`packages/ui-kit` is a presentation package with React/React DOM and Lucide peer
dependencies. Its components use local UI helpers. Its package manifest does not declare
backend dependencies.

`packages/browser-pool` is a separate optional package with Playwright as its runtime
dependency. The package exposes browser operations and interfaces. Core integration is
designed around dynamic import and injected proxy resolution, which is the correct
dependency-inversion pattern for an optional runtime.

**Finding:** these are the cleanest package boundaries in the current tree. Keep them
that way. The UI kit must never reach backend services. The browser pool must not reach
into application, database, or provider-execution modules.

## Target dependency direction

```text
                         @omniroute/contracts
                           ^      ^       ^
                           |      |       |
                         domain  runtime  UI/API boundary DTOs
                           ^      ^
                           |      |
             domain ports  |   streaming/provider engine
                           |      ^
                    persistence  |
                     adapters    |
                           ^      |
                           +------+
                              |
                  application composition root
                              ^
                              |
                     Next.js / CLI / desktop
                              |
                         UI presentation

Optional browser-pool is an adapter loaded by provider/runtime integration and receives
capabilities (such as proxy resolution) through injected interfaces.
```

The intended dependency rule is inward: domain policy depends on contracts and ports;
infrastructure implements ports; the composition root supplies implementations. UI is a
presentation leaf. Transport handlers translate HTTP into application commands and
responses; they do not own provider policy or SQL.

## Credential resolution composition and first consumer

The Node server installs `createProductionCredentialResolver` immediately after
`ensureDbReadyForBoot()`. The adapter reads credentials through the existing
lazy-decrypting provider-connection store, uses the existing per-key health/rotation
service, and delegates OAuth refresh to the existing serialized refresh orchestrator.
Its proxy callback calls `resolveProxyForConnection` with the connection ID and
provider ID, preserving account/provider/combo/global/automatic proxy scope resolution.
A direct result is a supported configuration; a thrown resolution error is not treated
as permission to retry directly.

The first migrated consumer is the canonical OpenAI API-key executor. Both initial and
stream-recovery sends use `executeOpenAiWithCredentialLease`. The lease callback supplies
the selected API key to the existing `DefaultExecutor`, so the existing provider header
builder continues to create the same Bearer authorization header. The request-local
selected key ID is retained across retries; the cloned executor credentials suppress a
second key rotation, while the parent request metadata keeps the full extra-key list for
failure accounting. The wrapper checks the resolved executor identity, so CLIProxyAPI
and Dario proxy executors plus strict-validation dispatches retain their existing auth
paths. Other providers and OAuth executor paths remain unchanged until their individual
auth contracts are migrated.

## Free-model discovery boundary

`src/lib/freeModelDiscovery` fetches the public OpenRouter model catalogue and admits
only entries with explicit zero input and output prices. It synchronizes those models
into the existing `openrouter` custom-model catalogue using source
`free-model-discovery`, preserving operator-owned entries and metadata. A snapshot is
written atomically under `DATA_DIR` with restrictive file permissions. The scheduler
runs every six hours by default and is disabled by
`OMNIROUTE_FREE_MODEL_DISCOVERY_ENABLED=0`.

The worker does not scrape or import API keys. Discovered models require an existing
OpenRouter provider connection configured through the normal credential UI. It does
not register arbitrary providers, endpoints, or executors; those require a reviewed
provider integration and an explicit authentication contract.

## Enforceable rules

1. `packages/contracts` has no runtime dependencies and cannot import other layers.
2. `packages/ui-kit` may depend on React, UI primitives and contracts only. It cannot
   import Next.js, application services, persistence, streaming executors or browser
   runtime code.
3. `packages/browser-pool` may depend on browser automation and contracts only. Core
   services are injected; it cannot import application, database, UI or streaming code.
4. `open-sse` must not add new root-application imports. Existing `@/` imports are
   migration debt until their owning interface is extracted into contracts or a runtime
   port.
5. `src/domain` must not add direct imports from `src/lib/db`. Introduce or use a
   repository port and implement it in the persistence layer.
6. `src/app` route handlers must not import provider executors or database modules.
   Move orchestration behind application services, then narrow route imports to those
   facades and contracts.
7. Cross-layer changes require contract/adapter tests. Avoid mass moves until import
   graph and behavior tests prove the new direction.

## Audit command

Run:

```bash
npm run audit:architecture
npm run check:architecture-boundaries
```

The graph audit reports cross-layer edge counts and representative transitional imports.
The boundary check fails if the contracts, UI kit or browser-pool leaf rules are broken.
The report is a static import scan; it does not resolve every TypeScript path alias,
conditional export, reflection-based import, or runtime dependency. It must be treated as
a guardrail, not a substitute for package builds or integration tests.

## Extraction order

1. Extract pure request/response and routing types from root aliases into contracts.
2. Introduce application ports for provider lookup, quota, credentials, model metadata
   and stream dispatch.
3. Move root-owned adapters behind those ports and invert `open-sse` dependencies.
4. Convert Next.js route handlers to thin transport adapters over application services.
5. Replace direct domain-to-SQLite calls with repository ports and adapters.
6. Enforce the completed boundaries with package-local typechecks and import rules.

No runtime behavior or persistence schema is changed by this architecture audit.
