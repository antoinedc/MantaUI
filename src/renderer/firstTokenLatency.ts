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
// measurement to the console via an `onMeasurement` observer; `lastMeasurement()`
// lets a test / the visual harness / a probe read it.
//
// Deliberately tiny + dependency-free: module-level start times keyed by
// session, one real clock (`performance.now`), and a single last-measured
// value. Keep it cheap — it must never be worth ripping out.

export type LatencyPath = "interpreted" | "raw";

const starts: Record<LatencyPath, Map<string, number>> = {
  interpreted: new Map(),
  raw: new Map(),
};

// Most recent completed measurement per path, so a consumer (the demo window
// handle, a probe) can read BOTH the interpreted and raw numbers after a run
// that fired both — not just whichever completed last.
const lastByPath: Record<LatencyPath, number | null> = { interpreted: null, raw: null };

// Observers fired with every completed measurement so a runtime consumer (the
// demo build's console, the visual harness, a probe) can read/report the number
// live. This is the "logs the measurement to the console" consumer — without
// it, lastMeasurement() has no live reader.
type MeasurementListener = (m: { path: LatencyPath; ms: number }) => void;
const listeners = new Set<MeasurementListener>();

/** Register a measurement observer. Returns an unsubscribe. */
export function onMeasurement(cb: MeasurementListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

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
  const ms = now - t0;
  lastByPath[path] = ms;
  for (const cb of listeners) cb({ path, ms });
  return ms;
}

/** The most recent completed measurement per path (for tests / the visual
 *  harness / a probe). */
export function lastMeasurement(): { interpreted: number | null; raw: number | null } {
  return { interpreted: lastByPath.interpreted, raw: lastByPath.raw };
}

/** Reset all state — used by tests and when a demo build re-mounts. */
export function resetFirstTokenLatency(): void {
  starts.interpreted.clear();
  starts.raw.clear();
  lastByPath.interpreted = null;
  lastByPath.raw = null;
  listeners.clear();
}
