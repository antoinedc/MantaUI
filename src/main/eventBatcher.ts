// Main-process backpressure pump for the opencode → renderer event stream.
//
// This is the stage-4 (BET-46.4) server/main half of BET-46 Risk #2: opencode
// can flood the renderer with events (delta storms on a long assistant turn,
// vcs.branch.updated churn on a busy repo). Left unthrottled, every frame is
// IPC-forwarded to the renderer one at a time, which under load pins the
// renderer redraw loop and starves the UI.
//
// The pure coalesce/drop/rate-limit policy lives in the shared primitive
// `applyBackpressure` (src/shared/net/backpressure.ts, BET-46.1). That
// primitive operates on a BATCH of events; this class is the thin, stateful
// adapter that turns the main-process one-event-at-a-time stream into batches,
// runs the policy over each batch, and forwards the survivors — WITHOUT ever
// delaying a high-priority event.
//
// Design (the two guarantees that matter):
//
//  1. HIGH-PRIORITY events (permission.asked, question.asked — Risk #2) are
//     NEVER buffered, coalesced, or dropped. They flush the pending batch and
//     emit synchronously, so a permission prompt reaches the user with zero
//     added latency. This is enforced twice: structurally here (immediate
//     path) AND in the primitive's forced high-priority set (defense in depth).
//
//  2. Everything else is buffered for at most `windowMs` (default 50ms) and
//     flushed as a batch through `applyBackpressure`. Coalescing collapses
//     consecutive same-part deltas; dropping sheds `dropTypes` only when the
//     batch exceeds `maxPerSec`. Under normal load the batch is tiny and
//     nothing is coalesced/dropped — the added latency is one animation frame.
//
// Timers are injectable so the batching is unit-testable with fake timers.

import { applyBackpressure } from "../shared/net/backpressure.js";

// The main-process bus event shape: opencode frames are `{id?, type, properties}`
// (see src/shared/types.ts OpencodeEvent). The coalesce key fields
// (sessionID / partID) live UNDER `properties`, whereas the shared
// backpressure primitive reads them at the top level. `push()` accepts this
// bus shape; the batcher lifts the key fields into the primitive's shape for
// the policy pass, then emits the ORIGINAL event object unchanged.
export interface BusEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Events that must bypass batching entirely — see BET-46 Risk #2. */
export const HIGH_PRIORITY_TYPES = ["permission.asked", "question.asked"] as const;

export type TimerHandle = unknown;

export interface EventBatcherOpts {
  /**
   * Forward one survivor event to its sink (the renderer via
   * `webContents.send`, or the mobile bus). Called in batch order.
   */
  emit: (ev: BusEvent) => void;
  /** Flush window in ms. Buffered events flush after this long. Defaults to 50. */
  windowMs?: number;
  /** Soft cap on events per flushed batch before drop-types get shed. Defaults to 100. */
  maxPerSec?: number;
  /** Event types whose consecutive same-key runs coalesce. Uses primitive default when omitted. */
  coalesceTypes?: string[];
  /** Event types shed first when a batch is over cap. Uses primitive default when omitted. */
  dropTypes?: string[];
  /**
   * Extra never-drop/never-coalesce types on top of the always-forced
   * permission.asked/question.asked. Defaults to none.
   */
  highPriorityTypes?: string[];
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (h: TimerHandle) => void;
}

/**
 * Batching backpressure pump. Push events in with {@link push}; survivors are
 * delivered to `emit` after the flush window (or immediately, for
 * high-priority events). Call {@link flush} to drain synchronously (e.g. before
 * teardown) and {@link stop} to cancel a pending flush.
 */
export class EventBatcher {
  private readonly emit: (ev: BusEvent) => void;
  private readonly windowMs: number;
  private readonly maxPerSec: number;
  private readonly coalesceTypes?: string[];
  private readonly dropTypes?: string[];
  private readonly highPriorityTypes: string[];
  private readonly highPrioritySet: Set<string>;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (h: TimerHandle) => void;

  private buffer: BusEvent[] = [];
  private timer: TimerHandle | null = null;

  constructor(opts: EventBatcherOpts) {
    this.emit = opts.emit;
    this.windowMs = opts.windowMs ?? 50;
    this.maxPerSec = opts.maxPerSec ?? 100;
    this.coalesceTypes = opts.coalesceTypes;
    this.dropTypes = opts.dropTypes;
    this.highPriorityTypes = opts.highPriorityTypes ?? [];
    // The always-forced set + any caller extras. permission.asked/question.asked
    // are forced by the primitive too; we mirror them here so the immediate-path
    // check matches the primitive's guarantee.
    this.highPrioritySet = new Set([
      ...HIGH_PRIORITY_TYPES,
      ...this.highPriorityTypes,
    ]);
    this.setTimeoutFn =
      opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Ingest one event from the opencode stream.
   *
   * - High-priority events flush any pending batch (to preserve ordering) then
   *   emit immediately — zero added latency, never dropped/coalesced.
   * - Everything else is buffered; the first buffered event since the last
   *   flush arms the flush timer.
   */
  push(ev: BusEvent): void {
    if (this.highPrioritySet.has(ev.type)) {
      // Preserve global ordering: drain whatever is buffered first, then emit
      // the high-priority event synchronously.
      this.flush();
      this.emit(ev);
      return;
    }
    this.buffer.push(ev);
    if (this.timer === null) {
      this.timer = this.setTimeoutFn(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
    }
  }

  /** Drain the pending batch synchronously through the backpressure policy. */
  flush(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    // Lift the coalesce-key fields (sessionID/partID) out of `properties` into
    // the shape the shared primitive reads, keeping a back-reference to the
    // original bus event so we emit the untouched object. `__orig` is stripped
    // by the primitive's coalesce (it replaces the whole object, keeping the
    // later event's __orig) and never reaches `emit`.
    const shims = batch.map((ev) => {
      const props = (ev.properties ?? {}) as {
        sessionID?: unknown;
        partID?: unknown;
      };
      return {
        type: ev.type,
        sessionID: typeof props.sessionID === "string" ? props.sessionID : undefined,
        partID: typeof props.partID === "string" ? props.partID : undefined,
        __orig: ev,
      };
    });
    const survivors = applyBackpressure(shims, {
      maxPerSec: this.maxPerSec,
      coalesceTypes: this.coalesceTypes,
      dropTypes: this.dropTypes,
      highPriorityTypes: this.highPriorityTypes,
    });
    for (const s of survivors) {
      const orig = (s as { __orig?: BusEvent }).__orig;
      if (orig) this.emit(orig);
    }
  }

  /** Cancel a pending flush and discard the buffer (teardown; no emit). */
  stop(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }
}
