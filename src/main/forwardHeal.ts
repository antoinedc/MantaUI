// SSE stream-stall detection for the opencode event bus.
//
// NOTE (BET-46.3): the SSH ControlMaster orphan-eviction decision logic that
// used to live here (isPortForwardingFailure / parseLsofListeners /
// decideEviction + their types) moved to ./net/forwardHeal.ts, where the new
// SSH `Transport` / ConnectionManager owns it. This file keeps ONLY the SSE
// stream-stall detection because that half is consumed by the index.ts event
// bus, which is out of scope for this stage (folding the SSE/WS consumer into
// the ConnectionManager is BET-46.4). To avoid churning importers of the moved
// symbols, this module re-exports them from their new home — a thin shim.
export {
  isPortForwardingFailure,
  parseLsofListeners,
  decideEviction,
} from "./net/forwardHeal.js";
export type { PortHolder, EvictDecision } from "./net/forwardHeal.js";

// ===== Stalled-stream detection =====
//
// Second ControlMaster failure mode (distinct from the orphan above): the
// shared master goes HALF-DEAD after a network transition (laptop sleep,
// wifi change). `ssh -O check` still passes — the control socket answers —
// and short request/response calls complete in their first burst, so
// GET /question and POST /prompt keep working. But long-lived SSE streams
// receive only the initial `server.connected` frame and then the mux stops
// pumping data. Result: questions, live message deltas, and todo updates
// silently stop reaching the renderer while the app otherwise looks fine.
//
// `evictStaleForwardHolder` cannot catch this — there is no port-bind
// failure; the forward "succeeds". Detection must instead watch the event
// stream itself: opencode sends `server.connected` on connect and then
// `server.heartbeat` periodically (well under a minute) on a HEALTHY
// stream, even when the session is idle. So "connected, but zero further
// frames of ANY type for a window comfortably longer than the heartbeat
// interval" is an unambiguous stall — a genuinely idle-but-healthy stream
// still produces heartbeats and is never flagged.

// How long after connect we tolerate total frame silence before declaring
// the stream stalled. opencode's heartbeat cadence is ~tens of seconds;
// 45s is several heartbeats — long enough to never false-positive on a
// healthy idle stream, short enough that recovery is timely.
export const STREAM_STALL_MS = 45_000;

// `server.heartbeat` / `server.connected` are TRANSPORT keep-alives, not
// application events. The half-dead ControlMaster keeps trickling these
// through on an established stream while substantive frames
// (message.part.delta, question.asked, todo.updated, …) and new connects
// stall. A v1 watchdog that treated "any frame = alive" was therefore a
// false-NEGATIVE for the real production failure: heartbeat-only traffic
// during active work. We must track substantive frames separately.
const TRANSPORT_FRAME_TYPES = new Set(["server.heartbeat", "server.connected"]);

export function isSubstantiveFrame(type: string): boolean {
  return !TRANSPORT_FRAME_TYPES.has(type);
}

export type StreamHealthInput = {
  // Total frames since connect, including transport keep-alives.
  framesSinceConnect: number;
  // ms since the stream's underlying fetch connected.
  msSinceConnect: number;
  // ms since the most recent frame of ANY type (heartbeat included).
  // Catches a FULLY dead mux (not even keep-alives get through).
  msSinceLastFrame: number;
  // ms since the most recent SUBSTANTIVE (non-keep-alive) frame, or since
  // connect if none seen. Catches the HALF-dead mux: heartbeats still flow
  // (msSinceLastFrame small) but real events have stopped.
  msSinceLastSubstantiveFrame: number;
  // True when the bus expects substantive events to be flowing — a prompt
  // is in flight / the session is mid-turn. Only then is "heartbeats but
  // no substantive frames" a stall; a genuinely idle session legitimately
  // produces only heartbeats and MUST NOT be flagged (no false positive).
  activeWork: boolean;
};

// Pure decision: is this SSE stream stalled and in need of a forced
// ControlMaster eviction + reconnect?
//
// Two distinct stall modes, both gated on "connected long enough that a
// healthy stream would have produced traffic" (msSinceConnect ≥ stallMs):
//
//   A. FULLY dead mux — no frame of any kind for the window
//      (msSinceLastFrame ≥ stallMs). Independent of activeWork.
//   B. HALF dead mux — keep-alives still arrive (msSinceLastFrame small)
//      but NO substantive frame for the window WHILE work is active
//      (activeWork && msSinceLastSubstantiveFrame ≥ stallMs).
//
// An idle session (activeWork=false) with only heartbeats is HEALTHY —
// that's the explicit no-false-positive guarantee. Mode B only triggers
// when the session should be producing events but isn't.
export function classifyStreamHealth(
  i: StreamHealthInput,
  stallMs: number = STREAM_STALL_MS,
): "healthy" | "stalled" {
  if (i.msSinceConnect < stallMs) return "healthy"; // too soon to judge
  if (i.msSinceLastFrame >= stallMs) return "stalled"; // mode A: fully dead
  if (i.activeWork && i.msSinceLastSubstantiveFrame >= stallMs) {
    return "stalled"; // mode B: half dead — heartbeats mask the stall
  }
  return "healthy";
}
