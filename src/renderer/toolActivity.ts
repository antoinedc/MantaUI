// ===== Tool activity: layout of the box's runs =====
//
// The transcript shows only text. Every run of consecutive tool calls (and file-save "patch" checkpoints) collapses into
// ONE quiet line; while a turn is running, the run at the very tail is shown in the working line instead of inline.
//
// WS11 D11: what a run SAYS ("Read 3 files, ran a command"), its tone, and which parts belong to it are the BOX's
// (src/server/transcriptRuns.mjs; `part.view.runId`, `message.view.runs`, the live `toolRuns` frame). This module keeps only
// the SHAPE: where a run's block is drawn (`layoutTranscript`), reusing blocks across renders (`stabilizeLayout`), and the
// pure revision merge that keeps the newest value of a run whatever order answers arrive in (`mergeRunViews`).
// No React, no DOM — unit-tested in toolActivity.test.ts.

import type { OpencodeMessage, OpencodePart, PartView, RunRef, RunSegmentView, RunSummaryView, RunView } from "../shared/types";
import { isRenderableMessage, visibleAssistantParts } from "./chatUtils";
import { isHandoffToolPart } from "./handoff";

export type { RunRef, RunView, RunSummaryView } from "../shared/types";
export type GroupTone = RunSummaryView["tone"];

// ===== Run revisions =====

/** Per-session run values, tagged with the epoch they belong to. Immutable: every reducer returns a new state on change. */
export type RunMap = {
  epoch: string | null;
  runs: ReadonlyMap<string, RunView>;
  /** The highest `gen` seen in the current epoch; anything older is a retired membership. */
  minGen: number;
  /** Writes that arrived before the connection's first `runningSet` told us the epoch. */
  queue: ReadonlyArray<{ values: ReadonlyArray<RunView | RunRef>; issuedConnGen: number | undefined }>;
};
export const emptyRunMap = (): RunMap => ({ epoch: null, runs: new Map(), minGen: 0, queue: [] });

export type RunMergeCtx = {
  /** The epoch of the LATEST connection's `runningSet` (null until it arrives). */
  currentEpoch: string | null;
  /** The connection generation NOW. */
  connGen: number;
  /** The connection generation an RPC response was ISSUED under (undefined for a live frame). */
  issuedConnGen?: number;
};

const isRef = (v: RunView | RunRef): v is RunRef => (v as RunRef).ref === true;

/**
 * The connection's epoch became known / changed: runs of another epoch are dropped, queued writes apply. The SAME epoch
 * announced again (a reconnect to the same box process) keeps the runs but still drains what queued while the connection's
 * epoch was unknown — those writes were held for exactly this announcement.
 */
export function setRunEpoch(state: RunMap, epoch: string | null, connGen = 0): RunMap {
  if (epoch === state.epoch) {
    if (epoch == null || state.queue.length === 0) return state;
    let same: RunMap = { ...state, queue: [] };
    for (const q of state.queue) same = mergeRunViews(same, q.values, { currentEpoch: epoch, connGen, issuedConnGen: q.issuedConnGen });
    return same;
  }
  let next: RunMap = { epoch, runs: new Map(), minGen: 0, queue: [] };
  if (epoch != null) {
    for (const q of state.queue) next = mergeRunViews(next, q.values, { currentEpoch: epoch, connGen, issuedConnGen: q.issuedConnGen });
  }
  return next;
}

/** Keep only the runs in `keep` (a full transcript answer replaced the loaded messages): the rest are no longer drawn. */
export function pruneRunMap(state: RunMap, keep: ReadonlySet<string>): RunMap {
  let runs: Map<string, RunView> | null = null;
  for (const id of state.runs.keys()) {
    if (keep.has(id)) continue;
    if (!runs) runs = new Map(state.runs);
    runs.delete(id);
  }
  return runs ? { ...state, runs } : state;
}

/** Every run id the messages reference: parts' `runId`, and the runs their `view.runs` carry (full or ref). */
export function runIdsOfMessages(messages: readonly OpencodeMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      const id = partView(p)?.runId;
      if (id) ids.add(id);
    }
    for (const r of m.view?.runs ?? []) ids.add(r.id);
  }
  return ids;
}

/**
 * Merge incoming run values. Rules (spec "Run revisions"): a value of another epoch is rejected; a response issued under an
 * older connection is discarded; before the epoch is known writes queue; within the epoch an incoming value wins iff its
 * `gen` is higher, or equal with `seq >=` (idempotent); anything older than `minGen` is a retired membership; refs never
 * overwrite.
 */
export function mergeRunViews(state: RunMap, incoming: ReadonlyArray<RunView | RunRef>, ctx: RunMergeCtx): RunMap {
  if (ctx.issuedConnGen !== undefined && ctx.issuedConnGen < ctx.connGen) return state;
  if (ctx.currentEpoch == null) {
    return incoming.length === 0 ? state : { ...state, queue: [...state.queue, { values: incoming, issuedConnGen: ctx.issuedConnGen }] };
  }
  let base = state;
  if (state.epoch !== ctx.currentEpoch) base = { epoch: ctx.currentEpoch, runs: new Map(), minGen: 0, queue: state.queue };
  let runs: Map<string, RunView> | null = null;
  let minGen = base.minGen;
  for (const v of incoming) {
    if (isRef(v) || v.rev.epoch !== ctx.currentEpoch || v.rev.gen < minGen) continue;
    const cur = (runs ?? base.runs).get(v.id);
    if (cur && (v.rev.gen < cur.rev.gen || (v.rev.gen === cur.rev.gen && v.rev.seq < cur.rev.seq))) continue;
    if (!runs) runs = new Map(base.runs);
    runs.set(v.id, v);
    if (v.rev.gen > minGen) minGen = v.rev.gen;
  }
  if (!runs && base === state) return state;
  return { epoch: base.epoch, runs: runs ?? base.runs, minGen, queue: base.queue };
}

/** A canonical rebuild (`toolRuns` `rebuilt:true`): delete the retired ids and raise `minGen`. */
export function applyRunRebuild(state: RunMap, retired: ReadonlyArray<string>, gen: number): RunMap {
  const runs = new Map(state.runs);
  for (const id of retired) runs.delete(id);
  return { ...state, runs, minGen: Math.max(state.minGen, gen) };
}

/** The full (non-ref) run views the messages carry, in message order. */
export function runViewsOf(messages: readonly OpencodeMessage[] | null | undefined): RunView[] {
  const out: RunView[] = [];
  for (const m of messages ?? []) for (const v of m.view?.runs ?? []) if (!isRef(v)) out.push(v);
  return out;
}

/** True when a message's parts carry a membership older than `minGen` (a splice issued before a rebuild): refetch. */
export function hasStaleMembership(messages: readonly OpencodeMessage[], minGen: number): boolean {
  if (minGen <= 0) return false;
  return messages.some((m) => m.parts.some((p) => ((p as { view?: PartView }).view?.gen ?? minGen) < minGen));
}

// ===== Layout =====

export type ToolGroup = {
  /** The run's id, or — with reasoning shown — the id of one of its SEGMENTS. Stable while the run grows. */
  id: string;
  /** Tool and patch parts, in transcript order. */
  items: OpencodePart[];
  /** The box's summary of the run (or of this segment). */
  view: RunSummaryView;
  /** True for the stand-in line of a box without `transcript-runs-1` (raw calls + an update note). */
  fallback?: true;
};

export type Block =
  | { kind: "part"; part: OpencodePart }
  | { kind: "tools"; group: ToolGroup };

export type TranscriptLayout = {
  /** Blocks each assistant message draws. Absorbed messages map to []. */
  blocksByMessage: Map<string, Block[]>;
  /** The run at the very tail while a turn runs (drawn by the working line). */
  trailing: ToolGroup | null;
};

const partView = (p: OpencodePart): PartView | undefined => (p as { view?: PartView }).view;
const isRunPart = (p: OpencodePart): boolean => (p.type === "tool" && !isHandoffToolPart(p)) || p.type === "patch";
const FALLBACK_VIEW: RunSummaryView = { label: "Tool activity", calls: 0, failed: 0, tone: "ok", live: null };

/**
 * Lay the transcript out as blocks, by the box's run ids.
 *
 * - A tool/patch part draws in the block of its `view.runId`; the block sits where the run's FIRST in-window part is
 *   (later messages that add to it draw nothing). With reasoning shown a run that reasoning split draws one block per
 *   SEGMENT; hidden, the segments collapse into one block at the first.
 * - Anything else that draws (non-blank text, shown reasoning, media/file, unknown parts) is its own block. A
 *   whitespace-only text part is paragraph noise and draws nothing. A `handoff` call is a card of its own.
 * - A tool part with no `runId` (an older box) draws as a part; with `runsAvailable === false` each assistant message's calls
 *   collapse into ONE neutral line instead.
 * - While `running`, a run block that nothing follows is withheld as `trailing`.
 */
export function layoutTranscript(
  messages: OpencodeMessage[],
  opts: {
    running: boolean;
    showThinking: boolean;
    /** The rev-merged run map; a run it lacks falls back to the full view a message carries. */
    runs?: ReadonlyMap<string, RunView>;
    /** Parts with `view.gen` below this are a retired membership: their run id is ignored for layout. */
    minGen?: number;
    runsAvailable?: boolean | null;
  },
): TranscriptLayout {
  const blocksByMessage = new Map<string, Block[]>();
  const groups = new Map<string, ToolGroup>();
  const carried = new Map<string, RunView>();
  for (const v of runViewsOf(messages)) if (!carried.has(v.id)) carried.set(v.id, v);
  const minGen = opts.minGen ?? 0;
  let last: { ownerId: string; block: Block } | null = null;

  // With reasoning shown a block is ONE SEGMENT of its run and says only that segment (the first segment's id is the run id);
  // hidden, the run's blocks collapse and the whole run speaks.
  const summaryFor = (runId: string, key: string): RunSummaryView => {
    const run = opts.runs?.get(runId) ?? carried.get(runId);
    if (!run) return FALLBACK_VIEW;
    if (opts.showThinking) {
      const seg = run.segments?.find((s: RunSegmentView) => s.id === key);
      if (seg) return seg;
    }
    return run;
  };

  for (const msg of messages) {
    if (msg.info.role === "user") {
      if (isRenderableMessage(msg)) last = null;
      continue;
    }
    const blocks: Block[] = [];
    blocksByMessage.set(msg.info.id, blocks);
    const push = (block: Block) => {
      blocks.push(block);
      last = { ownerId: msg.info.id, block };
    };
    let fallbackGroup: ToolGroup | null = null;
    for (const part of visibleAssistantParts(msg)) {
      if (isRunPart(part)) {
        if (opts.runsAvailable === false) {
          if (!fallbackGroup) {
            fallbackGroup = { id: `tools:${msg.info.id}`, items: [], view: FALLBACK_VIEW, fallback: true };
            push({ kind: "tools", group: fallbackGroup });
          }
          fallbackGroup.items.push(part);
          fallbackGroup.view = { ...FALLBACK_VIEW, calls: fallbackGroup.items.filter((p) => p.type === "tool").length };
          continue;
        }
        const v = partView(part);
        const runId = v?.runId && (v.gen ?? minGen) >= minGen ? v.runId : null;
        if (!runId) {
          push({ kind: "part", part });
          continue;
        }
        const split = opts.showThinking && v?.segmentId ? v.segmentId : runId;
        const existing = groups.get(split);
        if (existing) {
          existing.items.push(part);
          continue;
        }
        const group: ToolGroup = { id: split, items: [part], view: summaryFor(runId, split) };
        groups.set(split, group);
        push({ kind: "tools", group });
        continue;
      }
      if (part.type === "text" && (part.text ?? "").trim() === "") continue;
      if (part.type === "reasoning" && (!opts.showThinking || (part.text ?? "").replace(/^\n+|\n+$/g, "") === "")) continue;
      push({ kind: "part", part });
    }
  }

  // Views follow the rev-merged map even for a group created earlier in the walk.
  for (const [key, g] of groups) {
    const runId = partView(g.items[0])?.runId;
    if (runId) g.view = summaryFor(runId, key);
  }

  let trailing: ToolGroup | null = null;
  const tail = last as { ownerId: string; block: Block } | null;
  if (opts.running && tail && tail.block.kind === "tools") {
    trailing = tail.block.group;
    const owner = blocksByMessage.get(tail.ownerId);
    const i = owner ? owner.indexOf(tail.block) : -1;
    if (owner && i >= 0) owner.splice(i, 1);
  }
  return { blocksByMessage, trailing };
}

const sameView = (a: RunSummaryView, b: RunSummaryView): boolean =>
  a === b ||
  (a.label === b.label &&
    a.calls === b.calls &&
    a.failed === b.failed &&
    a.tone === b.tone &&
    a.live?.label === b.live?.label &&
    a.live?.kind === b.live?.kind);

function sameGroup(a: ToolGroup, b: ToolGroup): boolean {
  return (
    a.id === b.id &&
    a.fallback === b.fallback &&
    sameView(a.view, b.view) &&
    a.items.length === b.items.length &&
    a.items.every((p, i) => p === b.items[i])
  );
}

function sameBlock(a: Block, b: Block): boolean {
  if (a.kind === "part") return b.kind === "part" && a.part === b.part;
  return b.kind === "tools" && sameGroup(a.group, b.group);
}

/**
 * Reuse the previous layout's block arrays and groups wherever their part references and run views are unchanged.
 * MessageRow is `React.memo`'d; handing it fresh block arrays on every streaming delta would re-render every row.
 * Run views compare by content (their `rev` moves with every change). Returns `prev` itself when nothing changed at all.
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
