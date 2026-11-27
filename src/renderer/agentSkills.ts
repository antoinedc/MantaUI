// ===== Architect v2 Stage 2 — what a change card and the profile say about skills =====
//
// Pure helpers (spec docs/superpowers/specs/2026-11-27-architect-v2.md §4, §6.1): the words for what a proposal does to a skill, where a
// copied skill came from, its licence and how many use it, and which links may be drawn as links.

import type { AgentChange, AgentSkillInfo, SkillChange, SkillProvenance, SkillSearchRecord } from "../shared/types";

const fmt = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

export function skillOpLabel(op: SkillChange["op"]): string {
  return op === "add" ? "New skill" : op === "replace" ? "Replaces skill" : "Removes skill";
}

/** "12,500 installs · 41,100 stars"; only what is known; null when nothing is. */
export function registryLine(registry: { installs: number | null; stars: number | null } | null | undefined): string | null {
  const bits = [registry?.installs != null ? plural(registry.installs, "install") : null, registry?.stars != null ? plural(registry.stars, "star") : null].filter((b): b is string => !!b);
  return bits.length > 0 ? bits.join(" · ") : null;
}

/** "Copied from acme/cro · MIT · 12,500 installs"; a written skill (no provenance): "Written for this agent". */
export function provenanceLine(p: SkillProvenance | null | undefined): string {
  if (!p) return "Written for this agent";
  return [`${p.taken === "part" ? "Part copied" : "Copied"} from ${p.repo}`, p.licence, registryLine(p.registry)].filter(Boolean).join(" · ");
}

/** The address when it is an https one, else null: an origin link is only drawn for those, and opens through the app. */
export function httpsUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The fold label's part for a change that touches skills: "1 skill" / "2 skills"; null when it touches none. */
export function skillsFoldPart(diff: ReadonlyArray<unknown> | null | undefined): string | null {
  return diff && diff.length > 0 ? plural(diff.length, "skill") : null;
}

/** "4 files · 1.5 KB". */
export function skillSizeLine(skill: Pick<AgentSkillInfo, "files" | "bytes">): string {
  const b = skill.bytes;
  const size = b < 1024 ? `${b} byte${b === 1 ? "" : "s"}` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${plural(skill.files, "file")} · ${size}`;
}

/** "Searched for existing skills · 2 searches · 1 skill looked at". */
export function skillSearchLine(search: Pick<SkillSearchRecord, "queries" | "candidates">): string {
  const n = search.candidates.length;
  return ["Searched for existing skills", plural(search.queries.length, "search", "searches"), n === 0 ? "none found worth listing" : `${plural(n, "skill")} looked at`].join(" · ");
}

export function candidateVerdictLabel(v: SkillSearchRecord["candidates"][number]["verdict"]): string {
  return v === "used-whole" ? "Used whole" : v === "used-part" ? "Used in part" : "Rejected";
}

/** The skills block of a card has something to say. */
export const hasSkillChanges = (change: Pick<AgentChange, "skillsDiff">): boolean => (change.skillsDiff?.length ?? 0) > 0;

/**
 * What the card says about the independent script check (a tool-less session on another model that read the scripts as data): the verdict,
 * or — while a held change is still waiting for it — that it is being checked. null when the change has no scripts or there is nothing to say.
 */
export function scriptReviewLine(change: Pick<AgentChange, "skillsDiff" | "scriptReview" | "state">): string | null {
  const hasScripts = (change.skillsDiff ?? []).some((d) => (d.scripts?.length ?? 0) > 0);
  if (!hasScripts) return null;
  const r = change.scriptReview;
  if (!r) return change.state === "held" ? "Checking the scripts independently…" : null;
  return r.verdict === "clean" ? "Scripts checked independently: no issues found" : r.verdict === "flagged" ? "Scripts checked independently: flagged" : "The independent script check couldn't run";
}
