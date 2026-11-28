// ===== Fleet and Needs you — pure view logic (docs/superpowers/specs/2026-11-28-fleet-redesign.md §3) =====
//
// Everything the Fleet page and the Needs you page decide that has no DOM in it: how tasks group, what a status says, which
// number the sidebar shows, what a banner says, what a card's recommendation line reads. The components stay thin.

import type { AgentChange, FleetAskedBy, FleetOutcome, FleetSub, FleetTask, NeedsYou, NeedsYouReview, TaskQuestion } from "../../shared/types";
import { formatClockTime } from "../chatUtils";
import { relativeAgo } from "../jobProgress";

// ---- which view ----

export type FleetBy = "projects" | "agents";
export const FLEET_VIEW_KEY = "manta:fleet:view";

/** The remembered grouping (per device); Projects until the user picks Agents. */
export function readFleetBy(): FleetBy {
  try {
    return localStorage.getItem(FLEET_VIEW_KEY) === "agents" ? "agents" : "projects";
  } catch {
    return "projects";
  }
}

export function saveFleetBy(by: FleetBy): void {
  try {
    localStorage.setItem(FLEET_VIEW_KEY, by);
  } catch {
    /* a device that cannot remember still shows the choice it just made */
  }
}

// ---- grouping and counts ----

export type TaskGroup = { key: string; label: string; tasks: FleetTask[] };

const isPaused = (t: Pick<FleetTask, "status">): boolean => t.status === "paused-by-you";

/** A row's identity: its own key (a chat row's session, a task row's job), else its job id (an older box sends job rows only). */
export const rowKey = (t: { key?: string; jobId: string }): string => t.key || t.jobId;

/** An agent's name when the team list doesn't have it (yet): the lead reads "Manta", anything else its slug. */
export const fallbackAgentName = (slug: string): string => (slug === "manta" ? "Manta" : slug);

/** A row that is a job can be stopped and resumed itself; a chat row cannot (its paused jobs carry the Resume). */
export const isTaskRow = (t: { kind?: "chat" | "task"; jobId: string }): boolean => t.kind !== "chat" && !!t.jobId;

/**
 * One group per project (Projects) or per agent (Agents). A group with something in progress comes before a paused-only one;
 * inside a group, in-progress rows come first. The box's order (newest first) is kept otherwise.
 */
export function groupTasks(tasks: ReadonlyArray<FleetTask>, by: FleetBy, agentName: (slug: string) => string): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const t of tasks) {
    // a chat in a workspace the registry doesn't know has no slug: it is grouped under the workspace's own name
    const key = by === "projects" ? (t.project ?? (t.projectName ? `name:${t.projectName}` : "")) : t.agentSlug;
    const label = by === "projects" ? (t.projectName ?? "No project") : agentName(t.agentSlug);
    const g = groups.get(key) ?? { key, label, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, tasks: [...g.tasks.filter((t) => !isPaused(t)), ...g.tasks.filter(isPaused)] }));
  return [...list.filter((g) => g.tasks.some((t) => !isPaused(t))), ...list.filter((g) => g.tasks.every(isPaused))];
}

export const inProgressCount = (tasks: ReadonlyArray<FleetTask> | null | undefined): number => (tasks ?? []).filter((t) => !isPaused(t)).length;

/** "2 in progress · 1 paused". */
export function groupSummary(tasks: ReadonlyArray<FleetTask>): string {
  const running = inProgressCount(tasks);
  const paused = tasks.length - running;
  return [running ? `${running} in progress` : "", paused ? `${paused} paused` : ""].filter(Boolean).join(" · ");
}

export const fleetHeaderCounts = groupSummary;

// ---- status ----

export type StatusView = { label: string; tone: "ok" | "idle"; sub: string | null };

/** Only what the box records: In progress, or Paused by you (and how long ago). */
export function statusView(task: Pick<FleetTask, "status" | "pausedAt">, now: number): StatusView {
  if (!isPaused(task)) return { label: "In progress", tone: "ok", sub: null };
  return { label: "Paused by you", tone: "idle", sub: task.pausedAt != null ? relativeAgo(now - task.pausedAt) : null };
}

/** What a job / subagent beneath a row says about itself. */
export function subStatusLabel(status: FleetSub["status"]): { label: string; tone: "ok" | "idle" | "bad" } {
  switch (status) {
    case "in-progress":
      return { label: "In progress", tone: "ok" };
    case "paused-by-you":
      return { label: "Paused by you", tone: "idle" };
    case "didnt-finish":
      return { label: "Didn’t finish", tone: "bad" };
    default:
      return { label: "Finished", tone: "idle" };
  }
}

export type BadgeTone = "ok" | "bad" | "cut" | "neutral";
export function endedBadge(outcome: FleetOutcome): { label: string; tone: BadgeTone } {
  switch (outcome) {
    case "done":
      return { label: "Done", tone: "ok" };
    case "didnt-finish":
      return { label: "Didn’t finish", tone: "bad" };
    case "interrupted":
      return { label: "Interrupted", tone: "cut" };
    case "stopped":
      return { label: "Stopped by you", tone: "neutral" };
  }
}

/** Why Resume can't be pressed right now (null: it can). */
export function resumeBlockedReason(full: boolean, cap: number): string | null {
  return full ? `Can’t resume yet: ${cap} tasks are already running. It can start when one finishes.` : null;
}

/** "asked by you" / "asked by Manta in <chat>" / "a routine" — Details only, never on a row. */
export function askedByText(by: FleetAskedBy, chatName: string | null): string {
  if (by.by === "you") return "asked by you";
  if (by.by === "routine") return "a routine";
  return chatName ? `asked by Manta in ${chatName}` : "asked by Manta";
}

/** The Details row's value: "You" / "Manta in <chat>" / "A routine". */
export function askedByWho(by: FleetAskedBy, chatName: string | null): string {
  if (by.by === "you") return "You";
  if (by.by === "routine") return "A routine";
  return chatName ? `Manta in ${chatName}` : "Manta";
}

// ---- Needs you ----

/** The finished tasks that ended on a decision. An older box still sends "branch ready to merge" reviews: they are not items. */
export const decisionReviews = (data: Pick<NeedsYou, "reviews"> | null | undefined): NeedsYouReview[] => (data?.reviews ?? []).filter((r) => r.endedBlocked === true);

/** Decisions block (a change waiting for a click, a task that ended on a decision); open questions never do. */
export function needsCounts(data: NeedsYou | null | undefined): { decisions: number; questions: number } {
  if (!data) return { decisions: 0, questions: 0 };
  return { decisions: data.changes.length + decisionReviews(data).length, questions: data.questions.length };
}

/** The sidebar's Needs you row: one red number (decisions only), or a small blue dot when only questions are open. */
export function sidebarNeeds(data: NeedsYou | null | undefined): { decisions: number; questionDot: boolean } {
  const { decisions, questions } = needsCounts(data);
  return { decisions, questionDot: decisions === 0 && questions > 0 };
}

/** The card at the top of Fleet: how many decisions wait and what the first one is. null: none (optional questions never show here). */
export function needsTop(data: NeedsYou | null | undefined, agentName: (slug: string) => string): { heading: string; detail: string } | null {
  const { decisions } = needsCounts(data);
  if (!data || decisions === 0) return null;
  const change = data.changes[0];
  const review = decisionReviews(data)[0];
  const first = change ? `Approve the change to ${change.agentName || agentName(change.slug ?? "")}` : `${review.name} needs your decision`;
  return {
    heading: decisions === 1 ? "1 decision is waiting for you" : `${decisions} decisions are waiting for you`,
    detail: decisions === 1 ? first : `${first}, and ${decisions - 1} ${decisions === 2 ? "other" : "others"}`,
  };
}

/** The title of a change item: what the user is asked to approve. */
export function changeTodo(change: Pick<AgentChange, "kind" | "agentName" | "origin">): string {
  if (change.origin?.kind === "template-update") return `Approve the built-in update to ${change.agentName}?`;
  if (change.origin?.kind === "learned") return `Approve what ${change.agentName} learned?`;
  return change.kind === "create" ? `Approve creating ${change.agentName}?` : `Approve the change to ${change.agentName}?`;
}

/** The line under a question's options. Claimed only when there is a recommended single-select option to go with. */
export function questionAssumption(q: Pick<TaskQuestion, "questions">, agentName: string): string | null {
  const first = q.questions[0];
  if (!first || first.multiple) return null;
  if (!first.options.some((o) => /\(Recommended\)\s*$/i.test(o.label))) return null;
  return `If no one answers, ${agentName} goes with the recommended option, so it’s fine to ignore this.`;
}

/** "Manta recommends …" under a change: approval, unless a review or a trial flagged something the user should read first. */
export function changeRecommendation(change: Pick<AgentChange, "scriptReview" | "contentReview" | "trial">): string {
  const reviews = [change.scriptReview, change.contentReview];
  if (reviews.some((r) => r?.verdict === "flagged")) return `Manta recommends reading it first: an independent check flagged ${change.scriptReview?.verdict === "flagged" ? "a script" : "the change"}.`;
  if (reviews.some((r) => r?.verdict === "error")) return "Manta recommends reading it first: an independent check couldn’t run.";
  const verdicts = change.trial?.verdicts ?? [];
  const failed = verdicts.filter((v) => !v.pass).length;
  if (failed > 0) return `Manta recommends reading it first: ${failed} of ${verdicts.length} test cases didn’t pass.`;
  return "Manta recommends approving it.";
}

export type NeedsUrgency = "decision" | "question";
/** Items under their project heading: decisions first, then open questions; projects in the order they are first seen (decisions' first). */
export function groupNeedsByProject<T extends { urgency: NeedsUrgency; project: string | null }>(items: ReadonlyArray<T>, projectName: (slug: string | null) => string): Array<{ key: string; label: string; items: T[] }> {
  const ordered = [...items.filter((i) => i.urgency === "decision"), ...items.filter((i) => i.urgency === "question")];
  const groups = new Map<string, { key: string; label: string; items: T[] }>();
  for (const i of ordered) {
    const key = i.project ?? "";
    const g = groups.get(key) ?? { key, label: projectName(i.project), items: [] };
    g.items.push(i);
    groups.set(key, g);
  }
  return [...groups.values()];
}

// ---- reads that went stale ----

export const lastUpdateLabel = (at: number | null | undefined): string | null => (at == null ? null : formatClockTime(at) || null);

export type ReadBanner = { tone: "warn" | "bad"; title: string; text: string; action: "Try now" | "Try again" };

/**
 * What a page says when its read is not fine. An unreachable box beats a failed read (the reason is the same and it reconnects on
 * its own); with data the earlier data stays below and the banner names its time; a first read that failed has nothing below.
 */
export function readBanner(
  read: { connected: boolean; hasData: boolean; error: string | null; refreshError: string | null; updatedAt: number | null },
  page: string,
): ReadBanner | null {
  const when = lastUpdateLabel(read.updatedAt);
  if (!read.connected) {
    return { tone: "warn", title: "Can’t reach your box right now.", text: `${when ? `This is the last update, from ${when}.` : "Nothing has been loaded yet."} It will reconnect on its own.`, action: "Try now" };
  }
  if (read.hasData && read.refreshError) {
    return { tone: "bad", title: `Couldn’t refresh ${page}.`, text: `Nothing was changed.${when ? ` Below is the last update, from ${when}.` : ""}`, action: "Try again" };
  }
  if (!read.hasData && read.error) return { tone: "bad", title: `Couldn’t load ${page}.`, text: read.error, action: "Try again" };
  return null;
}

export const UNREACHABLE_TITLE = "Unavailable until the box is reachable";
