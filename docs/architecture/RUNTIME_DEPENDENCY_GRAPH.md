---
title: "Runtime Dependency Graph and Boundary Rules"
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

This is the first provider/model runtime-port slice. Existing provider consumers have not
all been migrated to the port yet; the legacy registry remains authoritative during the
transition. Credential, quota and dispatch ports are still outstanding.

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
