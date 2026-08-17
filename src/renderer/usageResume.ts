// ===== Resume after limit reset — pure logic =====
//
// The UI-side arithmetic for the "resume after a provider limit reset"
// feature (BET-1049): the sidebar pill count, the per-row markers, and the
// resume modal. Everything computable lives here as a pure function so it is
// unit-testable without React; the components (Sidebar + the resume modal)
// are thin renders over these.
//
// The single source of truth is the box-side stopped record
// (src/server/stoppedStore.mjs, BET-1047) — this module only derives display
// values, never the record itself. Cost and reset-time additionally read the
// usage snapshots (src/server/usage.mjs) to know a provider window's reset
// instant and whether the prompt cache will still be warm.
//
// No design decisions here beyond what the spec dictates: the model chip is
// display-only, cost is "warm → 0, else the tokens re-read", the "new" badge
// is the stoppedAt-vs-lastLooked boundary, a pending question/permission
// outranks the stopped marker, and the pill counts only conversations still
// asking for a decision (not yet armed).

import type { OpencodeMessage, StoppedRecord, UsageSnapshot } from "../shared/types";

/** The conversation currently being asked to decide (not yet armed). */
export function unarmedStoppedCount(records: StoppedRecord[]): number {
  return records.filter((r) => r.armed !== true).length;
}

/**
 * Best-effort "last activity" snippet for a stopped conversation's row: the
 * tail of the most recent assistant message's text, single-line-truncated.
 * Returns null when there is no assistant text to show. Display-only — the
 * record carries no snippet, so this is derived from the transcript on open.
 */
export function extractLastSnippet(messages: readonly OpencodeMessage[] | null | undefined): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info.role !== "assistant") continue;
    const text = (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string" && p.text)
      .map((p) => (p.text as string))
      .join(" ")
      .trim();
    if (!text) continue;
    return text.length > 90 ? text.slice(0, 90).trimEnd() + "…" : text;
  }
  return null;
}

/**
 * The reset instant a stopped record waits on, from the usage snapshots:
 * the window of that record's provider whose `kind` matches its `window`.
 * Returns undefined when the provider/window isn't reporting a reset (the
 * refusal named no window, or the snapshot is missing) — callers then treat
 * the cost as cold and render no reset clause.
 */
export function resetAtFor(
  record: StoppedRecord,
  snapshots: readonly UsageSnapshot[] | null | undefined,
): number | undefined {
  const snap = (snapshots ?? []).find((s) => s.provider === record.provider);
  if (!snap || !record.window) return undefined;
  const win = snap.windows.find((w) => w.kind === record.window);
  return win?.resetsAt;
}

/**
 * The cold-cache cost of resuming `record`: ZERO when the reset falls inside
 * the prompt-cache window (the cached prefix is still warm, nothing is
 * re-read), otherwise the cached-token count that must be re-read. An unknown
 * reset is treated as cold (we cannot claim it is warm). Uses the ttlMs from
 * selectCacheTtlMs — do not re-derive the cache rule here.
 */
export function resumeCost(
  record: StoppedRecord,
  resetsAt: number | undefined,
  nowMs: number,
  ttlMs: number,
): number {
  if (resetsAt == null) return record.cachedTokens ?? 0;
  if (resetsAt - nowMs <= ttlMs) return 0;
  return record.cachedTokens ?? 0;
}

/** conversation → cost, prepared once per render for the selection totals. */
export function resumeCosts(
  records: StoppedRecord[],
  snapshots: readonly UsageSnapshot[] | null | undefined,
  nowMs: number,
  ttlMs: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of records ?? []) {
    out.set(r.conversation, resumeCost(r, resetAtFor(r, snapshots), nowMs, ttlMs));
  }
  return out;
}

/**
 * The modal footer / tools arithmetic over a `selected` set of conversation
 * ids: how many are selected, the batch token total of the selected rows, and
 * whether the selection is complete (drives the Check-all / Uncheck-all
 * toggle). `costs` comes from `resumeCosts`.
 */
export function selectionSummary(
  records: StoppedRecord[],
  selected: ReadonlySet<string>,
  costs: ReadonlyMap<string, number>,
): { totalCount: number; selectedCount: number; batchTotal: number; allSelected: boolean } {
  let selectedCount = 0;
  let batchTotal = 0;
  for (const r of records ?? []) {
    if (selected.has(r.conversation)) {
      selectedCount += 1;
      batchTotal += costs.get(r.conversation) ?? 0;
    }
  }
  const totalCount = records?.length ?? 0;
  return { totalCount, selectedCount, batchTotal, allSelected: totalCount > 0 && selectedCount === totalCount };
}

/**
 * "New" badge boundary: a conversation is new since you last looked when it
 * stopped after the modal's `lastLooked` stamp — or when the stamp doesn't
 * exist yet (fresh record, everything is new on first open). null lastLooked
 * means "never looked".
 */
export function isNewStopped(record: StoppedRecord, lastLooked: number | null): boolean {
  return lastLooked == null || record.stoppedAt > lastLooked;
}

/**
 * Marker precedence on the sidebar row: a stopped conversation that ALSO
 * holds a pending question or permission request shows the question/permission
 * state (it blocks on the user right now), NOT the stopped marker (that waits
 * on a clock). So the stopped marker renders only when the conversation is
 * stopped AND has no higher-urgency pending block.
 */
export function shouldShowStoppedMarker(
  isStopped: boolean,
  hasPendingQuestionOrPermission: boolean,
): boolean {
  return isStopped && !hasPendingQuestionOrPermission;
}

/**
 * Group the stopped records by workspace for the modal, each workspace's rows
 * ordered most-recently-stopped first. Workspace order follows first
 * appearance in the record.
 */
export function groupStoppedByWorkspace(
  records: StoppedRecord[],
): { workspace: string; rows: StoppedRecord[] }[] {
  const order: string[] = [];
  const byWs = new Map<string, StoppedRecord[]>();
  for (const r of records ?? []) {
    const ws = r.workspace || "—";
    if (!byWs.has(ws)) { byWs.set(ws, []); order.push(ws); }
    byWs.get(ws)!.push(r);
  }
  return order.map((ws) => ({
    workspace: ws,
    rows: (byWs.get(ws) ?? []).slice().sort((a, b) => b.stoppedAt - a.stoppedAt),
  }));
}
