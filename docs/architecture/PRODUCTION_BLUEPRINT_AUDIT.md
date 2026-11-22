---
title: "Production Blueprint Audit"
version: 4.0.0-planning
lastUpdated: 2026-11-21
---

# Production blueprint audit

This document maps the 16-milestone production blueprint to the canonical upstream
v3.8.55 codebase. It prevents re-implementing capabilities that already exist and
keeps new platform work aligned with the upstream v4 architecture.

## Release-line constraint

The upstream roadmap defines v3.8.55 through v3.8.59 as a validation rail for fixes,
documentation, i18n and provider updates. New features are held for the v4 development
line. The v4 development branch is named `develop` in the roadmap but was not present
in the upstream branch listing inspected on 2026-11-21.

The production blueprint therefore belongs on a separate v4 staging branch. Do not
merge these feature changes into the v3 validation or future v3 LTS line.

## Existing architecture evidence

- The root package is still the `omniroute` application and uses workspaces for
  `open-sse`, `packages/browser-pool`, and `packages/ui-kit`.
- `@omniroute/open-sse` is already a separately named workspace package, but remains
  private and is tightly coupled to the root source tree.
- `packages/ui-kit` is a private, vendored package consumed directly from source.
- Provider metadata already has a JSON-safe v1 manifest and a registry adapter for
  sidecars. It deliberately excludes executors, OAuth secrets, dynamic URL builders,
  and session-pool internals.
- Routing strategy dispatch already uses a typed strategy-traits registry.
- The runtime already has provider circuit breakers, connection cooldowns, quota-aware
  account selection, stream recovery, request telemetry, and structured logs.
- A six-step first-run onboarding wizard already exists.
- Plugins already have validated manifests, child-process isolation, permission-model
  support, and optional entry-file integrity hashes.
- Docker already has separate base, web, and CLI runtime targets; headless, Electron,
  PWA and CLI entry points also exist.

## Milestone status

| # | Milestone | Current status | What remains |
|---:|---|---|---|
| 1 | Core Architecture Decomposition | Partial | Separate the engine from Next.js/dashboard concerns; create stable package boundaries and remove cross-layer import cycles without breaking the existing release rail |
| 2 | Unified Type System and Contract Enforcement | Partial | Establish one public SDK contract, strict package-level type gates, versioned extension schemas and compatibility tests |
| 3 | Unified Extension SDK | Pending | Consolidate plugins, CLI plugins, skills, MCP tools and A2A skills into one declarative manifest and lifecycle |
| 4 | Provider Plugin Architecture | Partial | Turn the sidecar manifest into a first-class provider module contract with install, validation, lifecycle and compatibility guarantees |
| 5 | Routing Strategy Engine Unification | Mostly landed | Preserve the existing strategy registry; expose supported strategy extension points through the future SDK rather than creating a second registry |
| 6 | Intelligent Provider and Model Selection | Mostly landed | Unify scoring inputs and explainability across quota, task, context, cost, latency and availability signals |
| 7 | Unified Resilience and Recovery Engine | Mostly landed | Keep provider breakers, account cooldowns and stream recovery distinct internally, but expose one policy/diagnostic contract and common recovery telemetry |
| 8 | Database and Persistence Architecture Modernization | Partial | Keep SQLite as the current live store; add tested backup/restore durability and define a future adapter boundary before attempting PostgreSQL-native persistence |
| 9 | Unified API Gateway and Protocol Compatibility | Partial | Preserve existing protocol adapters while extracting a stable gateway boundary and shared request/response contracts |
| 10 | Advanced Security and Credential Isolation | Partial | Make extension signing and integrity mandatory for remote installs, tighten permission defaults, and formalize secret boundaries and audit evidence |
| 11 | Unified Observability and Request Tracing | Partial | Correlate request IDs across gateway, routing, providers and extensions; add exporter/retention contracts and operational alert thresholds |
| 12 | Advanced Cost and Resource Optimization | Mostly landed | Consolidate spend, price, quota and resource signals into a consistent policy surface with reproducible optimization evidence |
| 13 | Dashboard UX and Design System Unification | Partial | Promote the vendored UI kit into a supported design-system contract shared by dashboard, PWA and Electron |
| 14 | Intelligent Onboarding and Configuration | Mostly landed | Extend the existing onboarding wizard with validated deployment profiles, safe defaults and actionable diagnostics rather than replacing it |
| 15 | Modular Extension Marketplace | Partial | Build a trusted registry, signed artifacts, mandatory integrity verification, compatibility resolution, rollback and sandboxed installation |
| 16 | Runtime Profiles and Modular Distribution | Partial | Formalize minimal/server/CLI/desktop profiles and publish versioned core, SDK and module artifacts with compatibility guarantees |

## V4 staging progress — 2026-11-21

Milestones 1 and 2 have an initial implementation slice on
`feature/v4-production-blueprint-neon-latest`:

- Added the private `@omniroute/contracts` workspace as a dependency-free package.
- Enabled strict TypeScript checking for that package with
  `npm run typecheck:contracts`.
- Moved the provider-plugin manifest's shared TypeScript interfaces into the contracts
  package while keeping the generator and provider registry in `open-sse`.
- Extracted the canonical public/internal routing-strategy vocabulary into
  `@omniroute/contracts/routing-strategy`; the streaming strategy registry now imports
  that contract directly, and the root constants module remains a compatibility facade.
- Added the runtime-neutral `ProviderCatalogPort` for provider and model metadata,
  plus a registry adapter and composition-time injection hook. Its projection excludes
  credentials, OAuth secrets, headers, URL builders and session-pool internals.
- Added focused unit coverage for provider lookup, model lookup, sensitive-field
  exclusion and adapter replacement/restoration. Tests have been authored but not run.
- Added a secret-safe `CredentialResolutionPort` with callback-scoped credential
  leases. Secret values are not properties on the lease or provider metadata.
- Added a database-backed adapter factory that reads through the existing
  lazy-decrypting connection store, delegates API-key selection to the existing
  health-aware rotator, and delegates OAuth refresh to the existing serialized refresh
  orchestrator with the existing transactional update path.
- Installed the production credential resolver in the Node server composition
  immediately after SQLite boot readiness. OAuth refresh now calls the existing
  `resolveProxyForConnection(connectionId, apiKeyId, providerId)` scope cascade.
  A configured direct-egress result remains direct, matching existing OmniRoute policy;
  proxy-resolution errors propagate and cannot silently downgrade to direct egress.
- Migrated the canonical OpenAI API-key execution path to callback-scoped credential
  leases for both initial sends and stream-recovery sends. The lease selects a healthy
  key from the database-backed connection, retains the selected key identity across
  retries, and passes the selected value through the existing OpenAI executor header
  builder. The executor still emits its original `Authorization: Bearer` header.
  Other providers and OAuth executor paths remain on their existing credential flow.
- Added a public free-model discovery worker using OpenRouter's public model catalogue.
  It only indexes models whose input and output prices are both explicitly zero,
  synchronizes them into the existing `openrouter` custom-model catalogue, preserves
  operator-owned model entries, and writes a private atomic snapshot under `DATA_DIR`.
  The worker is scheduled every six hours by default and can be disabled with
  `OMNIROUTE_FREE_MODEL_DISCOVERY_ENABLED=0`. Discovered models require an operator-
  configured OpenRouter connection; the worker never harvests, imports, or stores API
  keys and never invents new provider executors or endpoints.
- Added `npm run models:discover` for a manual discovery pass.
- Added tests for the resolver seam, database adapter, OpenAI lease execution, and
  discovery metadata validation. Tests are authored but have not been executed.
- Added the versioned JSON Schema
  `packages/contracts/schemas/provider-plugin-manifest.v1.schema.json`.
- Added AJV 2020-12 tests that validate generated manifests and reject unknown
  top-level fields.
- Added `npm run check:architecture-boundaries` to guard the contracts package as a
  dependency leaf and verify workspace/alias wiring.

These are foundation slices, not completion of either milestone. The root application
still has a non-strict TypeScript configuration, most cross-layer imports remain in
place, and the runtime boundary between the application shell and streaming engine has
not yet been extracted. The new typecheck, boundary check, manifest tests and credential
port tests have not been executed in this environment; CI evidence is still required.
