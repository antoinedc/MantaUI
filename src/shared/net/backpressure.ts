// Event backpressure: coalesce, drop, and rate-limit opencode events.
//
// Pure/deterministic given its inputs — no wall-clock reads. Operates on a
// single batch of events so it is trivially testable.

/** Minimal shape of an opencode event that the backpressure logic needs. */
export interface OpencodeEvent {
  type: string;
  sessionID?: string;
  partID?: string;
  [k: string]: unknown;
}

export interface BackpressureOpts {
  /** Soft cap on events per batch before drop-types get dropped. Defaults to 100. */
  maxPerSec?: number;
  /**
   * Event types whose consecutive same-key runs collapse to the last event.
   * Defaults to `["message.part.delta"]`.
   */
  coalesceTypes?: string[];
  /**
   * Event types dropped first when the batch is over `maxPerSec`.
   * Defaults to `["vcs.branch.updated"]`.
   */
  dropTypes?: string[];
  /**
   * Event types that must NEVER be dropped or coalesced away, no matter how far
   * the batch floods past `maxPerSec`. `"permission.asked"` and
   * `"question.asked"` are always forced into this set.
   */
  highPriorityTypes: string[];
}

const DEFAULT_COALESCE = ["message.part.delta"];
const DEFAULT_DROP = ["vcs.branch.updated"];
// Hard-guaranteed pass-through events — see BET-46 Risk #2.
const FORCED_HIGH_PRIORITY = ["permission.asked", "question.asked"];

/** Coalesce key: same type + session + part collapse to the latest event. */
function coalesceKey(e: OpencodeEvent): string {
  return `${e.type}\u0000${e.sessionID ?? ""}\u0000${e.partID ?? ""}`;
}

/**
 * Apply backpressure to a batch of events, preserving relative order of the
 * survivors.
 *
 * 1. **Coalesce**: for types in `coalesceTypes`, collapse consecutive events
 *    sharing the same `(type, sessionID, partID)` into the LAST one.
 * 2. **Drop under load**: if the coalesced batch length exceeds `maxPerSec`,
 *    drop events whose type ∈ `dropTypes`, oldest first, until at or below the
 *    cap (or no more droppable events remain).
 *
 * High-priority types are never coalesced away and never dropped.
 */
export function applyBackpressure(
  events: OpencodeEvent[],
  opts: BackpressureOpts,
): OpencodeEvent[] {
  const maxPerSec = opts.maxPerSec ?? 100;
  const coalesceTypes = new Set(opts.coalesceTypes ?? DEFAULT_COALESCE);
  const dropTypes = new Set(opts.dropTypes ?? DEFAULT_DROP);
  const highPriority = new Set([...opts.highPriorityTypes, ...FORCED_HIGH_PRIORITY]);

  // --- Step 1: coalesce consecutive same-key runs to the last event. ---
  const coalesced: OpencodeEvent[] = [];
  for (const e of events) {
    const shouldCoalesce = coalesceTypes.has(e.type) && !highPriority.has(e.type);
    if (
      shouldCoalesce &&
      coalesced.length > 0 &&
      coalesced[coalesced.length - 1].type === e.type &&
      coalesceKey(coalesced[coalesced.length - 1]) === coalesceKey(e)
    ) {
      // Replace the previous event of the same key with this later one.
      coalesced[coalesced.length - 1] = e;
      continue;
    }
    coalesced.push(e);
  }

  // --- Step 2: drop droppable events while over the cap. ---
  if (coalesced.length <= maxPerSec) return coalesced;

  let overBy = coalesced.length - maxPerSec;
  const result: OpencodeEvent[] = [];
  for (const e of coalesced) {
    const droppable = dropTypes.has(e.type) && !highPriority.has(e.type);
    if (droppable && overBy > 0) {
      overBy -= 1;
      continue;
    }
    result.push(e);
  }
  return result;
}
