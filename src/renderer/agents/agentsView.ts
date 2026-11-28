// ===== Agent screens — pure view logic (agent screens spec §2.1, §2.2, §5.2) =====
//
// Everything the Fleet page and the agent profile decide that has no DOM in it: which page is showing, how a fleet cell
// reads, what a history row says, whether Restore is offered, how a tab key moves. The components stay thin.

import type { AgentChange, AgentProfile, AgentResearchEntry, FleetCell, NeedsYouReview } from "../../shared/types";
import type { BackgroundResultPart } from "../backgroundRun";
import { PACKAGE_AGENT_PREFIX, resolvePickerProject } from "../agentDispatch";
import { agentChangeTitle } from "../agentChange";
import { isUnknownChannelError } from "../chatUtils";

// ---- constants (contract §Constants) ----

export const FLEET_REFETCH_DEBOUNCE_MS = 1000;
export const HISTORY_LIMIT = 50;
export const OVERVIEW_PREVIEW = { research: 4 } as const;
export const SEAT_BRIEF_MAX = 4000;

// ---- which page is showing ----

/** null = closed. Needs you is its own page (Fleet redesign): the Fleet page, the Needs you page, or one agent's profile. */
export type AgentsView = null | { page: "fleet" } | { page: "needs" } | { page: "profile"; slug: string };

export type ProfileTab = "overview" | "research" | "seats" | "history" | "learned" | "tests";
export const PROFILE_TABS: ReadonlyArray<{ id: ProfileTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "research", label: "Research" },
  { id: "seats", label: "Seats" },
  { id: "history", label: "History" },
];
/** Architect v2 §3.4: the Tests tab, last, shown only when the agent has trial runs. */
export const TESTS_TAB: { id: ProfileTab; label: string } = { id: "tests", label: "Tests" };

/** Architect v2 §5.1: the Learned tab, before Tests: shown whenever the box sends the agent's learned rules (even none), never for the lead. */
export const LEARNED_TAB: { id: ProfileTab; label: string } = { id: "learned", label: "Learned" };

/** The tabs a profile shows: the four, plus Learned when the box sends the agent's rules, plus Tests when it sent any trial for this agent. */
export function profileTabs(profile: { trials?: ReadonlyArray<unknown>; learned?: ReadonlyArray<unknown>; info?: { role?: string } }): ReadonlyArray<{ id: ProfileTab; label: string }> {
  const learned = Array.isArray(profile.learned) && profile.info?.role !== "lead";
  return [...PROFILE_TABS, ...(learned ? [LEARNED_TAB] : []), ...((profile.trials?.length ?? 0) > 0 ? [TESTS_TAB] : [])];
}

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
export const isUnknownChannel = (e: unknown): boolean => isUnknownChannelError(String((e as Error)?.message ?? e ?? ""));

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
    ...(r.endedBlocked ? { endedBlocked: true } : {}),
  };
}

// ---- Profile ----

const BUILT_BY: Record<AgentProfile["builtBy"], string> = {
  architect: "Architect",
  manta: "Manta",
  user: "You",
  "built-in": "Built in",
};

const ROLE_LABEL: Record<AgentProfile["info"]["role"], string> = { lead: "Lead", architect: "Architect", specialist: "Specialist" };

/** The header's one line of who it is: `@seo · Specialist · 2 seats`. What the details pane says (model, works, built by) is not repeated. */
export function factsLine(profile: AgentProfile): string[] {
  const { info, seats } = profile;
  const where = info.role === "specialist" ? (seats.length === 0 ? "No seats yet" : `${seats.length} ${seats.length === 1 ? "seat" : "seats"}`) : "Works in every project";
  return [`@${info.slug}`, ROLE_LABEL[info.role] ?? "Specialist", where];
}

/** The details pane's rows `[key, value]`: model, what it does to code, who built it, when it last changed (left out when never). */
export function detailRows(profile: AgentProfile): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Model", profile.info.model || "Auto"],
    ["Works", profile.info.isolation === "worktree" ? "Edits code" : "Read-only"],
    ["Built by", BUILT_BY[profile.builtBy] ?? "You"],
  ];
  if (profile.lastChangedAt != null) rows.push(["Changed", dateLabel(profile.lastChangedAt)]);
  return rows;
}

export const seatNotesLabel = (notes: number | null): string => (notes == null ? "—" : `${notes} ${notes === 1 ? "note" : "notes"}`);

export function memoryLabel(access: "read" | "read-write" | "none"): string {
  return access === "read-write" ? "read + write" : access === "read" ? "read" : "no access";
}

// ---- History (spec §5.2) ----

/** Who made the change: Manta (chat, "for you"), the Architect (a task) or the user (a restore). */
export function historyWho(change: Pick<AgentChange, "origin">): string {
  if (change.origin.kind === "job") return "Architect";
  if (change.origin.kind === "restore") return "You";
  if (change.origin.kind === "learned") return "Manta · learned from you";
  return "Manta · for you";
}

export type StatusTone = "ok" | "accent" | "faint" | "warn";

/**
 * The row's outcome: a label, its tone and, where there is one, the reason — a live change says how it went live ("you approved
 * it" / "applied automatically"), an undone one by whom, a refused one why.
 */
export function historyStatus(change: Pick<AgentChange, "state" | "decidedBy" | "error">): { tone: StatusTone; label: string; why: string | null } {
  switch (change.state) {
    case "applied":
      return { tone: "ok", label: "Live", why: change.decidedBy === "click" ? "you approved it" : "applied automatically" };
    case "undone":
      return { tone: "faint", label: "Undone", why: change.decidedBy === "click" ? "by you" : null };
    case "pending":
      return { tone: "accent", label: "Waiting for your click", why: null };
    case "held":
      return { tone: "faint", label: "Waiting for the Architect to finish", why: null };
    case "applying":
      return { tone: "accent", label: "Applying…", why: null };
    case "discarded":
      return { tone: "faint", label: "Discarded", why: null };
    case "expired":
      return { tone: "faint", label: "Expired", why: null };
    case "conflict":
      return { tone: "warn", label: "Not applied", why: change.error || null };
    case "failed":
      return { tone: "warn", label: "Not activated", why: null };
  }
}

/** The history pane's counts: live (applied), waiting (pending), undone. */
export function historyCounts(records: ReadonlyArray<Pick<AgentChange, "state">>): { live: number; waiting: number; undone: number } {
  const n = (state: AgentChange["state"]) => records.filter((r) => r.state === state).length;
  return { live: n("applied"), waiting: n("pending"), undone: n("undone") };
}

/** The id of the newest live (applied) change — the one whose card carries the page's Undo; null when none is live. */
export function latestLiveId(records: ReadonlyArray<Pick<AgentChange, "id" | "state" | "decidedAt" | "createdAt">>): string | null {
  let best: { id: string; at: number } | null = null;
  for (const r of records) {
    if (r.state !== "applied") continue;
    const at = r.decidedAt ?? r.createdAt;
    if (!best || at > best.at) best = { id: r.id, at };
  }
  return best?.id ?? null;
}

/** The research pane's counts: entries past their shelf life, thin ones (fewer than 3 independent sources), and ones gone from the library. */
export function researchHealth(entries: ReadonlyArray<Pick<AgentResearchEntry, "status" | "thin">>): { stale: number; thin: number; missing: number } {
  return {
    stale: entries.filter((e) => e.status === "stale").length,
    thin: entries.filter((e) => e.thin).length,
    missing: entries.filter((e) => e.status === "missing").length,
  };
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
export function canRestore(change: Pick<AgentChange, "kind" | "state" | "before"> & { origin?: AgentChange["origin"] }, current: string | null): boolean {
  if (change.kind !== "update" || change.before == null) return false;
  if (change.origin?.kind === "learned") return false; // it changed no agent file: a rule is taken back from the Learned tab
  if (change.state !== "applied" && change.state !== "undone") return false;
  return current == null || change.before !== current;
}

/**
 * The folder of an open project that is this seat's project (the registry names it; the sidebar knows folders), so "Mention in
 * a chat" can start in it. Only an unambiguous match counts; none → null (the active project is used instead).
 */
export function seatFolder(seat: { project: string; projectName: string } | undefined, projects: ReadonlyArray<{ defaultCwd?: string | null }>): string | null {
  if (!seat) return null;
  const one = [{ slug: seat.project, name: seat.projectName }];
  const hits = projects.filter((p) => p.defaultCwd && resolvePickerProject(p.defaultCwd, one));
  return hits.length === 1 ? (hits[0].defaultCwd ?? null) : null;
}
