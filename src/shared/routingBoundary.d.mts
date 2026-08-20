export const BOUNDARY: {
  FIRST_TURN: string;
  AGENT: string;
  CONSTRAINT: string;
  COMPACTED: string;
  USER: string;
};

export interface CrossesInput {
  hasRoutedModel?: boolean;
  agent?: string;
  previousAgent?: string;
  contextTokens?: number;
  incumbentContextLimit?: number;
  requiredModalities?: string[];
  incumbentModalities?: string[];
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
  incumbent?: object | null;
  ranked?: object[];
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
