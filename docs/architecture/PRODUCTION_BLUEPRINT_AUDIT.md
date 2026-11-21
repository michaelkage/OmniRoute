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
- Added the versioned JSON Schema
  `packages/contracts/schemas/provider-plugin-manifest.v1.schema.json`.
- Added AJV 2020-12 tests that validate generated manifests and reject unknown
  top-level fields.
- Added `npm run check:architecture-boundaries` to guard the contracts package as a
  dependency leaf and verify workspace/alias wiring.

These are foundation slices, not completion of either milestone. The root application
still has a non-strict TypeScript configuration, most cross-layer imports remain in
place, and the runtime boundary between the application shell and streaming engine has
not yet been extracted. The new typecheck, boundary check, and manifest tests have not
been executed in this environment; CI evidence is still required.

## Milestone 1 dependency graph — 2026-11-21

A source-backed dependency map is now documented in
`docs/architecture/RUNTIME_DEPENDENCY_GRAPH.md`. The new
`npm run audit:architecture` command scans the principal source layers and reports
cross-layer imports; `npm run check:architecture-boundaries` combines this with the
contracts leaf check and fails on forbidden UI/browser/contracts layer edges.

Observed coupling includes Next.js routes importing deep streaming-engine helpers and
application services, `open-sse` importing root `src/shared` and `src/lib` modules,
and domain fallback policy importing SQLite persistence functions directly. The UI kit
and browser-pool are the cleanest package boundaries and should remain leaves with
capabilities injected from their callers.

This is an initial enforcement slice, not full graph closure. The audit has not been
executed against a local checkout or CI in this environment, so no edge counts or
passing result are claimed. The first narrow dependency inversion is now landed: strategy vocabulary no longer flows
from the streaming engine into a root application alias. Remaining Milestone 1 work is to
introduce provider lookup, credential, model metadata, quota and dispatch ports; invert
the remaining `open-sse` back-dependencies; move domain persistence behind repository
adapters; and thin route handlers without changing wire behavior.

## Implementation order

The dependencies are not independent. The recommended sequence is:

1. **Boundary and contract foundation:** milestones 1 and 2. Define package ownership, dependency direction, public contracts, schema versioning and compatibility policy.
2. **Extension platform:** milestones 3 and 4. The SDK and provider contract must exist before a marketplace can safely distribute modules.
3. **Core policy surfaces:** milestones 5 through 9. Reuse the existing routing, selection, resilience, persistence and protocol implementations behind stable interfaces.
4. **Trust and operations:** milestones 10 through 12. Signing, secret isolation, correlated telemetry and cost/resource evidence are release gates, not optional polish.
5. **Product and distribution:** milestones 13 through 16. Shared UI, guided onboarding, marketplace UX and modular runtime profiles depend on the package and extension contracts.

## Non-goals and safety rails

- Do not replace SQLite with PostgreSQL merely because Neon is available. The existing application has a mature SQLite schema, migrations, backup and recovery path.
- Neon snapshot durability is not a PostgreSQL adapter, live replication, or multi-writer database. It is a recovery layer for one active SQLite writer.
- Do not duplicate the existing routing strategy registry, provider manifest, resilience mechanisms, onboarding wizard, or Docker runtime targets.
- Do not move features onto v3.8.55-v3.8.59. Follow the upstream v4 branch/channel policy.
- Every extraction must preserve current public API behavior and have characterization tests before moving code.
- Do not claim a milestone complete until its CI quality gates, package/build tests, and runtime integration checks pass.

## Upstream references

- `ROADMAP.md` — preparation, validation, v3 LTS and v4 modular-platform phases.
- `docs/ops/RELEASE_STRATEGY.md` — branch/channel policy and feature freeze.
- `docs/reference/PROVIDER_PLUGIN_MANIFEST.md` — current JSON-safe provider sidecar contract.
- `docs/architecture/RESILIENCE_GUIDE.md` — existing resilience layers and their distinct scopes.
- `docs/ops/LTS_GO_NO_GO.md` — release quality gates and evidence requirements.
