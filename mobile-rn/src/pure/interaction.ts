// interaction.ts — pure permission + question card logic for the RN app.
//
// This is the mobile port of the desktop's permission/question handling:
//   - question answer-building + submittability  (src/renderer/chatUtils.ts:
//     buildQuestionAnswers / canSubmitQuestion — ported verbatim in contract)
//   - question card upsert/clear from live events (chatUtils.ts:
//     applyQuestionEvent, hydrateQuestion — ported)
//   - permission reply value mapping             (src/renderer/Cards.tsx:
//     PermissionCard's once/always/reject enum)
//
// The box RPC contracts these feed (see src/server/opencode.mjs):
//   opencode:permission-reply → { requestId, reply: "once"|"always"|"reject", sessionId }
//   opencode:question-reply   → { requestId, answers: string[][], sessionId }
//   opencode:question-reject  → { requestId, sessionId }
//
// Kept PURE — no RN, no fetch, no state — so the whole card decision surface is
// unit-tested without a live box, matching the other mobile-rn pure modules.

// ---- Permission ----

/** Category + scope of a pending tool-approval, as the box returns it. */
export interface PermissionVM {
  /** Canonical key: tool.callID when present, else the `per_…` id. */
  id: string;
  /** The `per_…` request id opencode's reply API requires. */
  requestId: string;
  sessionID: string;
  /** Category, e.g. "external_directory", "bash". */
  permission: string;
  /** filepath / command detail pulled from metadata, when present. */
  detail?: string;
  /** The scope "always" would grant (e.g. "/tmp/*"), when present. */
  alwaysScope?: string;
}

/** The three reply enum values opencode's /permission/{id}/reply accepts. */
export type PermissionReply = "once" | "always" | "reject";

/**
 * Map a card button action to the exact `reply` value the box RPC expects.
 * A trivial identity today, but centralized + tested so the card can't drift
 * from the API enum (the desktop hard-codes these three strings inline).
 * Pure.
 */
export function permissionReplyValue(action: PermissionReply): PermissionReply {
  return action;
}

/** Raw `/permission` list row / `permission.asked` payload (subset we read). */
interface RawPermission {
  id?: string;
  sessionID?: string;
  permission?: string;
  always?: string[];
  metadata?: Record<string, unknown> | null;
  tool?: { messageID?: string; callID?: string } | null;
}

/**
 * Normalize a raw permission (from `opencode:permissions` GET or a
 * `permission.asked` event) into the card VM. Dedup key prefers tool.callID
 * (stable across re-asks) and falls back to the `per_…` id; the `per_…` is
 * kept separately as `requestId` because opencode's reply API accepts only
 * that form. Returns null when there's no usable id.
 *
 * Mirror of the desktop hydrateQuestion + PermissionCard detail derivation.
 * Pure.
 */
export function hydratePermission(raw: RawPermission): PermissionVM | null {
  const per = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : "";
  const callID =
    typeof raw?.tool?.callID === "string" && raw.tool.callID.length > 0
      ? raw.tool.callID
      : "";
  const id = callID || per;
  if (!id || !per) return null;
  const meta = raw.metadata ?? {};
  const filepath = typeof meta.filepath === "string" ? meta.filepath : undefined;
  const command = typeof meta.command === "string" ? meta.command : undefined;
  const alwaysScope =
    Array.isArray(raw.always) && raw.always.length > 0
      ? raw.always.join(", ")
      : undefined;
  return {
    id,
    requestId: per,
    sessionID: typeof raw.sessionID === "string" ? raw.sessionID : "",
    permission: typeof raw.permission === "string" ? raw.permission : "tool",
    detail: filepath ?? command ?? undefined,
    alwaysScope,
  };
}

/**
 * Apply one permission.* lifecycle event to the pending list.
 *   - permission.asked   → upsert the request (dedupe by id)
 *   - permission.replied → remove it (answered)
 *   - permission.rejected → remove it (denied)
 * Filtered to the viewed session on `asked`. Returns the SAME reference when
 * nothing changed so callers can skip a re-render.
 *
 * Mirror of the desktop applyQuestionEvent contract for permissions. Pure.
 */
export function applyPermissionEvent(
  prev: PermissionVM[],
  eventType: string,
  properties: Record<string, unknown> | undefined,
  viewedSessionId: string,
): PermissionVM[] {
  const p = properties ?? {};

  if (eventType === "permission.replied" || eventType === "permission.rejected") {
    const tool = p.tool as { messageID?: string; callID?: string } | undefined;
    const ids = new Set(
      [p.id, p.requestID, p.callID, tool?.callID].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      ),
    );
    if (ids.size === 0) return prev;
    const next = prev.filter(
      (perm) => !ids.has(perm.id) && !ids.has(perm.requestId),
    );
    return next.length === prev.length ? prev : next;
  }

  if (eventType === "permission.asked") {
    const vm = hydratePermission(p as RawPermission);
    if (!vm) return prev;
    if (vm.sessionID !== viewedSessionId) return prev;
    const without = prev.filter((perm) => perm.id !== vm.id);
    return [...without, vm];
  }

  return prev;
}

// ---- Question ----

/** One selectable option in a question (label + description). */
export interface QuestionOptionVM {
  label: string;
  description?: string;
}

/** One question within a request. */
export interface QuestionInfoVM {
  /** Full question text. */
  question: string;
  /** Short header/label. */
  header: string;
  options: QuestionOptionVM[];
  /** Allow multi-select. */
  multiple: boolean;
}

/** A pending Question tool request (one card, possibly many questions). */
export interface QuestionVM {
  /** Canonical key: tool.callID when present, else the `que_…` id. */
  id: string;
  /** The `que_…` id opencode's reply/reject API requires. */
  requestId: string;
  sessionID: string;
  questions: QuestionInfoVM[];
}

/** Raw `/question` row / `question.asked` payload (subset we read). */
interface RawQuestion {
  id?: string;
  sessionID?: string;
  questions?: unknown;
  tool?: { messageID?: string; callID?: string } | null;
}

function normOptions(raw: unknown): QuestionOptionVM[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionOptionVM[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const label = (o as { label?: unknown }).label;
    if (typeof label !== "string" || label.length === 0) continue;
    const description = (o as { description?: unknown }).description;
    out.push({
      label,
      description: typeof description === "string" ? description : undefined,
    });
  }
  return out;
}

function normQuestionInfos(raw: unknown): QuestionInfoVM[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionInfoVM[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const question = (q as { question?: unknown }).question;
    const header = (q as { header?: unknown }).header;
    out.push({
      question: typeof question === "string" ? question : "",
      header: typeof header === "string" ? header : "",
      options: normOptions((q as { options?: unknown }).options),
      multiple: (q as { multiple?: unknown }).multiple === true,
    });
  }
  return out;
}

/**
 * Normalize a raw question (from `opencode:questions` GET or a `question.asked`
 * event) into the card VM. Dedup key prefers tool.callID; `que_…` is kept as
 * `requestId` (the only id the reply/reject API accepts). Returns null when
 * there's no usable id or no questions.
 *
 * Mirror of the desktop hydrateQuestion. Pure.
 */
export function hydrateQuestion(raw: RawQuestion): QuestionVM | null {
  const que = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : "";
  const callID =
    typeof raw?.tool?.callID === "string" && raw.tool.callID.length > 0
      ? raw.tool.callID
      : "";
  const id = callID || que;
  if (!id || !que) return null;
  const questions = normQuestionInfos(raw.questions);
  if (questions.length === 0) return null;
  return {
    id,
    requestId: que,
    sessionID: typeof raw.sessionID === "string" ? raw.sessionID : "",
    questions,
  };
}

/**
 * Apply one question.* lifecycle event to the pending list.
 *   - question.asked    → upsert the request (dedupe by id)
 *   - question.replied  → remove it (answered)
 *   - question.rejected → remove it (dismissed)
 * Filtered to the viewed session on `asked`. Returns the SAME reference when
 * nothing changed.
 *
 * Direct port of the desktop chatUtils.applyQuestionEvent. Pure.
 */
export function applyQuestionEvent(
  prev: QuestionVM[],
  eventType: string,
  properties: Record<string, unknown> | undefined,
  viewedSessionId: string,
): QuestionVM[] {
  const p = properties ?? {};
  const tool = p.tool as { messageID?: string; callID?: string } | undefined;

  if (eventType === "question.replied" || eventType === "question.rejected") {
    const ids = new Set(
      [p.id, p.requestID, p.callID, tool?.callID].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      ),
    );
    if (ids.size === 0) return prev;
    const next = prev.filter((q) => !ids.has(q.id) && !ids.has(q.requestId));
    return next.length === prev.length ? prev : next;
  }

  if (eventType === "question.asked") {
    const vm = hydrateQuestion(p as RawQuestion);
    if (!vm) return prev;
    if (vm.sessionID !== viewedSessionId) return prev;
    const without = prev.filter((q) => q.id !== vm.id);
    return [...without, vm];
  }

  return prev;
}

/**
 * Build the `string[][]` reply payload for a Question tool request from the
 * per-question selected option labels and per-question free-text input.
 *
 * Direct port of the desktop chatUtils.buildQuestionAnswers: custom text is
 * always honored and appended AFTER any selected option labels for that
 * question; a blank custom field contributes nothing. Selection-only,
 * typed-only, and selection+typed all work.
 *
 * Pure.
 */
export function buildQuestionAnswers(
  selected: Array<ReadonlySet<string>>,
  customValues: readonly string[],
): string[][] {
  return selected.map((sel, i) => {
    const labels = Array.from(sel);
    const custom = (customValues[i] ?? "").trim();
    return custom ? [...labels, custom] : labels;
  });
}

/**
 * Whether a Question request is submittable: every question must have at least
 * one selected option OR non-empty typed text.
 *
 * Direct port of the desktop chatUtils.canSubmitQuestion. Pure.
 */
export function canSubmitQuestion(
  selected: Array<ReadonlySet<string>>,
  customValues: readonly string[],
): boolean {
  return selected.every(
    (sel, i) => sel.size > 0 || (customValues[i] ?? "").trim().length > 0,
  );
}

/**
 * Toggle an option's selection for question `qIdx`, honoring single vs
 * multi-select. Returns a NEW array of NEW Sets (never mutates the input), so
 * it can drive React state directly. Mirror of the desktop QuestionCard's
 * toggleOption. Pure.
 */
export function toggleQuestionOption(
  selected: Array<ReadonlySet<string>>,
  qIdx: number,
  label: string,
  multiple: boolean,
): Array<Set<string>> {
  const next = selected.map((s) => new Set(s));
  if (qIdx < 0 || qIdx >= next.length) return next;
  if (multiple) {
    if (next[qIdx].has(label)) next[qIdx].delete(label);
    else next[qIdx].add(label);
  } else {
    next[qIdx] = new Set([label]);
  }
  return next;
}
