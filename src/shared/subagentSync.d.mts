export function deriveSubagentName(
  providerID: string,
  modelID: string,
  taken: Set<string> | string[],
): string;

export interface SubagentDefLike {
  name: string;
  model: string;
  description: string;
}

export interface ModelLike {
  providerID: string;
  id: string;
  // BET-1139: deprecated status drives the disabled-by-default opt-in gate.
  status?: string;
}

export function reconcileSubagents(input?: {
  models?: ModelLike[];
  existingAgents?: SubagentDefLike[];
  deactivated?: string[];
  optIn?: string[];
} | null): {
  upsert: SubagentDefLike[];
  remove: string[];
};
