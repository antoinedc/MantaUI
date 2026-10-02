// ===== Tool activity: wording, grouping and transcript layout =====
//
// The transcript shows only text. Every run of consecutive tool calls (and
// file-save "patch" checkpoints) collapses into ONE quiet line; while a turn is
// running, the run at the very tail is shown in the working line instead of
// inline. This module is the pure half of that: it decides the WORDS
// (`describeActivity`, `summarizeToolGroup`) and the SHAPE (`layoutTranscript`,
// `stabilizeLayout`). Rendering lives in ToolGroup.tsx / MessageRow.tsx /
// Transcript.tsx. No React, no DOM — fully unit-tested in toolActivity.test.ts.

import type { OpencodeMessage, OpencodePart } from "../shared/types";
import { isRenderableMessage, visibleAssistantParts } from "./chatUtils";

// ===== Wording =====

export type ActivityStatus = "pending" | "running" | "completed" | "error";

type ActivityKind =
  | "read"
  | "edit"
  | "write"
  | "bash"
  | "search"
  | "list"
  | "fetch"
  | "websearch"
  | "task"
  | "skill"
  | "question"
  | "other"
  | "patch";

export type Activity = {
  /** Category the run summary tallies by (grep/glob/codesearch share one). */
  kind: ActivityKind;
  status: ActivityStatus;
  /** Present-tense label ("Editing Transcript.tsx"). */
  running: string;
  /** Past-tense label ("Edited Transcript.tsx"). */
  done: string;
  /** Failure label ("Failed to edit Transcript.tsx"). */
  failed: string;
  /** The label for the part's CURRENT status. */
  label: string;
  /** Run-summary phrase for n calls of this kind ("edited 3 files"). */
  plural: (n: number) => string;
  /** False for patch parts: they join a run but are not a "tool". */
  counted: boolean;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const BASH_DETAIL_MAX = 60;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "mcp_Axiom_queryApl" → "Axiom queryApl". */
function humanizeToolName(tool: string): string {
  const name = tool.replace(/^mcp[_-]/i, "");
  const words = name.split(/[_-]+/).filter(Boolean);
  return words.length > 0 ? words.join(" ") : tool;
}

export function normalizeToolStatus(status: unknown): ActivityStatus {
  return status === "completed" || status === "error" || status === "running"
    ? status
    : "pending";
}

const filePath = (input: Record<string, unknown>): string =>
  str(input.filePath) || str(input.file_path) || str(input.path);

type Tense = { running: string; done: string; failed: string };

/** `${verb} ${detail}`, with no trailing space when the detail is empty. */
const withDetail = (verb: string, detail: string): string =>
  detail ? `${verb} ${detail}` : verb;

function describeToolPart(part: OpencodePart): Activity {
  const rec = asRecord(part);
  const tool = String(rec.tool ?? "").toLowerCase();
  const state = asRecord(rec.state);
  const input = asRecord(state.input);
  const status = normalizeToolStatus(state.status);
  const title = str(state.title);

  const make = (
    kind: ActivityKind,
    tense: Tense,
    plural: (n: number) => string,
  ): Activity => ({
    kind,
    status,
    ...tense,
    label:
      status === "completed" ? tense.done : status === "error" ? tense.failed : tense.running,
    plural,
    counted: true,
  });

  const verbs = (run: string, done: string, fail: string, detail: string): Tense => ({
    running: withDetail(run, detail),
    done: withDetail(done, detail),
    failed: withDetail(fail, detail),
  });
  const files = (one: string, many: string) => (n: number) =>
    n === 1 ? one : many.replace("{n}", String(n));

  switch (tool) {
    case "read":
      return make(
        "read",
        verbs("Reading", "Read", "Failed to read", basename(filePath(input)) || title),
        files("read a file", "read {n} files"),
      );
    case "edit":
    case "multiedit":
    case "apply_patch":
    case "patch":
      return make(
        "edit",
        verbs("Editing", "Edited", "Failed to edit", basename(filePath(input)) || title),
        files("edited a file", "edited {n} files"),
      );
    case "write":
      return make(
        "write",
        verbs("Writing", "Wrote", "Failed to write", basename(filePath(input)) || title),
        files("wrote a file", "wrote {n} files"),
      );
    case "bash": {
      const command = str(input.command).split("\n")[0]?.trim() ?? "";
      const detail = clip(str(input.description) || command || title, BASH_DETAIL_MAX);
      // A shell call's own description IS the label ("Run the tests"). With no
      // description, command or title at all (a pending part), fall back to a
      // generic phrase rather than an empty line.
      return make(
        "bash",
        detail
          ? { running: detail, done: detail, failed: `Failed: ${detail}` }
          : { running: "Running a command", done: "Ran a command", failed: "Failed to run a command" },
        files("ran a command", "ran {n} commands"),
      );
    }
    case "grep":
    case "glob":
    case "codesearch":
      return make(
        "search",
        verbs("Searching", "Searched", "Failed to search", str(input.pattern) || str(input.query) || title),
        files("searched code", "ran {n} searches"),
      );
    case "list":
    case "ls":
      return make(
        "list",
        verbs("Listing", "Listed", "Failed to list", basename(str(input.path)) || title),
        files("listed a directory", "listed {n} directories"),
      );
    case "webfetch":
    case "web_fetch":
      return make(
        "fetch",
        verbs("Fetching", "Fetched", "Failed to fetch", hostOf(str(input.url)) || title),
        files("fetched a page", "fetched {n} pages"),
      );
    case "websearch":
    case "web_search":
      return make(
        "websearch",
        (() => {
          const q = str(input.query) || title;
          // "…the web for" reads wrong with nothing after it.
          return q
            ? verbs("Searching the web for", "Searched the web for", "Failed to search the web for", q)
            : { running: "Searching the web", done: "Searched the web", failed: "Failed to search the web" };
        })(),
        (n) => (n === 1 ? "searched the web" : `searched the web ${n} times`),
      );
    case "task":
      return make(
        "task",
        {
          running: withDetail("Running agent", str(input.description) || title),
          done: withDetail("Ran agent", str(input.description) || title),
          failed: withDetail("Agent failed:", str(input.description) || title),
        },
        files("ran an agent", "ran {n} agents"),
      );
    case "skill":
      return make(
        "skill",
        verbs("Loading skill", "Loaded skill", "Failed to load skill", str(input.name) || title),
        files("loaded a skill", "loaded {n} skills"),
      );
    case "question":
      return make(
        "question",
        { running: "Asking", done: "Asked", failed: "Failed to ask" },
        files("asked a question", "asked {n} questions"),
      );
    default: {
      const name = humanizeToolName(String(rec.tool ?? "tool"));
      return make(
        "other",
        { running: `Using ${name}`, done: `Used ${name}`, failed: `Failed: ${name}` },
        files("used a tool", "used {n} tools"),
      );
    }
  }
}

function describePatchPart(part: OpencodePart): Activity {
  const patchFiles = Array.isArray(part.files) ? (part.files as unknown[]) : [];
  const detail =
    patchFiles.length === 1
      ? basename(String(patchFiles[0]))
      : patchFiles.length > 1
        ? `${patchFiles.length} files`
        : "";
  const running = withDetail("Saving", detail);
  const done = detail ? `Saved changes to ${detail}` : "Saved changes";
  return {
    kind: "patch",
    status: "completed",
    running,
    done,
    // A checkpoint cannot fail; kept equal to `done` so callers never branch.
    failed: done,
    label: done,
    plural: (n) => (n === 1 ? "saved a change" : `saved ${n} changes`),
    counted: false,
  };
}

/** Labels for one tool or patch part (see the wording table in the PR). */
export function describeActivity(part: OpencodePart): Activity {
  return part.type === "patch" ? describePatchPart(part) : describeToolPart(part);
}

// ===== Run summary =====

export type ToolGroup = {
  /** The first item's part id — stable while the run grows. */
  id: string;
  /** Tool and patch parts, in transcript order. */
  items: OpencodePart[];
};

export type GroupSummary = {
  /** One-line summary of the run, e.g. "Read 3 files, ran a command". */
  label: string;
  /** The latest tool that has not finished (running OR pending), if any. */
  live: Activity | null;
  /** Tool calls in the run — patch parts are not counted. */
  calls: number;
  /** Tool calls that errored. */
  failed: number;
  /** True while any tool call is unfinished. */
  running: boolean;
};

const MAX_SUMMARY_CATEGORIES = 3;

export function summarizeToolGroup(items: OpencodePart[]): GroupSummary {
  const activities = items.map(describeActivity);
  const tools = activities.filter((a) => a.counted);
  // Patches are file-save checkpoints that trail an edit, not separate
  // activities: once the run has any tool call they stay out of the wording
  // AND out of the one-vs-many decision ("Edited X", not "Edited a file, saved
  // a change"). A run made only of patches is the one place they speak.
  const described = tools.length > 0 ? tools : activities;
  const failed = tools.filter((a) => a.status === "error").length;
  const unfinished = tools.filter((a) => a.status !== "completed" && a.status !== "error");
  const live = unfinished.length > 0 ? unfinished[unfinished.length - 1] : null;

  let label: string;
  if (described.length === 1) {
    const only = described[0];
    label = only.status === "error" ? only.failed : only.done;
  } else {
    const order: ActivityKind[] = [];
    const tally = new Map<ActivityKind, { n: number; plural: Activity["plural"] }>();
    for (const a of described) {
      const t = tally.get(a.kind);
      if (t) t.n++;
      else {
        order.push(a.kind);
        tally.set(a.kind, { n: 1, plural: a.plural });
      }
    }
    if (order.length > MAX_SUMMARY_CATEGORIES) {
      label = `Used ${tools.length} tools`;
    } else {
      const text = order.map((k) => tally.get(k)!.plural(tally.get(k)!.n)).join(", ");
      label = text.charAt(0).toUpperCase() + text.slice(1);
    }
  }

  return { label, live, calls: tools.length, failed, running: live != null };
}

export type GroupTone = "ok" | "warn" | "running";

/** Dot tone for a run: running while unfinished, warn if any failed, else ok. */
export function groupTone(s: GroupSummary): GroupTone {
  return s.running ? "running" : s.failed > 0 ? "warn" : "ok";
}

// ===== Layout =====

export type Block =
  | { kind: "part"; part: OpencodePart }
  | { kind: "tools"; group: ToolGroup };

export type TranscriptLayout = {
  /** Blocks each assistant message draws. Absorbed messages map to []. */
  blocksByMessage: Map<string, Block[]>;
  /** The run at the very tail while a turn runs (drawn by the working line). */
  trailing: ToolGroup | null;
};

function isToolPart(p: OpencodePart): boolean {
  return p.type === "tool";
}

/**
 * Lay the transcript out as blocks.
 *
 * - A run is consecutive tool + patch parts; it SPANS assistant messages
 *   (opencode writes one message per model step) and belongs to the message
 *   where it starts — later messages it absorbed draw nothing.
 * - Anything else that draws (text, shown reasoning, media/file, unknown
 *   parts) ends the run. Hidden reasoning draws nothing, so it is transparent.
 * - A user message that draws ends the run. todowrite is already filtered by
 *   `visibleAssistantParts`.
 * - While `running`, a run that nothing follows is withheld as `trailing`.
 */
export function layoutTranscript(
  messages: OpencodeMessage[],
  opts: { running: boolean; showThinking: boolean },
): TranscriptLayout {
  const blocksByMessage = new Map<string, Block[]>();
  let run: { group: ToolGroup; ownerId: string; block: Block } | null = null;

  for (const msg of messages) {
    if (msg.info.role === "user") {
      if (isRenderableMessage(msg)) run = null;
      continue;
    }
    const blocks: Block[] = [];
    blocksByMessage.set(msg.info.id, blocks);
    for (const part of visibleAssistantParts(msg)) {
      if (isToolPart(part) || part.type === "patch") {
        if (run) {
          run.group.items.push(part);
        } else {
          const group: ToolGroup = { id: part.id, items: [part] };
          const block: Block = { kind: "tools", group };
          blocks.push(block);
          run = { group, ownerId: msg.info.id, block };
        }
        continue;
      }
      if (part.type === "reasoning") {
        // Empty reasoning never draws; hidden reasoning is transparent.
        if (!opts.showThinking || !(part.text ?? "").replace(/^\n+|\n+$/g, "")) continue;
      }
      blocks.push({ kind: "part", part });
      run = null;
    }
  }

  let trailing: ToolGroup | null = null;
  if (opts.running && run) {
    trailing = run.group;
    const owner = blocksByMessage.get(run.ownerId);
    if (owner) {
      const i = owner.indexOf(run.block);
      if (i >= 0) owner.splice(i, 1);
    }
  }
  return { blocksByMessage, trailing };
}

function sameGroup(a: ToolGroup, b: ToolGroup): boolean {
  return (
    a.id === b.id &&
    a.items.length === b.items.length &&
    a.items.every((p, i) => p === b.items[i])
  );
}

function sameBlock(a: Block, b: Block): boolean {
  if (a.kind === "part") return b.kind === "part" && a.part === b.part;
  return b.kind === "tools" && sameGroup(a.group, b.group);
}

/**
 * Reuse the previous layout's block arrays and groups wherever their part
 * references are unchanged. MessageRow is `React.memo`'d; handing it fresh
 * block arrays on every streaming delta would re-render every row.
 * Returns `prev` itself when nothing changed at all.
 */
export function stabilizeLayout(
  prev: TranscriptLayout | null,
  next: TranscriptLayout,
): TranscriptLayout {
  if (!prev) return next;
  let changed = prev.blocksByMessage.size !== next.blocksByMessage.size;
  const blocksByMessage = new Map<string, Block[]>();
  for (const [id, blocks] of next.blocksByMessage) {
    const old = prev.blocksByMessage.get(id);
    if (old && old.length === blocks.length && old.every((b, i) => sameBlock(b, blocks[i]))) {
      blocksByMessage.set(id, old);
      continue;
    }
    changed = true;
    // Keep per-block identity where possible (a group whose message gained a
    // sibling block should still be the same object for ToolGroupRow's memo).
    blocksByMessage.set(
      id,
      old ? blocks.map((b, i) => (old[i] && sameBlock(old[i], b) ? old[i] : b)) : blocks,
    );
  }
  let trailing = next.trailing;
  if (prev.trailing && trailing && sameGroup(prev.trailing, trailing)) trailing = prev.trailing;
  if (trailing !== prev.trailing) changed = true;
  return changed ? { blocksByMessage, trailing } : prev;
}

// ===== Row predicate =====

/**
 * Single source of truth for "does this transcript row draw anything", shared
 * by MessageRow's own guard and by Transcript's Virtuoso data filter. A row
 * that draws nothing must never reach Virtuoso (BET-874: a zero-height item
 * poisons its size cache). An assistant row draws when it owns blocks, media,
 * a widget, or a turn footer / truncation badge.
 */
export function isRenderableRow(
  msg: OpencodeMessage,
  ctx: {
    blocks: readonly Block[] | undefined;
    hasMedia: boolean;
    hasWidget: boolean;
    hasFooter: boolean;
  },
): boolean {
  if (msg.info.role === "user") return isRenderableMessage(msg);
  return (
    (ctx.blocks?.length ?? 0) > 0 || ctx.hasMedia || ctx.hasWidget || ctx.hasFooter
  );
}

// ===== Jump targets =====

/**
 * Where a message lives in the virtualized list.
 *  - `index`: 0-based index into the visible (Virtuoso data) list — the
 *    argument `scrollToIndex` takes, independent of `firstItemIndex`.
 *  - `rowId`: id of the visible row that actually DRAWS the message, i.e. the
 *    element carrying `data-message-id` to flash.
 */
export type RowLocation = { index: number; rowId: string };

/**
 * Resolve a message id to the visible row that draws it.
 *
 * Rows that draw nothing never reach Virtuoso, so a message id is not always a
 * row id. Tool-only assistant messages a run spilled into are absorbed into
 * the run's owning row, and artifacts produced by tool calls point at exactly
 * those messages. Resolution order:
 *  1. the message itself, if it is a visible row;
 *  2. an absorbed message → the row owning the run that holds its parts (a run
 *     still in the working line, i.e. the trailing one, → the last visible row);
 *  3. hidden for any other reason → the nearest preceding visible row (the
 *     first visible row when nothing precedes it).
 * Unknown ids, and an empty visible list, give null.
 */
export function locateVisibleRow(
  messageId: string,
  messages: readonly OpencodeMessage[],
  visible: readonly OpencodeMessage[],
  layout: TranscriptLayout,
): RowLocation | null {
  const target = messages.findIndex((m) => m.info.id === messageId);
  if (target < 0 || visible.length === 0) return null;

  const indexOfVisible = new Map<string, number>();
  visible.forEach((m, i) => indexOfVisible.set(m.info.id, i));
  const at = (id: string): RowLocation | null => {
    const index = indexOfVisible.get(id);
    return index === undefined ? null : { index, rowId: id };
  };

  const own = at(messageId);
  if (own) return own;

  const partIds = new Set(messages[target].parts.map((p) => p.id));
  const holdsPart = (g: ToolGroup) => g.items.some((p) => partIds.has(p.id));

  if (layout.trailing && holdsPart(layout.trailing)) {
    return at(visible[visible.length - 1].info.id);
  }
  for (const [ownerId, blocks] of layout.blocksByMessage) {
    if (blocks.some((b) => b.kind === "tools" && holdsPart(b.group))) {
      const owner = at(ownerId);
      if (owner) return owner;
    }
  }

  for (let i = target - 1; i >= 0; i--) {
    const prev = at(messages[i].info.id);
    if (prev) return prev;
  }
  return at(visible[0].info.id);
}
