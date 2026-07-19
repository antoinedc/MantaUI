// debugLog.ts — a tiny on-screen debug log for the mobile client.
//
// Safari Web Inspector cannot always attach to the TestFlight WKWebView (device
// not discovered), so console.log is invisible on-device. This captures the
// same [deeplink] trail into a module-level ring buffer that a UI panel renders
// on the SetupScreen — the user can READ the pairing chain on the phone itself
// and report it back. Pure + framework-free; the React panel subscribes.

export type DebugEntry = { t: number; msg: string };

const BUFFER_MAX = 60;
const buffer: DebugEntry[] = [];
const listeners = new Set<(entries: DebugEntry[]) => void>();

/** Append a line to the on-screen debug log (also mirrors to console). */
export function dlog(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
  buffer.push({ t: Date.now(), msg });
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  const snapshot = buffer.slice();
  for (const fn of listeners) fn(snapshot);
}

/** Same, for warnings (prefixed so they stand out in the panel). */
export function dwarn(msg: string): void {
  dlog(`⚠ ${msg}`);
}

/** Current log snapshot (newest last). */
export function getDebugLog(): DebugEntry[] {
  return buffer.slice();
}

/** Subscribe to log updates; returns an unsubscribe fn. */
export function subscribeDebugLog(fn: (entries: DebugEntry[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Clear the buffer (Clear button in the panel). */
export function clearDebugLog(): void {
  buffer.length = 0;
  for (const fn of listeners) fn([]);
}
