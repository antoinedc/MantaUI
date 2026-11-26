// ===== Agent screens — pure view logic (agent screens spec §2.1, §2.2, §5.2) =====
//
// Everything the Fleet page and the agent profile decide that has no DOM in it: which page is showing, how a fleet cell
// reads, what a history row says, whether Restore is offered, how a tab key moves. The components stay thin.

import type { AgentChange, AgentFleet, AgentProfile, FleetCell, NeedsYouReview, UsageSnapshot } from "../../shared/types";
import type { BackgroundResultPart } from "../backgroundRun";
import { PACKAGE_AGENT_PREFIX } from "../agentDispatch";
import { agentChangeTitle } from "../agentChange";

// ---- constants (contract §Constants) ----

export const FLEET_REFETCH_DEBOUNCE_MS = 1000;
export const HISTORY_LIMIT = 50;
export const OVERVIEW_PREVIEW = { research: 4, history: 3 } as const;
export const SEAT_BRIEF_MAX = 4000;

// ---- which page is showing ----

/** null = closed. "needs" is the Needs you row: the Fleet page, scrolled to its first section. */
export type AgentsView = null | { page: "fleet"; focus?: "needs" } | { page: "profile"; slug: string };

export type ProfileTab = "overview" | "research" | "seats" | "history";
export const PROFILE_TABS: ReadonlyArray<{ id: ProfileTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "research", label: "Research" },
  { id: "seats", label: "Seats" },
  { id: "history", label: "History" },
];

/** The tab a key press moves to (arrows wrap, Home / End jump); null for any other key. Selection follows focus. */
export function nextTab(current: ProfileTab, key: string, ids: ReadonlyArray<ProfileTab>): ProfileTab | null {
  const at = ids.indexOf(current);
  if (at < 0 || ids.length === 0) return null;
  if (key === "ArrowRight") return ids[(at + 1) % ids.length];
  if (key === "ArrowLeft") return ids[(at - 1 + ids.length) % ids.length];
  if (key === "Home") return ids[0];
  if (key === "End") return ids[ids.length - 1];
  return null;
}

// ---- errors ----

/** What an older box answers for a channel it doesn't have (src/server/rpc.mjs). */
export const isUnknownChannel = (e: unknown): boolean => /unknown rpc channel/i.test(String((e as Error)?.message ?? e ?? ""));

export const errText = (e: unknown, fallback = "Something went wrong."): string => String((e as Error)?.message ?? e ?? "").trim() || fallback;

// ---- text ----

/** The first non-empty line, trimmed ("" when there is none). */
export function firstLine(text: string | null | undefined): string {
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** "12 Nov". */
export function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// ---- Fleet ----

/** The highest percentage of the plan windows in force right now (what the composer's dial calls usage); null when unknown. */
export function planUsagePercent(snapshots: ReadonlyArray<UsageSnapshot> | null | undefined): number | null {
  let top: number | null = null;
  for (const snap of snapshots ?? []) {
    for (const w of snap.windows ?? []) {
      if (w.active === false || !Number.isFinite(w.pct)) continue;
      if (top === null || w.pct > top) top = w.pct;
    }
  }
  return top === null ? null : Math.round(top);
}

/** "This week: 41 tasks · plan usage 38%" — the task count, and the plan usage when known. No dollars. */
export function weekPill(tasks: number, planPct: number | null): string {
  const base = `This week: ${tasks} ${tasks === 1 ? "task" : "tasks"}`;
  return planPct == null ? base : `${base} · plan usage ${planPct}%`;
}

export type CellTone = "running" | "warn" | "ok" | "error" | "idle";
export type CellView = { kind: "none" } | { kind: "cell"; title: string; line: string; tone: CellTone; openable: boolean };

/** One grid cell: "—" with no seat, else the task's title and its state line. */
export function cellView(cell: FleetCell | null | undefined): CellView {
  if (!cell) return { kind: "none" };
  const detail = (cell.detail ?? "").trim();
  const withDetail = (label: string) => (detail ? `${label} · ${detail}` : label);
  switch (cell.state) {
    case "working":
      return { kind: "cell", title: cell.title, line: withDetail("Working"), tone: "running", openable: !!cell.jobId };
    case "needs-you":
      return { kind: "cell", title: cell.title, line: withDetail("Needs you"), tone: "warn", openable: !!cell.jobId };
    case "done":
      return { kind: "cell", title: cell.title, line: withDetail("Done"), tone: "ok", openable: !!cell.jobId };
    case "failed":
      return { kind: "cell", title: cell.title, line: withDetail("Failed"), tone: "error", openable: !!cell.jobId };
    default:
      return { kind: "cell", title: cell.title || "Idle", line: detail || "Idle", tone: "idle", openable: false };
  }
}

/** "Since yesterday 18:40:" — the recap's lead-in; with no earlier visit on record it covers the last day. */
export function recapLead(since: number | null, now: number): string {
  if (since == null) return "In the last 24 hours:";
  const at = new Date(since);
  const clock = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const gap = Math.round((day(new Date(now)) - day(at)) / 86_400_000);
  const when = gap <= 0 ? "today" : gap === 1 ? "yesterday" : dateLabel(since);
  return `Since ${when} ${clock}:`;
}

/** Rows of the grid worth drawing at all: a fleet with no agents says so instead. */
export const hasFleetRows = (fleet: AgentFleet | null | undefined): boolean => (fleet?.rows.length ?? 0) > 0;

/** The part the finished-task card is fed with from a Needs-you review item (spec §2.1). No `sessionID`: no chat to open a panel in. */
export function reviewPart(r: NeedsYouReview): BackgroundResultPart {
  return {
    type: "background-result",
    id: `review-${r.jobId}`,
    messageID: "",
    childSessionId: r.jobId,
    jobId: r.jobId,
    state: "done",
    name: r.name,
    agent: `${PACKAGE_AGENT_PREFIX}${r.agentSlug}`,
    text: r.resultText,
  };
}

// ---- Profile ----

const BUILT_BY: Record<AgentProfile["builtBy"], string> = {
  architect: "built by Architect",
  manta: "built by Manta",
  user: "built by you",
  "built-in": "built in",
};

/** The profile header's facts: built by, last changed, model, isolation. */
export function factsLine(profile: AgentProfile): string[] {
  const facts = [BUILT_BY[profile.builtBy] ?? "built by you"];
  if (profile.lastChangedAt != null) facts.push(`last changed ${dateLabel(profile.lastChangedAt)}`);
  facts.push(`model: ${profile.info.model || "Auto"}`);
  facts.push(profile.info.isolation === "worktree" ? "edits code on its own branch" : "read-only");
  return facts;
}

export const seatNotesLabel = (notes: number | null): string => (notes == null ? "—" : `${notes} ${notes === 1 ? "note" : "notes"}`);

export function memoryLabel(access: "read" | "read-write" | "none"): string {
  return access === "read-write" ? "read + write" : access === "read" ? "read-only" : "no access";
}

// ---- History (spec §5.2) ----

/** Who made the change: Manta (chat, "for you"), the Architect (a task) or the user (a restore). */
export function historyWho(change: Pick<AgentChange, "origin">): string {
  if (change.origin.kind === "job") return "Architect";
  if (change.origin.kind === "restore") return "You";
  return "Manta · for you";
}

/** The row's outcome line: what became of the change. An undone row says so, and who undid it when known. */
export function historyOutcome(change: Pick<AgentChange, "state" | "decidedBy" | "error">): string {
  switch (change.state) {
    case "applied":
      return change.decidedBy === "click" ? "Live (you approved it)" : "Live (applied automatically)";
    case "undone":
      return change.decidedBy === "click" ? "Undone by you" : "Undone";
    case "pending":
      return "Waiting for your click";
    case "held":
      return "Waiting for the Architect to finish";
    case "applying":
      return "Applying…";
    case "discarded":
      return "Discarded";
    case "expired":
      return "Expired";
    case "conflict":
      return change.error ? `Not applied: ${change.error}` : "Not applied";
    case "failed":
      return "Not activated";
  }
}

/** What the row calls the change: the box's one-line summary, else the card's own title. */
export const historySummary = (change: Pick<AgentChange, "summary" | "kind" | "agentName">): string => firstLine(change.summary) || agentChangeTitle(change);

/**
 * The agent file as it stands, read from the records alone: the `after` of the latest applied change, or the `before` of a
 * later undo. Hand edits are not in the history, so this is a best guess; the box is the judge and says "Already at that version".
 */
export function currentSnapshot(history: ReadonlyArray<AgentChange>): string | null {
  let best: { at: number; text: string | null } | null = null;
  for (const r of history) {
    if (r.state !== "applied" && r.state !== "undone") continue;
    const at = r.decidedAt ?? r.createdAt;
    if (best && at <= best.at) continue;
    best = { at, text: r.state === "applied" ? r.after : r.before };
  }
  return best?.text ?? null;
}

/** "Restore before this" is offered on an applied or undone update, only where restoring would change something. */
export function canRestore(change: Pick<AgentChange, "kind" | "state" | "before">, current: string | null): boolean {
  if (change.kind !== "update" || change.before == null) return false;
  if (change.state !== "applied" && change.state !== "undone") return false;
  return current == null || change.before !== current;
}
