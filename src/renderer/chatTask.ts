// ===== Tasks an agent started from its own conversation — card logic (no DOM) =====
//
// Spec docs/superpowers/specs/2026-11-28-agent-chat-tasks.md §7; design docs/screens/agents/chat-tasks-decisions.md §1.
// The running card, the result card, the "starting" card (from the `agent_start_task` tool part) and the refused row are ONE
// card family; what they say lives here, so the words match Fleet's and the components stay thin.

import type { DelegateJob, OpencodePart } from "../shared/types";
import { outcomeOfJob } from "../shared/fleetOutcome.mjs";
import { endedBadge, type BadgeTone } from "./agents/fleetView";
import { shortModelId } from "./chatUtils";
import { NEEDS_DECISION_LABEL } from "./backgroundRun";

/** Is this job a task an agent started from its own conversation (spec §6.8 `startedFrom`)? */
export const isChatTask = (job: Pick<DelegateJob, "startedFrom"> | null | undefined): boolean => job?.startedFrom === "agent-chat";

/** The dot / word tone: `run` is the spinner's, `` the quiet grey. */
export type ChatTaskTone = "run" | "ok" | "bad" | "warn" | "";
export type ChatTaskStatus = { label: string; tone: ChatTaskTone };

const BADGE_TONE: Record<BadgeTone, ChatTaskTone> = { ok: "ok", bad: "bad", cut: "warn", neutral: "" };

type StatusInput =
  | { kind: "starting" }
  | { kind: "running"; paused: boolean }
  | { kind: "uncertain" }
  | { kind: "failed" }
  | { kind: "settling" }
  /** A finished task: the job record when the store has it, else the result part's own state. */
  | { kind: "ended"; job?: Pick<DelegateJob, "status" | "error"> & { endReason?: unknown; endedBlocked?: unknown }; state?: string; endedBlocked?: boolean };

/** The words of a card's state. A finished task uses Fleet's `endedBadge` over the one shared outcome mapping — never a second one. */
export function chatTaskStatus(input: StatusInput): ChatTaskStatus {
  switch (input.kind) {
    case "starting":
      return { label: "Starting…", tone: "run" };
    case "running":
      return input.paused ? { label: "Paused by you", tone: "" } : { label: "In progress", tone: "run" };
    case "uncertain":
      return { label: "Couldn’t confirm this started — open the session to check", tone: "warn" };
    case "failed":
      return { label: "Failed to start", tone: "bad" };
    case "settling":
      return { label: "Wrapping up", tone: "run" };
    case "ended": {
      if (input.endedBlocked === true || (input.job as { endedBlocked?: unknown } | undefined)?.endedBlocked === true) return { label: NEEDS_DECISION_LABEL, tone: "warn" };
      // a result with no record in the store: its own state (a stop with no record is the user's)
      const job = input.job ?? { status: input.state === "failed" ? "failed" : input.state === "stopped" ? "stopped" : "done", error: input.state === "stopped" ? "stopped by user" : null };
      const badge = endedBadge(outcomeOfJob(job));
      return { label: badge.label, tone: BADGE_TONE[badge.tone] };
    }
  }
}

/** The branch the task works on, or "read-only" when it has none (a read-only agent, or a project folder that isn't a git repository). */
export function taskBranchLine(job: Pick<DelegateJob, "branch"> & { isolation?: string }): { kind: "branch" | "read-only"; text: string } {
  if (job.isolation === "none" || !job.branch) return { kind: "read-only", text: "read-only" };
  return { kind: "branch", text: job.branch };
}

/** The model line, shown only once the task carries one (`modelUsed`, else the model it asked for): the way a person says it. */
export function modelLine(job: { model?: string | null; modelUsed?: string | null } | null | undefined): string | null {
  const m = job?.modelUsed || job?.model;
  return m ? shortModelId(m) || null : null;
}

/** The result text without the header lines the server writes (`[background job …]`, `Project: …`): the card's chip already says it. */
export function cleanResultText(text: string | null | undefined): string {
  const raw = typeof text === "string" ? text : "";
  const lines = raw.split("\n");
  let i = 0;
  if (/^\[background job .*\]$/.test(lines[0] ?? "")) i++;
  if (/^Project: /.test(lines[i] ?? "")) i++;
  if (i === 0) return raw;
  return lines.slice(i).join("\n").replace(/^(?:[ \t]*\n)+/, "");
}

// ---- the `agent_start_task` tool part ----

export const START_TASK_TOOL = "agent_start_task";

export function isChatTaskStartPart(part: { type?: unknown; tool?: unknown } | null | undefined): boolean {
  return part?.type === "tool" && part.tool === START_TASK_TOOL;
}

type ToolState = { status?: string; input?: Record<string, unknown>; output?: unknown; error?: unknown };
const stateOf = (part: OpencodePart): ToolState => (((part as Record<string, unknown>).state ?? {}) as ToolState);

/** The sentence a refused (or failed) call got back, or null when the call is not finished or started its task. */
export function refusalOf(part: OpencodePart): string | null {
  const s = stateOf(part);
  if (s.status === "error") return typeof s.error === "string" && s.error ? s.error : "The call failed";
  if (s.status !== "completed") return null;
  const out = typeof s.output === "string" ? s.output : "";
  const m = /^Not started: ([\s\S]*)$/.exec(out);
  return m ? m[1].trim() : null;
}

/** The agent's own words for the task (title) and the project id it named, from the call's input. */
export function startInputOf(part: OpencodePart): { title: string; project: string } {
  const input = stateOf(part).input ?? {};
  return { title: typeof input.title === "string" ? input.title.trim() : "", project: typeof input.project === "string" ? input.project.trim() : "" };
}

/** "billing-service-0a1b2c3d4e" → "billing service" (a project id's name part); anything else as the agent wrote it. */
export function projectWords(project: string): string {
  const m = /^(.+)-[0-9a-f]{10}$/.exec(project);
  return (m ? m[1] : project).replace(/-/g, " ").trim();
}

const PLAIN: Array<[RegExp, (m: RegExpExecArray, ctx: { project: string }) => string]> = [
  [/^No project with that id;/, (_m, { project }) => (projectWords(project) ? `No project called “${projectWords(project)}” on this box` : "No project like that on this box")],
  [/^The user declined the task$/, () => "You declined the task"],
  [/^(.+) can't run tasks; pick another model in this conversation or use Auto$/, (m) => `${m[1]} can’t run tasks. Pick another model in this conversation, or choose Auto.`],
  [/^All background slots on this box are busy right now/, () => "All background slots on this box are busy right now. It can start when one finishes."],
  [/^Only an agent's own conversation can start tasks this way$/, () => "Tasks can only be started from an agent’s own conversation."],
  [/^Couldn't verify this call; try again$/, () => "Couldn’t confirm the request. The agent can try again."],
  [/^Write a brief and a title$/, () => "The agent sent no title or brief."],
  [/^That task can't be continued from here$/, () => "That earlier task can’t be continued from here."],
  [/^That task is in (.+); continue it there or start a new task$/, (m) => `That earlier task is in ${m[1]}, not in the project the agent chose.`],
];

/**
 * What the user reads under "Not started": the refusal in plain words. The agent-facing wording ("call agent_projects…") never shows;
 * the agent's own sentence is kept for the row's tooltip. A sentence already in plain words is kept as it is.
 */
export function friendlyRefusal(sentence: string, ctx: { project: string }): string {
  const s = sentence.trim();
  for (const [re, say] of PLAIN) {
    const m = re.exec(s);
    if (m) return say(m, ctx);
  }
  return /agent_(projects|start_task)/.test(s) ? "The request was refused." : s;
}

// ---- Clear conversation, refused while tasks started from the conversation run (spec FR-012, design §5) ----

/** The box's refusal sentence, for the dialog that opens already refused (singular and plural). */
export function clearRefusalSentence(agentName: string, n: number): string {
  const one = n === 1;
  return `${agentName} has ${n} task${one ? "" : "s"} running from this conversation; wait for ${one ? "it" : "them"} or stop ${one ? "it" : "them"} first.`;
}

/** A sentence with a full stop at its end (the box's refusal carries none). */
export const withStop = (sentence: string): string => (/[.!?]$/.test(sentence.trim()) ? sentence.trim() : `${sentence.trim()}.`);

export type BlockingTask = { key: string; title: string; project: string | null; status: string };

/**
 * The tasks that stop Clear for conversation `sessionId`: its running or paused chat tasks (the job store), then the starts still on
 * their way (an `agent_start_task` call that has not answered yet: "Starting…"). `starting` comes from the transcript's tool parts.
 */
export function blockingChatTasks(
  jobs: Record<string, DelegateJob>,
  sessionId: string,
  starting: ReadonlyArray<{ key: string; title: string; project: string | null }>,
): BlockingTask[] {
  const live = Object.values(jobs ?? {})
    .filter((j) => isChatTask(j) && j.parentSessionID === sessionId && !j.supersededBy && (j.status === "running" || j.status === "paused"))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((j) => ({ key: j.id, title: j.title?.trim() || j.name, project: j.project?.name ?? null, status: j.status === "paused" ? "Paused by you" : "In progress" }));
  return [...live, ...starting.map((s) => ({ ...s, status: "Starting…" }))];
}
