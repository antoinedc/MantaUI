// ===== Auto-handoff — pure logic (spec 2026-10-26-auto-handoff.md) =====
//
// Everything the handoff UI decides, with no React and no I/O: the tool-marker
// parse, the state → badge map, which records pin above the composer, whether a
// bus event switches the pane, the composer carry-over merge, the draft-load
// gate and the "Previous sessions" list. The components in HandoffParts.tsx and
// the glue in hooks/useHandoffPanel.ts only wire these to the DOM / the box, so
// each rule has one tested home (the same split chatUtils.ts uses).

import type {
  HandoffContinuation,
  HandoffEventPayload,
  HandoffMode,
  HandoffRecord,
  HandoffState,
} from "../shared/api";
import type { OpencodeMessage, OpencodePart } from "../shared/types";
import type { Attachment } from "./chatShared";

// ---------------------------------------------------------------------------
// Tool marker (§15): the `handoff` tool's output ends with
// `<!-- manta-handoff:<id> -->`. The id is the only thing the card needs; the
// rest of the output is the model-facing status line, which the card replaces.
// ---------------------------------------------------------------------------

export const HANDOFF_MARKER_RE = /<!-- manta-handoff:([A-Za-z0-9_-]+) -->/;

/** The record id from a tool output, and the output with the marker line removed. */
export function parseHandoffMarker(output: string | null | undefined): { id: string | null; text: string } {
  const raw = output ?? "";
  const m = HANDOFF_MARKER_RE.exec(raw);
  if (!m) return { id: null, text: raw.trim() };
  const text = raw
    .split("\n")
    .filter((line) => !HANDOFF_MARKER_RE.test(line))
    .join("\n")
    .trim();
  return { id: m[1], text };
}

const HANDOFF_TOOL_RE = /^(?:manta[_-])?handoff$/i;

/** A transcript part is the agent-path `handoff` tool call. */
export function isHandoffToolPart(part: OpencodePart): boolean {
  if (part.type !== "tool") return false;
  return HANDOFF_TOOL_RE.test(String((part as Record<string, unknown>).tool ?? ""));
}

/** The record id carried by a `handoff` tool part's output, or null before the tool finished. */
export function handoffIdOfPart(part: OpencodePart): string | null {
  const state = ((part as Record<string, unknown>).state ?? {}) as { output?: unknown };
  return typeof state.output === "string" ? parseHandoffMarker(state.output).id : null;
}

// ---------------------------------------------------------------------------
// Card state
// ---------------------------------------------------------------------------

export type HandoffBadgeTone = "neutral" | "accent" | "warn" | "ok" | "danger";
export interface HandoffBadge {
  label: string;
  tone: HandoffBadgeTone;
}

/** The state badge on the card header (§3): preparing / ready / starting / started / failed. */
export function handoffBadge(state: HandoffState): HandoffBadge {
  switch (state) {
    case "requested":
    case "generating":
      return { label: "preparing", tone: "neutral" };
    case "ready":
      return { label: "ready", tone: "ok" };
    case "starting":
      return { label: "starting", tone: "accent" };
    case "committed":
      return { label: "started", tone: "ok" };
    case "failed":
      return { label: "failed", tone: "danger" };
    case "cancelled":
      return { label: "cancelled", tone: "neutral" };
    case "dismissed":
      return { label: "dismissed", tone: "neutral" };
  }
}

/** Card actions are live only while the record is `ready` (§3); after a start they are off on every client. */
export function handoffActionsEnabled(record: Pick<HandoffRecord, "state">): boolean {
  return record.state === "ready";
}

/** Only a card the user can still act on can be dismissed (the box refuses any other state). */
export function handoffCanDismiss(record: Pick<HandoffRecord, "state">): boolean {
  return record.state === "ready" || record.state === "failed";
}

/** "agent" · "automatic" · "/handoff" · "button" — the card's source label. */
export function describeHandoffSource(record: Pick<HandoffRecord, "trigger" | "kind">): string {
  switch (record.trigger) {
    case "agent":
      return "agent";
    case "user":
      return "/handoff";
    case "button":
      return "Hand off button";
    default:
      return record.kind === "auto" ? "automatic" : String(record.trigger || "server");
  }
}

// ---------------------------------------------------------------------------
// Pinned records (§15 "Card placement")
// ---------------------------------------------------------------------------

// A `dismissed` record is terminal and is never pinned.
const PINNED_STATES: ReadonlySet<HandoffState> = new Set([
  "requested",
  "generating",
  "ready",
  "starting",
  "failed",
]);

/**
 * The server-path records to pin above `sessionId`'s composer. Agent-path records
 * live in the transcript as the tool part, never here. Only the NEWEST non-agent
 * record from this session can pin: an older `ready` card sitting under a newer
 * handoff (started, or just asked for) could only 409 when pressed.
 * `preparing` is pinned too so a `/handoff` shows progress while the box writes it.
 */
export function selectPinnedHandoffs(records: readonly HandoffRecord[], sessionId: string): HandoffRecord[] {
  const mine = records.filter((r) => r.fromSessionId === sessionId && r.trigger !== "agent");
  if (mine.length === 0) return [];
  const newest = mine.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
  return PINNED_STATES.has(newest.state) ? [newest] : [];
}

// ---------------------------------------------------------------------------
// Client reconciliation (§6.4)
// ---------------------------------------------------------------------------

/**
 * Does this bus event move the pane showing `displayedSessionId`? A committed
 * REPLACEMENT does, for any client showing the predecessor. A BRANCH never does
 * from an event — only the initiating client switches, and it learns that from
 * its own start call.
 */
export function shouldSwitchPane(
  displayedSessionId: string,
  ev: Pick<HandoffEventPayload, "fromSessionId" | "successorId" | "state" | "how">,
): boolean {
  return (
    ev.state === "committed" &&
    ev.how === "clear" &&
    !!ev.successorId &&
    ev.fromSessionId === displayedSessionId
  );
}

/** A record, as the bus event that would have announced it. */
export function eventOfRecord(r: HandoffRecord): HandoffEventPayload {
  return {
    id: r.id,
    fromSessionId: r.fromSessionId,
    successorId: r.successorId,
    state: r.state,
    how: r.how,
    disposition: r.disposition,
  };
}

// ---------------------------------------------------------------------------
// Composer carry-over (§8) and draft consumption (§7)
// ---------------------------------------------------------------------------

/** Put `incoming` BELOW `existing` (never overwriting it), separated by a blank line. */
export function appendBelow(existing: string, incoming: string): string {
  if (!incoming.trim()) return existing;
  if (!existing.trim()) return incoming;
  return `${existing.replace(/\s+$/, "")}\n\n${incoming}`;
}

/** A handoff `draft` goes ABOVE whatever the user already typed/carried, which stays below it. */
export function placeDraft(draft: string, composerText: string): string {
  return appendBelow(draft, composerText);
}

/** Only uploaded chips travel; an upload still in flight belongs to the pane that is going away. */
export function carriableAttachments(attachments: readonly Attachment[]): Attachment[] {
  return attachments.filter((a) => a.status === "ready" && !!a.remotePath);
}

export interface CarriedComposer {
  text: string;
  attachments: Attachment[];
}

export function isEmptyCarry(c: CarriedComposer | null | undefined): boolean {
  return !c || (!c.text.trim() && c.attachments.length === 0);
}

/**
 * Should this client load the continuation's `draft` into the composer? Only
 * an unconsumed revision it has not already loaded (`lastLoaded` is this
 * client's own record; the box may also say it was consumed).
 */
export function shouldLoadDraft(
  continuation: HandoffContinuation | null | undefined,
  lastLoadedRevision: number | null,
): boolean {
  if (!continuation) return false;
  if (typeof continuation.draft !== "string" || continuation.draft.trim() === "") return false;
  if (typeof continuation.draftRevision !== "number") return false;
  if (continuation.draftConsumed === true) return false;
  return lastLoadedRevision == null || continuation.draftRevision > lastLoadedRevision;
}

/** The record the draft belongs to (the one whose start put it in this session's composer). */
export function draftRecordFor(records: readonly HandoffRecord[], sessionId: string): HandoffRecord | null {
  const mine = records.filter((r) => r.successorId === sessionId && r.disposition === "draft");
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}

// ---------------------------------------------------------------------------
// Mode control (§9)
// ---------------------------------------------------------------------------

export const HANDOFF_MODES: readonly HandoffMode[] = ["auto", "suggest", "off"];

/** The box default is "suggest": anything unparseable or absent (an older box) means that. */
export function normalizeHandoffMode(v: unknown): HandoffMode {
  return v === "suggest" || v === "off" || v === "auto" ? v : "suggest";
}

/** Click cycles auto → suggest → off → auto. */
export function nextHandoffMode(mode: HandoffMode): HandoffMode {
  return HANDOFF_MODES[(HANDOFF_MODES.indexOf(mode) + 1) % HANDOFF_MODES.length];
}

export function describeHandoffMode(mode: HandoffMode): string {
  switch (mode) {
    case "auto":
      return "Handoff: auto — this conversation hands off to a fresh session on its own when it gets long. Applies to this conversation only. Click to switch to suggest.";
    case "suggest":
      return "Handoff: suggest — when this conversation gets long it shows a handoff card for you to start. Applies to this conversation only. Click to switch to off.";
    case "off":
      return "Handoff: off — nothing is automatic in this conversation; /handoff still works. Applies to this conversation only. Click to switch to auto.";
  }
}

// ---------------------------------------------------------------------------
// Errors (§11: 409 already_started / busy, 422 not_ready, 404 expired)
// ---------------------------------------------------------------------------

/** User-facing wording for a failed handoff rpc. The box's codes arrive as the error message. */
export function describeHandoffError(e: unknown): string {
  const raw = String((e as Error)?.message ?? e ?? "");
  if (/already_started/i.test(raw)) return "This handoff was already started.";
  if (/\bbusy\b/i.test(raw)) return "The session is busy — wait for it to finish, then try again.";
  if (/not_ready/i.test(raw)) return "This handoff isn't ready yet.";
  if (/expired|not.?found|\b404\b/i.test(raw)) return "This handoff has expired.";
  if (raw.trim() === "dismissed") return "Handoff suggestions were dismissed in this conversation.";
  return raw || "Something went wrong.";
}

// ---------------------------------------------------------------------------
// Continuation notice + Previous sessions (§9)
// ---------------------------------------------------------------------------

/** 182340 → "182k". */
export function formatHandoffTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}k`;
}

/** The predecessor's context size at handoff: the newest assistant message's total input. */
export function contextTokensOfMessages(messages: readonly OpencodeMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info;
    if (info.role !== "assistant" || !info.tokens) continue;
    const t = info.tokens;
    const total = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    if (total > 0) return total;
  }
  return null;
}

export interface ContinuationNotice {
  predecessorId: string;
  title: string | null;
  tokens: number | null;
}

/** "Continued from <title> — handed off at 182k tokens · View previous". */
export function describeContinuationNotice(n: ContinuationNotice): string {
  const from = n.title ? `“${n.title}”` : "the previous session";
  const at = n.tokens != null ? ` — handed off at ${formatHandoffTokens(n.tokens)} tokens` : "";
  return `Continued from ${from}${at}`;
}

export interface PreviousSessionEntry {
  id: string;
  /** "previous" = a replaced predecessor; "branched-from" = the session this one was branched off. */
  kind: "previous" | "branched-from";
  /** When the handoff happened — the list is newest first. */
  at: number;
  title: string | null;
}

export function previousEntryLabel(e: PreviousSessionEntry): string {
  const name = e.title || "Untitled session";
  return e.kind === "branched-from" ? `Branched from ${name}` : name;
}

/**
 * The "Previous sessions" list: the replacement chain walked backwards from the
 * displayed session, plus where it was branched from, newest first. `links` is
 * each hop's `replaces`/`branchedFrom` plus when that handoff ran.
 */
export function buildPreviousEntries(
  hops: ReadonlyArray<{ id: string; kind: PreviousSessionEntry["kind"]; at: number }>,
  titles: Readonly<Record<string, string | undefined>>,
): PreviousSessionEntry[] {
  const seen = new Set<string>();
  const out: PreviousSessionEntry[] = [];
  for (const h of hops) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push({ id: h.id, kind: h.kind, at: h.at, title: titles[h.id]?.trim() || null });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The committed record that created `sessionId` (as replacement successor or branch). */
export function creatingRecord(records: readonly HandoffRecord[], sessionId: string): HandoffRecord | null {
  const mine = records.filter((r) => r.successorId === sessionId && r.state === "committed");
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}
