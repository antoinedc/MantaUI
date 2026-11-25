// ===== Agents Phase 4 — pure logic for the agent-change card =====
//
// What the card decides, with no React and no I/O (the handoff.ts split): which transcript part is an agent change,
// the key the box looks the record up by, the state chip, which buttons a state offers, the create view's fields
// (parsed from the exact agent.md bytes the box will write) and the update view's line diff.

import { diffLines } from "diff";
import { parse as parseYaml } from "yaml";
import type { AgentChange, AgentChangeAdmission, AgentChangeEvidence, AgentChangeState } from "../shared/types";
import { ARCHITECT_SLUG } from "../shared/agentsShared.mjs";
import {
  describeSource,
  diffSources,
  sourcesOfAgentMd,
  PRIVATE_SENTENCE,
  PRIVATE_TO_PUBLIC_SENTENCE,
} from "../shared/architectSources.mjs";

const AGENT_CHANGE_TOOL_RE = /^(?:manta[_-])?agent_change$/i;

/** A transcript part is the lead's `agent_change` tool call, in any state. */
export function isAgentChangePart(part: { type?: unknown; tool?: unknown }): boolean {
  return part.type === "tool" && AGENT_CHANGE_TOOL_RE.test(String(part.tool ?? ""));
}

export interface AgentChangeKey {
  sessionID: string;
  messageID: string;
  callID: string;
}

/** The call tuple the box finds the record by; null when the part lacks any of it (nothing to look up). */
export function agentChangeKeyOf(part: Record<string, unknown>): AgentChangeKey | null {
  const { sessionID, messageID, callID } = part;
  if (typeof sessionID !== "string" || typeof messageID !== "string" || typeof callID !== "string") return null;
  if (!sessionID || !messageID || !callID) return null;
  return { sessionID, messageID, callID };
}

// ---------------------------------------------------------------------------
// Chip, title, reason, buttons
// ---------------------------------------------------------------------------

export type ChipTone = "neutral" | "accent" | "warn" | "ok";

export function agentChangeChip(change: Pick<AgentChange, "state" | "kind">): { label: string; tone: ChipTone } {
  switch (change.state) {
    case "held":
      return { label: "Architect still working", tone: "neutral" };
    case "applying":
      return { label: "Applying…", tone: "accent" };
    case "applied":
      return { label: change.kind === "create" ? "Created" : "Updated", tone: "ok" };
    case "pending":
      return { label: "Waiting for you", tone: "accent" };
    case "discarded":
      return { label: "Discarded", tone: "neutral" };
    case "undone":
      return { label: "Undone", tone: "neutral" };
    case "expired":
      return { label: "Expired", tone: "neutral" };
    case "conflict":
      return { label: "Not applied", tone: "warn" };
    case "failed":
      return { label: "Not activated", tone: "warn" };
  }
}

export function agentChangeTitle(change: Pick<AgentChange, "kind" | "agentName">): string {
  return change.kind === "create" ? `New agent: ${change.agentName}` : `Change to ${change.agentName}`;
}

/** The line shown when the click is needed because the change raises power (not merely because the level is Ask). */
export function agentChangeReason(change: Pick<AgentChange, "needsClick" | "reason" | "agentName">): string | null {
  if (!change.needsClick) return null;
  if (change.reason === "lead") return "This changes Manta's own instructions";
  if (change.reason === "isolation") return `This lets ${change.agentName} edit code`;
  if (change.reason === "core") return "This changes the Architect itself";
  if (change.reason === "unfinished") return "The task didn't finish — review before applying";
  if (change.reason === "plan") return "Proposed while planning or outside a hand-off — review before applying";
  return null;
}

export type AgentChangeAction = "apply" | "discard" | "undo";

/** Buttons a state offers: pending → apply + discard; applied → undo; failed → retry (= apply); else none (held and applying included). */
export function agentChangeActions(state: AgentChangeState): AgentChangeAction[] {
  switch (state) {
    case "pending":
      return ["apply", "discard"];
    case "applied":
      return ["undo"];
    case "failed":
      return ["apply"];
    default:
      return [];
  }
}

export function agentChangeButtonLabel(
  action: AgentChangeAction,
  change: Pick<AgentChange, "kind" | "state">,
  busy: boolean,
): string {
  if (action === "discard") return busy ? "Discarding…" : "Discard";
  if (action === "undo") return busy ? "Undoing…" : "Undo";
  if (change.state === "failed") return busy ? "Retrying…" : "Retry";
  if (change.kind === "create") return busy ? "Creating…" : "Create";
  return busy ? "Applying…" : "Apply";
}

/** The state a successful press ends in, and the short line that says so. */
export function agentChangeOutcome(
  action: AgentChangeAction,
  change: Pick<AgentChange, "kind">,
): { state: AgentChangeState; text: string } {
  if (action === "discard") return { state: "discarded", text: "Discarded." };
  if (action === "undo") return { state: "undone", text: "Undone." };
  return change.kind === "create"
    ? { state: "applied", text: "Created. You can hand work to it now." }
    : { state: "applied", text: "Applied." };
}

// ---------------------------------------------------------------------------
// Create view: the fields of the agent.md that will be written
// ---------------------------------------------------------------------------

export interface AgentMdView {
  name: string;
  description: string;
  useWhen: string | null;
  notFor: string | null;
  /** True when the agent works on its own branch (isolation worktree). */
  editsCode: boolean;
  model: string | null;
  body: string;
}

/** Read the agent.md bytes the box built. null when they can't be read (the card then shows the raw text). */
export function parseAgentMdView(text: string): AgentMdView | null {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(String(text ?? "").replace(/^\uFEFF/, ""));
  if (!m) return null;
  let data: unknown;
  try {
    data = parseYaml(m[1]);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = str(d.name);
  const description = str(d.description);
  if (!name || !description) return null;
  return {
    name,
    description,
    useWhen: str(d.use_when),
    notFor: str(d.not_for),
    editsCode: str(d.isolation) !== "none",
    model: str(d.model),
    body: (m[2] ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Update view: a unified line diff
// ---------------------------------------------------------------------------

export type DiffRow =
  | { kind: "add" | "del" | "same"; text: string }
  | { kind: "gap"; count: number };

/** Unchanged lines kept on each side of a change. */
export const DIFF_CONTEXT_LINES = 2;
/** The diff shows this many rows before the rest folds behind "Show N more lines". */
export const DIFF_COLLAPSE_ROWS = 30;

const splitLines = (v: string): string[] => {
  const lines = v.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** The changed lines of before → after with a little context; long unchanged runs fold into one `gap` row. Empty when equal. */
export function diffRows(before: string, after: string): DiffRow[] {
  const segs = diffLines(before, after).map((p) => ({
    kind: (p.added ? "add" : p.removed ? "del" : "same") as "add" | "del" | "same",
    lines: splitLines(p.value),
  }));
  if (!segs.some((s) => s.kind !== "same")) return [];
  const rows: DiffRow[] = [];
  segs.forEach((seg, i) => {
    if (seg.kind !== "same") {
      for (const text of seg.lines) rows.push({ kind: seg.kind, text });
      return;
    }
    const head = i === 0 ? 0 : DIFF_CONTEXT_LINES;
    const tail = i === segs.length - 1 ? 0 : DIFF_CONTEXT_LINES;
    const n = seg.lines.length;
    if (n <= head + tail + 1) {
      for (const text of seg.lines) rows.push({ kind: "same", text });
      return;
    }
    for (const text of seg.lines.slice(0, head)) rows.push({ kind: "same", text });
    rows.push({ kind: "gap", count: n - head - tail });
    for (const text of seg.lines.slice(n - tail)) rows.push({ kind: "same", text });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Phase 5A: what an Architect proposal adds to the card
// ---------------------------------------------------------------------------

export function verdictLabel(verdict: AgentChangeAdmission["verdict"]): string {
  return verdict === "general" ? "General" : verdict === "scoped" ? "Scoped" : "Excluded";
}

export interface EvidenceLine {
  claim: string;
  quote: string | null;
  url: string | null;
  isPrivate: boolean;
}

/** The evidence rows of a card: a private source shows only its claim; a link that isn't http(s) is never offered. */
export function evidenceLines(evidence: ReadonlyArray<AgentChangeEvidence> | null | undefined): EvidenceLine[] {
  return (evidence ?? []).map((e) => {
    const safe = !e.private && typeof e.url === "string" && /^https?:\/\//i.test(e.url) ? e.url : null;
    return { claim: e.claim, quote: e.private ? null : e.quote, url: e.private ? null : safe, isPrivate: e.private === true };
  });
}

export interface SourceBlock {
  id: string;
  name: string;
  change: "added" | "changed" | "removed";
  /** The full argv with {query} marked, or the address template. */
  runs: string;
  /** "Runs … on this box …" or "Calls <host>". */
  line: string;
  secrets: string[];
  /** The private-source sentence (null for a public one and for a removed source). */
  note: string | null;
  /** "Private → Public: …" on a changed source that was private. */
  warning: string | null;
}

/** Is this record a change to the Architect itself (the only agent that has extra sources)? */
export const isArchitectChange = (change: Pick<AgentChange, "kind" | "slug">): boolean => change.kind === "update" && change.slug === ARCHITECT_SLUG;

/** One block per added, changed or removed extra source between two agent.md texts; empty when nothing about them changes. */
export function architectSourceBlocks(before: string | null | undefined, after: string | null | undefined): SourceBlock[] {
  if (typeof before !== "string" || typeof after !== "string") return [];
  const rows = diffSources(sourcesOfAgentMd(before).sources, sourcesOfAgentMd(after).sources);
  return rows.map((row) => {
    const d = describeSource(row.source);
    return {
      id: d.id,
      name: d.name,
      change: row.change,
      runs: d.runs,
      line: d.line,
      secrets: d.secrets,
      note: row.change !== "removed" && d.private ? PRIVATE_SENTENCE : null,
      warning: row.privateToPublic ? PRIVATE_TO_PUBLIC_SENTENCE : null,
    };
  });
}
