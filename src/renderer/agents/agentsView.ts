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
export const SEAT_BRIEF_MAX = 4000;

// ---- which page is showing ----

/** null = closed. Needs you is its own page (Fleet redesign): the Fleet page, the Needs you page, or one agent's profile. */
export type AgentsView = null | { page: "fleet" } | { page: "needs" } | { page: "profile"; slug: string };

export type ProfileTab = "overview" | "skills" | "seats" | "learned" | "history" | "research" | "settings";
const TAB_LABEL: Record<ProfileTab, string> = {
  overview: "Overview",
  skills: "Skills",
  seats: "Seats",
  learned: "Learned",
  history: "History",
  research: "Research",
  settings: "Settings",
};

/**
 * The tabs a profile shows, in this order: Overview, Skills, Seats, Learned, History, Research, Settings. The Architect works in every
 * project, so it has no Seats; Learned is shown when the box sends the agent's rules (even none), never for the lead. Trial runs are
 * part of History, so there is no Tests tab.
 */
export function profileTabs(profile: { learned?: ReadonlyArray<unknown>; info?: { role?: string } }): ReadonlyArray<{ id: ProfileTab; label: string }> {
  const role = profile.info?.role;
  const ids: ProfileTab[] = ["overview", "skills"];
  if (role !== "architect") ids.push("seats");
  if (Array.isArray(profile.learned) && role !== "lead") ids.push("learned");
  ids.push("history", "research", "settings");
  return ids.map((id) => ({ id, label: TAB_LABEL[id] }));
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

/** The instructions without a first line that is just the agent's own name as a title (`# Product Designer`): the page already has it. */
export function stripTitle(text: string, name: string): string {
  const m = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(text);
  if (!m || m[1].trim().toLowerCase() !== name.trim().toLowerCase()) return text;
  return text.slice(m[0].length).replace(/^\s*\n/, "");
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

const ROLE_LABEL: Record<AgentProfile["info"]["role"], string> = { lead: "Lead", architect: "Architect", specialist: "Specialist" };

/** The header's one line: `@seo · Specialist · Edits code · Auto` (and where it works, for Manta and the Architect). */
export function factsLine(profile: AgentProfile): string[] {
  const { info } = profile;
  const facts = [`@${info.slug}`, ROLE_LABEL[info.role] ?? "Specialist", info.isolation === "worktree" ? "Edits code" : "Read-only", info.model || "Auto"];
  if (info.role !== "specialist") facts.push("Works in every project");
  return facts;
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
  if (change.origin.kind === "settings") return "You · in Settings";
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

/** History lists only changes that went live (applied), newest first. Pending, undone, refused and held ones never appear. */
export function appliedHistory<T extends Pick<AgentChange, "state" | "decidedAt" | "createdAt">>(records: ReadonlyArray<T>): T[] {
  return records.filter((r) => r.state === "applied").sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt));
}

/** Who made a live change and how it landed, for the expanded row: "Architect · you approved it". */
export function historyHow(change: Pick<AgentChange, "origin" | "decidedBy">): string {
  const kind = change.origin.kind;
  if (kind === "settings") return historyWho(change);
  if (kind === "restore") return `${historyWho(change)} · restored an earlier version`;
  return `${historyWho(change)} · ${change.decidedBy === "click" ? "you approved it" : "applied automatically"}`;
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
