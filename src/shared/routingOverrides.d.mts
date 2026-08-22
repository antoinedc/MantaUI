// routingOverrides.d.mts — declarations for routingOverrides.mjs (BET-1276
// 12a). Exported for use by the routing:choose handler and Deck A; the types
// are deliberately loose (the bag is a shallow merge at the wrapper).

/** The dev-only overrides bag on a routing:choose request. */
export interface RoutingOverrides {
  /** Replaces services.accounts for the call (providerID → AccountState). */
  accounts?: Record<string, unknown>;
  /** Replaces services.health for the call (providerID → state string). */
  health?: Record<string, string>;
  /** Endpoint keys (providerID/modelID) restricting the main candidate pool. */
  enabledMain?: string[];
  /** Endpoint keys restricting the sub candidate pool. */
  enabledSub?: string[];
  /** Injected clock for the call (the router already takes injected time). */
  nowMs?: number;
}

export function applyRoutingOverrides(o: {
  services?: unknown;
  catalog?: unknown[];
  surface?: "main" | "sub";
  overrides?: RoutingOverrides | Record<string, unknown>;
  gated?: boolean;
}): { services: unknown; catalog: unknown[] };

export function resolveNowOverride(
  overrides: unknown,
  gated: boolean,
  fallback: number,
): number;

export function resolveHealthOverride(
  overrides: unknown,
  gated: boolean,
): Record<string, string> | null;
