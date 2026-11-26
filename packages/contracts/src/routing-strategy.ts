/**
 * Runtime-neutral routing strategy vocabulary shared by the application and streaming engine.
 *
 * Keep user-selectable and system-internal values distinct: internal strategies must never
 * leak into UI/API option lists.
 */
export const ROUTING_STRATEGY_VALUES = [
  "priority",
  "weighted",
  "round-robin",
  "context-relay",
  "fill-first",
  "p2c",
  "random",
  "least-used",
  "cost-optimized",
  "reset-aware",
  "reset-window",
  "expiry-first",
  "headroom",
  "quota-weighted",
  "strict-random",
  "auto",
  "lkgp",
  "context-optimized",
  "cache-optimized",
  "fusion",
  "pipeline",
  "jev",
] as const;

export type RoutingStrategyValue = (typeof ROUTING_STRATEGY_VALUES)[number];

/** System-generated strategies; deliberately excluded from user-selectable values. */
export const INTERNAL_ROUTING_STRATEGY_VALUES = ["quota-share"] as const;

export type InternalRoutingStrategyValue = (typeof INTERNAL_ROUTING_STRATEGY_VALUES)[number];

/** Any strategy accepted by the combo dispatch engine. */
export type AnyRoutingStrategyValue = RoutingStrategyValue | InternalRoutingStrategyValue;
