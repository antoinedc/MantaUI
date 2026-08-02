// streamInterpretation.d.mts — hand-written types for streamInterpretation.mjs.
// Mirrors the signatures that used to live in src/renderer/chatUtils.ts so the
// renderer's type imports (`import type { TruncationKind } from "./chatUtils"`)
// resolve after the re-export.

export const ASSUMED_CONTEXT_TOKENS: number;

export function resolveContextLimit(
  model: { limit?: { context?: number } } | null | undefined,
): number;

export type TruncationKind = "output-cap" | "context-wall" | "tool-cutoff";

export function classifyFinish(
  finish: string | null | undefined,
  opts?: { lastPartIsToolUse?: boolean },
): TruncationKind | null;

export function describeTruncation(kind: TruncationKind): {
  label: string;
  hint: string;
};

export function findFlushBoundary(buffer: string): number;

export type PendingDelta = {
  messageID: string;
  field: string;
  text: string;
};

export function mergeBufferedDeltas<
  M extends { info: { id: string }; parts: Array<Record<string, unknown> & { id: string }> },
>(
  messages: M[] | null | undefined,
  buffer: Map<string, PendingDelta>,
): { messages: M[] | null | undefined; unmatched: string[] };

export function selectCacheTtlMs(ttl: "5m" | "1h"): number;

export function classifyCacheAge(
  lastMessageAt: number,
  now: number,
  ttlMs: number,
): "fresh" | "aging" | "stale";

export function selectLastAssistantCompletion(
  messages:
    | Array<{
        info: { role: string; time?: { completed?: number; [k: string]: unknown } };
      }>
    | null
    | undefined,
): number | null;

export const STALE_CACHE_MIN_TOKENS: number;

export type StaleCacheResult = {
  isStale: boolean;
  idleMs: number;
  staleTokens: number;
  ttlMs: number;
};

export function computeStaleCache(input: {
  lastCompleted: number | null;
  now: number;
  ttlMs: number;
  cachedTokens: number;
  minCacheTokens?: number;
  running?: boolean;
}): StaleCacheResult;

export type ContextSegment = "fresh" | "cacheRead" | "cacheWrite";

export type ContextBreakdown = {
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  totalInput: number;
  pct: number;
  segments: { kind: ContextSegment; pct: number }[];
};

export function computeContextBreakdown(
  tokens: { input?: number; cache?: { read?: number; write?: number } } | null | undefined,
  limit: number,
): ContextBreakdown;

export function isTerminalTodo(t: Record<string, unknown>): boolean;

export function allTodosTerminal(todos: Array<Record<string, unknown>>): boolean;

export function selectActiveTodos(
  liveTodos: Array<Record<string, unknown>> | null | undefined,
  transcriptTodos: Array<Record<string, unknown>> | null | undefined,
  dismissed: boolean,
): Array<Record<string, unknown>> | null;

export const VISIBLE_TODOS_CAP: number;

export function selectVisibleTodos(
  todos: Array<Record<string, unknown>>,
  cap?: number,
): {
  visible: Array<Record<string, unknown>>;
  hiddenPending: number;
  hiddenDone: number;
};

export function isSelfFilteringLifecycleEvent(type: string): boolean;

export function registerChildSessionFromCreated(
  ev: FilterEvent,
  viewedSessionId: string,
  childSessionIds: Set<string>,
): boolean;

export function shouldDropEventForSessionFilter(
  ev: FilterEvent,
  viewedSessionId: string,
  childSessionIds: Set<string>,
): boolean;

export type QuestionLike = {
  id: string;
  sessionID: string;
  questions: unknown[];
  tool?: { messageID: string; callID: string };
  requestId?: string;
};

export function applyQuestionEvent(
  prev: QuestionLike[],
  eventType: string,
  properties: Record<string, unknown> | undefined,
  viewedSessionId: string,
): QuestionLike[];

export function hydrateQuestion(server: {
  id: string;
  sessionID: string;
  questions: unknown[];
  tool?: { messageID: string; callID: string };
}): QuestionLike;

export function isAssistantTurnComplete(messages: AssistantTurnMessage[] | null | undefined): boolean;

export type SubagentInfo = {
  childSessionId: string;
  agent: string;
  description: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "error" | "unknown";
  title: string | null;
  output: string | null;
  truncated: boolean;
  durationMs: number | null;
  model: { providerID: string; modelID: string } | null;
};

export function extractSubagentInfo(part: SubagentPart): SubagentInfo | null;

export function collectChildSessionIds(messages: SubagentMessage[] | null | undefined): Set<string>;

export function countRunningSubagents(
  messages: SubagentMessage[] | null | undefined,
  liveStatus?: Map<string, "running" | "idle"> | null,
): number;

export function summarizeChildSession(
  messages: SubagentMessage[] | null | undefined,
): { toolCount: number; lastToolName: string | null; tokens: number };

export function isAssistantTurnInProgress(messages: AssistantTurnMessage[] | null | undefined): boolean;

export const AUTO_RENAME_EVERY_N_TURNS: number;

export function shouldAutoRename(userTurnCount: number, everyN?: number): boolean;

export function countUserTurns(
  messages: { info: { role: string }; parts: OpencodePartLike[] }[] | null,
): number;

export function buildTitlePromptInput(
  messages: { info: { role: string }; parts: OpencodePartLike[] }[] | null,
): string;

export function sanitizeGeneratedTitle(raw: string | null | undefined): string;

export function buildTitleInstruction(conversation: string): string;

// ── Non-exported structural types (used by the signatures above) ──

export type FilterEvent = {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { id?: string; parentID?: string };
    [k: string]: unknown;
  };
};

type AssistantTurnMessage = {
  info: { role: string; time?: { completed?: number; [k: string]: unknown } };
};

type OpencodePartLike = {
  type: string;
  text?: string;
  synthetic?: boolean;
  ignored?: boolean;
};

type SubagentPart = {
  type?: string;
  tool?: string;
  state?: {
    status?: string;
    title?: string;
    output?: string;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    time?: { start?: number; end?: number };
  };
  tokens?: { input?: number; output?: number };
};

type SubagentMessage = { parts?: SubagentPart[] };
