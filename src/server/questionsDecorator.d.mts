export type PlanView = { title: string; text: string; steps: number; files: number; path: string | null; pageUrl: string | null };
export function firstHeading(text: string): string | null;
export function planMetrics(text: string): { steps: number; files: number };
export function planForQuestion(a: { question: unknown; messages: unknown[]; sessionId: string; baseUrl: string | null }): PlanView | null;
export function isPlanExitQuestion(q: unknown): boolean;
export function createQuestionsDecorator(d: {
  publish: (evt: unknown) => void;
  listMessages: (sessionId: string) => Promise<unknown[]>;
  baseUrl: () => string | null;
  now?: () => number;
  warn?: (msg: string, err?: unknown) => void;
}): {
  publish(evt: unknown): void;
  decorate(sessionId: string, questions: unknown[]): Promise<unknown[]>;
  decorateSnapshot(frames: unknown[]): unknown[];
  _state: { cache: Map<string, unknown>; seq: Map<string, number>; latest: Map<string, unknown[]> };
};
