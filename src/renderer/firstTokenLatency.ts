// firstTokenLatency.ts — instrument time from first token to rendered text
// (BET-553 / §17). §17 pre-registers the threshold: <1s acceptable; above it,
// revisit the partition that moved the flush decision to the box. That hop is
// the risk — before S1 the renderer flushed locally, after S1 the box flushes
// and the device awaits a `stream.flush` chunk before text can render.
//
// "Both paths" (the two transports that consume interpreted stream events):
//   - the demo transport (bootDemo) — synthetic, no network, measures the pure
//     render hop in isolation;
//   - the real transport (httpApi / a live box) — the same hook, same
//     `stream.flush` consumption, but with the network hop between the box
//     emitting and the device receiving.
// The instrumentation is shared, so whichever transport is active reports
// through the same seam and the number is comparable. The demo build logs the
// measurement to the console; `lastMeasurement()` lets a test / the visual
// harness read it.
//
// Deliberately tiny + dependency-free: module-level start times keyed by
// session, one real clock (`performance.now`), and a single last-measured
// value. Keep it cheap — it must never be worth ripping out.

export type LatencyPath = "interpreted" | "raw";

const starts: Record<LatencyPath, Map<string, number>> = {
  interpreted: new Map(),
  raw: new Map(),
};

let lastMs: number | null = null;
let lastPath: LatencyPath | null = null;

/** Record the arrival of the first text chunk of a turn on a path. Only the
 *  FIRST arrival wins per (path, session) — the window is from first token to
 *  that first token being rendered, not an average over the turn. */
export function markFirstToken(
  path: LatencyPath,
  sessionId: string,
  now: number = performance.now(),
): void {
  if (!starts[path].has(sessionId)) starts[path].set(sessionId, now);
}

/** Record that the first chunk's text has been committed for render. Returns
 *  the elapsed ms, or null if no start was recorded for this session. */
export function markRendered(
  path: LatencyPath,
  sessionId: string,
  now: number = performance.now(),
): number | null {
  const t0 = starts[path].get(sessionId);
  if (t0 == null) return null;
  starts[path].delete(sessionId);
  lastMs = now - t0;
  lastPath = path;
  return lastMs;
}

/** The most recent measurement (for tests / the visual harness). */
export function lastMeasurement(): { path: LatencyPath | null; ms: number | null } {
  return { path: lastPath, ms: lastMs };
}

/** Reset all state — used by tests and when a demo build re-mounts. */
export function resetFirstTokenLatency(): void {
  starts.interpreted.clear();
  starts.raw.clear();
  lastMs = null;
  lastPath = null;
}
