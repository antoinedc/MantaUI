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
