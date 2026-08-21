export const BOUNDARY: {
  FIRST_TURN: string;
  AGENT: string;
  CONSTRAINT: string;
  COMPACTED: string;
  USER: string;
};

/**
 * A routed endpoint as it crosses the RPC boundary: the RPC/deliver shape uses
 * `modelID`, the router's internal catalogue shape uses `id`. `endpointKey`
 * accepts both sides so they resolve to one identity. At least one of
 * `modelID` / `id` is normally present; an endpoint with neither has no
 * identity and never matches another.
 */
export interface RoutedEndpoint {
  providerID: string;
  modelID?: string;
  id?: string;
  variant?: string;
}

export interface CrossesInput {
  hasRoutedModel?: boolean;
  agent?: string;
  previousAgent?: string;
  contextTokens?: number;
  incumbentContextLimit?: number;
  requiredModalities?: string[];
  incumbentModel?: object | null;
  incumbentHealthy?: boolean;
  justCompacted?: boolean;
  userRequested?: boolean;
}

export interface CrossesResult {
  crossed: boolean;
  boundary: string | null;
  // Whether the incumbent still "fits" this turn (context within its limit AND
  // every required modality present) and its provider is healthy. A CONSTRAINT
  // boundary sets one of these false so the caller can force a switch even when
  // the incumbent stays in the router's top-N.
  stillCapable: boolean;
  stillHealthy: boolean;
}

export function crossesBoundary(input?: CrossesInput): CrossesResult;
export function boundaryPhrase(boundary: string | null): string;

export interface ShouldSwitchInput {
  incumbent?: RoutedEndpoint | null;
  ranked?: RoutedEndpoint[];
  incumbentStillEligible: boolean;
  incumbentStillCapable: boolean;
  incumbentHealthy: boolean;
  topN?: number;
}

export interface ShouldSwitchResult {
  switch: boolean;
  why: string;
}

export function shouldSwitch(input?: ShouldSwitchInput): ShouldSwitchResult;
