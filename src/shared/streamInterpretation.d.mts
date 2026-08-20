// streamInterpretation.d.mts — hand-written types for streamInterpretation.mjs.
// Mirrors the signatures that used to live in src/renderer/chatUtils.ts so the
// renderer's type imports (`import type { TruncationKind } from "./chatUtils"`)
// resolve after the re-export.

export const ASSUMED_CONTEXT_TOKENS: number;

export function resolveContextLimit(
  model: { limit?: { context?: number | null } } | null | undefined,
): number | null;

export type TruncationKind = "output-cap" | "context-wall" | "tool-cutoff";

export function classifyFinish(
  finish: string | null | undefined,
  opts?: { lastPartIsToolUse?: boolean },
): TruncationKind | null;

export function describeTruncation(kind: TruncationKind): {
  label: string;
  hint: string;
};

/** Unwrap the human sentence from a provider rejection body
 *  (`<reason phrase>: <JSON>`), or return the input unchanged. Lossless. */
export function humanizeProviderError(raw: string): string;

/** Map a provider error message's leading HTTP reason phrase to a status
 *  code, or null when the phrase isn't in the closed table (BET-1230). */
export function providerErrorStatus(message: string | null | undefined): number | null;

/** Enrich a `session.error` `properties.error` with `httpStatus` /
 *  `retryAfterMs`, preserving `name` / `data.message`. Returns the same
 *  reference when nothing is resolvable. */
export function enrichProviderError(
  error: Record<string, any> | null | undefined,
  retryAfterMs?: number,
): Record<string, any>;

export function findFlushBoundary(buffer: string): number;

/** Max time a chunk may be withheld before the caller flushes at the latest
 *  safe cut (BET-649). */
export const FLUSH_MAX_AGE_MS: number;

/** Whether `prefix` ends outside every markdown construct that would render
 *  wrong if split there (inline code, link, bold). Conservative. */
export function isSafeCut(prefix: string): boolean;

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
  pct: number | null;
  hasLimit: boolean;
  segments: { kind: ContextSegment; pct: number }[];
};

export function computeContextBreakdown(
  tokens: { input?: number; cache?: { read?: number; write?: number } } | null | undefined,
  limit: number | null,
): ContextBreakdown;

export function selectLatestTokenUsage(
  messages: unknown,
): { tokens: Record<string, unknown>; providerID: string | null; modelID: string | null } | null;

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

// The permission record is the whole `properties` object — the same wire shape
// `opencode:permissions` returns (`{ id: "perm_…", sessionID, prompt, … }`).
export type PermissionLike = Record<string, unknown>;

export function applyPermissionEvent(
  prev: PermissionLike[] | undefined,
  eventType: string,
  properties: Record<string, unknown> | undefined,
  viewedSessionId: string,
): PermissionLike[];

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
  background: boolean;
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
