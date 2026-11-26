// Pure logic for "@agent" mentions in a project chat (Agents Phase 1, spec §8).
// No React: unit-tested in agentDispatch.test.ts.

import type { AgentInfo, QuestionRequest, TaskQuestion } from "../shared/types";
import { ARCHITECT_SLUG, isTeamAgent } from "../shared/agentsShared.mjs";
import { resolveAgentMentions, type AgentMention } from "./chatShared";

/** The tmux session that holds every agent's direct chat window (never listed as a workspace). */
export const AGENTS_TMUX_SESSION = "manta-agents";

/** The OpenCode agent key a package agent is compiled to (server side). Used to hide them from the opencode-agent list. */
export const PACKAGE_AGENT_PREFIX = "agent-";

/** The OpenCode agent key of the Architect: its tasks' result cards list the changes it proposed. */
export const ARCHITECT_AGENT_KEY = `${PACKAGE_AGENT_PREFIX}${ARCHITECT_SLUG}`;

export const ONE_AGENT_ERROR = "Mention one agent per message for now";

/** An agent a message can be dispatched to: a team agent (parsed, and not the lead: Manta already leads every chat). The Architect is one. */
export function usableAgents(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo[] {
  return (agents ?? []).filter(isTeamAgent);
}

/** The valid lead (Agents Phase 2): a parsed package whose role is "lead". Null when the box has none. */
export function leadAgent(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo | null {
  return (agents ?? []).find((a) => a.role === "lead" && !a.error) ?? null;
}

/** The lead's display name for "<Lead> asked: …" lines; "Manta" until the list loads or when the box has no lead. */
export function leadDisplayName(agents: ReadonlyArray<AgentInfo> | null | undefined): string {
  const lead = leadAgent(agents);
  return lead?.name || lead?.slug || "Manta";
}

/** The agents a routine can run as (Agents Phase 2): valid specialists. */
export function routineAgents(agents: ReadonlyArray<AgentInfo> | null | undefined): AgentInfo[] {
  return (agents ?? []).filter((a) => !a.error && a.role === "specialist");
}

export type AgentDispatchPick = null | { slug: string } | { error: string };

/**
 * Does this message go to a package agent? `null` = no (the normal send path).
 * Mentions are resolved against the text actually being sent, so a token the
 * user deleted after picking it never dispatches. More than one distinct
 * package agent is refused (Phase 1: one agent per message).
 */
export function pickAgentDispatch(
  text: string,
  mentions: ReadonlyArray<AgentMention>,
  agents: ReadonlyArray<AgentInfo> | null | undefined,
): AgentDispatchPick {
  const slugs = new Set(usableAgents(agents).map((a) => a.slug));
  if (slugs.size === 0) return null;
  const hit = new Set<string>();
  for (const m of resolveAgentMentions(text, mentions as AgentMention[])) {
    if (slugs.has(m.name)) hit.add(m.name);
  }
  // A hand-typed "@slug" (not picked from the popup) counts too.
  for (const m of text.matchAll(/(?:^|\s)@([a-z][a-z0-9-]{0,30})(?![a-z0-9-])/g)) {
    if (slugs.has(m[1])) hit.add(m[1]);
  }
  if (hit.size === 0) return null;
  if (hit.size > 1) return { error: ONE_AGENT_ERROR };
  return { slug: [...hit][0] };
}

/** The display name for an `agent-<slug>` OpenCode agent id (a result card's `agent`), else null when it is not a package agent. */
export function packageAgentDisplayName(
  opencodeAgent: string | undefined,
  agents: ReadonlyArray<AgentInfo> | null | undefined,
): string | null {
  if (!opencodeAgent || !opencodeAgent.startsWith(PACKAGE_AGENT_PREFIX)) return null;
  const slug = opencodeAgent.slice(PACKAGE_AGENT_PREFIX.length);
  return (agents ?? []).find((a) => a.slug === slug)?.name ?? slug;
}

/** Initial letter + colour for an agent row (the agent's own colour, else a neutral). */
export function agentInitial(a: Pick<AgentInfo, "name" | "slug">): string {
  return (a.name || a.slug).trim().charAt(0).toUpperCase() || "?";
}

/** The partial "@name" being typed just before the caret (e.g. "se" for "ask @se|"), or null. */
export function agentMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const m = /(?:^|\s)@([a-z0-9-]{0,31})$/i.exec(text.slice(0, caret));
  if (!m) return null;
  return { query: m[1].toLowerCase(), start: caret - m[1].length - 1 };
}

/** Agents whose slug or name starts with `query`, in list order. */
export function matchAgents(agents: ReadonlyArray<AgentInfo> | null | undefined, query: string): AgentInfo[] {
  return usableAgents(agents).filter((a) => a.slug.startsWith(query) || a.name.toLowerCase().startsWith(query));
}

/** `text` with the "@query" at `start..caret` replaced by "@slug ", and the new caret. */
export function insertAgentMention(text: string, start: number, caret: number, slug: string): { text: string; caret: number } {
  const ins = `@${slug} `;
  const rest = text.slice(caret).replace(/^\s+/, "");
  return { text: text.slice(0, start) + ins + rest, caret: start + ins.length };
}

// ===== Agent tasks (agent screens spec §2.3 – §2.5, §4.4) =====

type TaskJobFields = {
  id: string;
  rootJobId?: string | null;
  architect?: { rootJobId?: string | null } | null;
  agent?: string | null;
  supersededBy?: string | null;
  createdAt?: number;
  attempt?: number;
};

/** The task a job belongs to: its first round's id. Older records carry it on the Architect stamp or not at all. */
export function rootJobOf(job: Pick<TaskJobFields, "id" | "rootJobId" | "architect">): string {
  return job.rootJobId || job.architect?.rootJobId || job.id;
}

/** Is this job a task for a package agent (its OpenCode agent key is `agent-<slug>`)? Other background jobs keep the inline details. */
export function isAgentTask(job: Pick<TaskJobFields, "agent"> | null | undefined): boolean {
  return !!job?.agent && job.agent.startsWith(PACKAGE_AGENT_PREFIX);
}

/** The package agent's slug behind an `agent-<slug>` key, else null. */
export function agentSlugOf(opencodeAgent: string | null | undefined): string | null {
  return opencodeAgent && opencodeAgent.startsWith(PACKAGE_AGENT_PREFIX) ? opencodeAgent.slice(PACKAGE_AGENT_PREFIX.length) : null;
}

/**
 * The record the task panel shows for a job id: the NEWEST round of the same task (same root, not superseded). `jobs` is
 * the store's child-keyed slice. A job id the store no longer holds still finds a round that names it as its root.
 */
export function resolveTaskJob<T extends TaskJobFields>(jobs: Readonly<Record<string, T>>, jobId: string | null | undefined): T | undefined {
  if (!jobId) return undefined;
  const all = Object.values(jobs);
  const given = all.find((j) => j.id === jobId);
  const root = given ? rootJobOf(given) : jobId;
  const rounds = all.filter((j) => j.id === jobId || rootJobOf(j) === root);
  if (rounds.length === 0) return undefined;
  const live = rounds.filter((j) => !j.supersededBy);
  const pool = live.length > 0 ? live : rounds;
  return pool.reduce((best, j) => ((j.attempt ?? 0) > (best.attempt ?? 0) || ((j.attempt ?? 0) === (best.attempt ?? 0) && (j.createdAt ?? 0) >= (best.createdAt ?? 0)) ? j : best));
}

/** The request as Manta wrote it: the dispatch prompt up to the project brief / chat excerpt the server appends. */
export function taskBriefOf(job: { prompt?: string | null; request?: string | null }): string {
  const prompt = typeof job.prompt === "string" ? job.prompt : "";
  const head = prompt.split("\n\n---\n")[0].trim();
  return head || (job.request ?? "").trim();
}

/** The prefix of a task question's id (`tq_<16 hex>`): how the chat tells it from OpenCode's own `que_…` questions. */
export const TASK_QUESTION_PREFIX = "tq_";
export const isTaskQuestionId = (id: string | null | undefined): boolean => typeof id === "string" && id.startsWith(TASK_QUESTION_PREFIX);

/** A task's question as the unchanged question card takes it; the header names who is asking. */
export function taskQuestionRequest(tq: TaskQuestion): QuestionRequest {
  return {
    id: tq.id,
    sessionID: tq.parentSessionID,
    questions: tq.questions.map((q) => ({
      question: q.question,
      header: `${tq.agentName || "An agent"} asks you`,
      options: q.options,
      multiple: q.multiple,
      // Every captured question took free text (the box checks before it keeps one), and the card always shows the box.
      custom: true,
    })),
  };
}

/** How many open questions each task has, keyed by its root job id (what the run card's "· N questions" reads). */
export function openQuestionCounts(questions: ReadonlyArray<Pick<TaskQuestion, "rootJobId" | "state">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const q of questions) if (q.state === "open") counts.set(q.rootJobId, (counts.get(q.rootJobId) ?? 0) + 1);
  return counts;
}

// ===== The @ picker's agent rows (agent screens spec §2.3) =====

export type PickerProject = { slug: string; name: string };
export type AgentPickerRow = { agent: AgentInfo; pill: string | null };

const slugName = (name: string): string => {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base === "" ? "project" : base;
};

/**
 * The registry project a chat's folder belongs to, from the folder's own name: a project whose name is that folder name,
 * or whose slug starts with it (`<name>-<10 hex>`). Only an unambiguous match counts — a wrong "adds to X" is worse than
 * no pill — so none or several candidates is null.
 */
export function resolvePickerProject(cwd: string | null | undefined, projects: ReadonlyArray<PickerProject> | null | undefined): PickerProject | null {
  const base = (cwd ?? "").split("/").filter(Boolean).pop();
  if (!base || !projects || projects.length === 0) return null;
  const want = slugName(base);
  const hits = projects.filter((p) => p.name.toLowerCase() === base.toLowerCase() || p.slug.replace(/-[0-9a-f]{10}$/, "") === want);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * The agents the picker offers for what has been typed, in order: the lead first (when one is ever offered), agents seated
 * in this chat's project, then the rest by name. A specialist's pill says "seated here" or "adds to <Project>"; the lead
 * and the Architect have no seats and so no pill, and with no known project there is none either.
 */
export function agentPickerRows(
  agents: ReadonlyArray<AgentInfo> | null | undefined,
  query: string,
  project: PickerProject | null,
): AgentPickerRow[] {
  const q = query.toLowerCase();
  const seated = (a: AgentInfo) => !!project && (a.seats ?? []).includes(project.slug);
  const rank = (a: AgentInfo) => (a.role === "lead" ? 0 : seated(a) ? 1 : 2);
  return usableAgents(agents)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.slug.includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((agent) => ({
      agent,
      pill: !project || agent.role === "lead" || agent.role === "architect" ? null : seated(agent) ? "seated here" : `adds to ${project.name}`,
    }));
}
