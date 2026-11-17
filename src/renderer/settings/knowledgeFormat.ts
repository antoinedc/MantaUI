// Pure helpers for the Knowledge settings card (shared-knowledge spec §4, §8, §11.6).

import type {
  KnowledgeChange,
  KnowledgeProjectRow,
  KnowledgeRepoRules,
  KnowledgeSettings,
  KnowledgeSharing,
  KnowledgeUndoResult,
} from "../../shared/api";

/** The store folder the "View knowledge" button opens (the box expands `~`). */
export const KNOWLEDGE_DIR = "~/.manta/knowledge";

/** The most a daily cap can be set to; a typo guard, not a policy. */
export const DAILY_CAP_MAX_USD = 1000;

export const REPO_RULES_OPTIONS: ReadonlyArray<{
  value: KnowledgeRepoRules;
  label: string;
  description: string;
  outward: boolean;
}> = [
  { value: "box-only", label: "Box only", description: "Repos are never touched. Project rules reach sessions through the briefing.", outward: false },
  { value: "pull-request", label: "Pull request", description: "Opens one knowledge pull request per repo. It never merges.", outward: true },
  { value: "direct", label: "Direct", description: "Commits to the default branch and pushes. A rejected push becomes a pull request.", outward: true },
];

export const SHARING_OPTIONS: ReadonlyArray<{ value: KnowledgeSharing; label: string; description: string }> = [
  { value: "share-and-read", label: "Share & read", description: "Feeds shared notes, preferences and skills, and reads them." },
  { value: "read-only", label: "Read only", description: "Reads shared notes but contributes nothing and stays out of other projects' search." },
  { value: "private", label: "Private", description: "Neither reads nor contributes shared knowledge." },
];

/** How much a sharing mode exposes: private < read only < share & read. */
const SHARING_RANK: Record<KnowledgeSharing, number> = { private: 0, "read-only": 1, "share-and-read": 2 };

/**
 * The sentence to confirm before MOVING toward more sharing (what `pending` exposes beyond `saved`), or null when the
 * change shares the same or less. `what` names the project ("manta") or the default's scope.
 */
export function sharingConfirmText(saved: KnowledgeSharing, pending: KnowledgeSharing, what: string): string | null {
  if (SHARING_RANK[pending] <= SHARING_RANK[saved]) return null;
  return pending === "read-only"
    ? `${what} will start reading the shared how-tos, preferences and skills other projects contributed. It still contributes nothing and stays out of other projects' search.`
    : `Notes, preferences and skills learned in ${what} will feed the shared knowledge, and its notes and past sessions will show up in other projects' search and briefings.`;
}

export const repoRulesLabel = (v: KnowledgeRepoRules): string => REPO_RULES_OPTIONS.find((o) => o.value === v)?.label ?? v;
export const sharingLabel = (v: KnowledgeSharing): string => SHARING_OPTIONS.find((o) => o.value === v)?.label ?? v;

export type CapParse = { ok: true; value: number } | { ok: false; error: string };

/** Dollars, whole cents, 0 (nothing spent: curator waits) up to DAILY_CAP_MAX_USD. */
export function parseDailyCap(text: string): CapParse {
  const t = text.trim().replace(/^\$/, "");
  if (t === "") return { ok: false, error: "Enter a daily cap in dollars, for example 1.00." };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false, error: "Use a dollar amount with up to two decimals, for example 1.00." };
  const value = Number(t);
  if (!Number.isFinite(value)) return { ok: false, error: "Use a dollar amount with up to two decimals, for example 1.00." };
  if (value > DAILY_CAP_MAX_USD) return { ok: false, error: `The cap can't be more than $${DAILY_CAP_MAX_USD}.` };
  return { ok: true, value };
}

export const formatUsd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/** The text a cap input shows for a stored value. */
export const capInputText = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

/** Whether a project's value is set on the project (vs inherited from the default). */
export function isOverride(row: KnowledgeProjectRow, key: "repoRules" | "sharing", defaults: Pick<KnowledgeSettings, "repoRules" | "sharing">): boolean {
  const flag = key === "repoRules" ? row.repoRulesOverride : row.sharingOverride;
  return flag ?? row[key] !== defaults[key];
}

/** A project set to an outward mode it can't use behaves as box-only; the card says why. */
export const outwardLost = (row: KnowledgeProjectRow): boolean =>
  !row.outwardAllowed && row.repoRules !== "box-only";

export type StatusLine = { id: string; tone: "info" | "warn"; text: string };

/** Status lines from whatever the settings payload carries; a missing field renders nothing. */
export function statusLines(s: KnowledgeSettings): StatusLine[] {
  const out: StatusLine[] = [];
  if (s.unavailableReason) out.push({ id: "unavailable", tone: "warn", text: `Knowledge is off on this box: ${s.unavailableReason}` });
  if (typeof s.spentTodayUsd === "number") {
    const capped = s.dailyCapUsd > 0 ? s.spentTodayUsd >= s.dailyCapUsd : true;
    out.push({
      id: "spend",
      tone: capped ? "warn" : "info",
      text: capped
        ? `Spent ${formatUsd(s.spentTodayUsd)} of the ${formatUsd(s.dailyCapUsd)} daily cap. Knowledge work waits until tomorrow; briefings and search keep working.`
        : `Spent ${formatUsd(s.spentTodayUsd)} of the ${formatUsd(s.dailyCapUsd)} daily cap today.`,
    });
  }
  if (s.waitingForCapableModel) {
    out.push({ id: "waiting", tone: "warn", text: "Waiting for a capable model. Rule and skill work is on hold until one is available." });
  }
  if (typeof s.sessionsWithoutBriefingThisWeek === "number") {
    const n = s.sessionsWithoutBriefingThisWeek;
    out.push({
      id: "briefing",
      tone: "info",
      text: n === 0 ? "Every session this week started with a briefing." : `${n} session${n === 1 ? "" : "s"} started without a briefing this week.`,
    });
  }
  return out;
}

const toMs = (at: number | string | undefined): number | null => {
  if (at == null) return null;
  const ms = typeof at === "number" ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
};

/** "just now", "5 min ago", "3 h ago", "2 d ago", then a short date. */
export function formatChangeTime(at: number | string | undefined, now: number = Date.now()): string {
  const ms = toMs(at);
  if (ms == null) return "";
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const formatChangeTimeFull = (at: number | string | undefined): string => {
  const ms = toMs(at);
  return ms == null ? "" : new Date(ms).toLocaleString();
};

/** "overwritten-by-later" → "overwritten by later". */
export const kindLabel = (kind: string): string => kind.replace(/[-_.]+/g, " ").trim();

const AREA_LABEL: Record<string, string> = {
  user: "Your preferences",
  commons: "Shared how-tos",
  "repo-block": "Repo rules",
  "global-block": "Global preferences",
};

/** Where a change landed, in words. */
export function changeWhere(c: Pick<KnowledgeChange, "area" | "slug">, projects: KnowledgeProjectRow[]): string {
  const project = c.slug ? projects.find((p) => p.slug === c.slug)?.displayName ?? c.slug : null;
  if (!c.area) return project ? `Project: ${project}` : "Knowledge";
  if (c.area === "project") return project ? `Project: ${project}` : "Project";
  const base = AREA_LABEL[c.area] ?? c.area;
  return project ? `${base} · ${project}` : base;
}

/** The sentence shown under a change after an undo attempt, or null on success. */
export function describeUndoFailure(r: Extract<KnowledgeUndoResult, { ok: false }>): string {
  const why = r.reason.trim() || "the box refused";
  return r.conflictWith
    ? `Couldn't undo: ${why}. A later change depends on it (${r.conflictWith}); undo that one first.`
    : `Couldn't undo: ${why}.`;
}

/** A save/undo error from a thrown rpc error, in words the user can act on. */
export function describeSaveError(e: unknown): string {
  const raw = String((e as Error)?.message ?? e ?? "").trim();
  if (/invalid-setting/i.test(raw)) return "The box rejected that value.";
  return raw || "Something went wrong.";
}
