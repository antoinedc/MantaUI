export const MAX_CONSTRAINTS: number;
export const MAX_CONSTRAINT_CHARS: number;
export const CONSTRAINT_EXTRACT_PROMPT: string;

export function parseConstraints(raw: unknown): string[];
export function renderConstraintBlock(constraints?: string[] | null): string;
export function buildCompactionPrompt(basePrompt: string, constraints?: string[] | null): string;
