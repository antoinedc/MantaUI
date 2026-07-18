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
}

export function reconcileSubagents(input?: {
  models?: ModelLike[];
  existingAgents?: SubagentDefLike[];
  deactivated?: string[];
} | null): {
  upsert: SubagentDefLike[];
  remove: string[];
};
