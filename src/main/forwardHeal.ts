// Self-healing logic for the opencode SSH `-L` forward.
//
// Failure mode this addresses: SSH `ControlPersist` keeps a killed app
// instance's ControlMaster (and its `-L <localPort>` forward) alive as an
// orphan. A relaunched instance starts its own master, which passes
// `ssh -O check`, but `ssh -O forward` for the same local port is rejected
// ("Port forwarding failed") because the orphaned master still holds it.
//
// The recovery: identify the process holding the local port. If it's an `ssh`
// mux master pointed at one of *our* `bui-cm-*` control sockets that is NOT
// the live master, it's a stale orphan from a prior run — evict it and retry.
//
// This module is pure parsing/decision logic so it can be unit-tested without
// spawning ssh or binding sockets. The thin spawn glue lives in opencode.ts.

// Our control sockets are `bui-cm-<hash>` under /tmp (matches pty.ts /
// opencode.ts CONTROL_PATH). Anything else holding the port is foreign and we
// must NOT touch it.
const BUI_SOCKET_RE = /\/tmp\/bui-cm-[0-9a-f]+/;

// An ssh `-O forward` failure that means "the local port is already bound".
// OpenSSH phrases this a few ways across versions; match the stable tokens.
export function isPortForwardingFailure(stderr: string): boolean {
  return (
    /port forwarding failed/i.test(stderr) ||
    /forwarding request failed/i.test(stderr) ||
    /bind:\s*address already in use/i.test(stderr) ||
    /cannot listen to port/i.test(stderr)
  );
}

export type PortHolder = {
  pid: number;
  command: string;
};

// Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn` output. The `-F pcn`
// format emits one field per line, record-prefixed: `p<pid>`, `c<command>`,
// `n<name>`. We only need pid + command of the LISTEN holder(s).
export function parseLsofListeners(lsofOut: string): PortHolder[] {
  const holders: PortHolder[] = [];
  let pid: number | null = null;
  let command = "";
  for (const line of lsofOut.split("\n")) {
    if (line.length === 0) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      // New process record. Flush the previous one if complete.
      if (pid !== null) holders.push({ pid, command });
      pid = Number(val);
      command = "";
    } else if (tag === "c") {
      command = val;
    }
    // `n` (name) and `f` (fd) lines are present but unneeded; -sTCP:LISTEN
    // already filtered to listeners so every emitted process is a holder.
  }
  if (pid !== null) holders.push({ pid, command });
  // Dedup: lsof emits one record per matching fd; a single ssh master listens
  // on both IPv4 and IPv6, yielding the pid twice.
  const seen = new Set<number>();
  return holders.filter((h) => {
    if (seen.has(h.pid)) return false;
    seen.add(h.pid);
    return true;
  });
}

export type EvictDecision =
  | { action: "evict"; socketPath: string; pid: number }
  | { action: "foreign"; pid: number; command: string }
  | { action: "none" };

// Decide what to do about whatever holds the local forward port.
//
// `holders`     - parsed `lsof` LISTEN holders for the local port
// `psByPid`     - full `ps`-style command line for each ssh pid, used to read
//                 its `-o ControlPath=...` (so we learn which socket it masters)
// `liveSocket`  - resolved control socket of the CURRENT instance's master
//                 (the `%C` hash expanded). The orphan is, by definition, a
//                 bui socket that is NOT this one.
//
// Returns `evict` only when the holder is unambiguously one of our own stale
// masters. A non-ssh holder, or an ssh process on a non-bui socket, is
// `foreign` — surfaced to the user, never killed.
export function decideEviction(
  holders: PortHolder[],
  psByPid: Map<number, string>,
  liveSocket: string,
): EvictDecision {
  if (holders.length === 0) return { action: "none" };

  for (const h of holders) {
    const cmdline = psByPid.get(h.pid) ?? h.command;
    const isSsh = /(^|\/)ssh\b/.test(h.command) || /(^|\s)ssh\s/.test(cmdline);
    if (!isSsh) {
      return { action: "foreign", pid: h.pid, command: h.command };
    }
    const m = cmdline.match(BUI_SOCKET_RE);
    if (!m) {
      // An ssh process, but not one of ours (no bui-cm socket on its
      // command line). Could be a user's own tunnel — do not touch.
      return { action: "foreign", pid: h.pid, command: h.command };
    }
    const holderSocket = m[0];
    if (holderSocket === liveSocket) {
      // The live master already holds the port — `-O forward` should have
      // been idempotent. Nothing to evict; let the caller treat as success.
      return { action: "none" };
    }
    // A bui control socket that is NOT the live one: a stale orphan from a
    // previous app run kept alive by ControlPersist. Safe to evict.
    return { action: "evict", socketPath: holderSocket, pid: h.pid };
  }
  return { action: "none" };
}

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

export type StreamHealthInput = {
  // Total frames received on this stream since it connected, INCLUDING
  // server.connected and every server.heartbeat. The connect frame counts
  // as 1, so a healthy-but-idle stream has framesSinceConnect growing via
  // heartbeats; a stalled stream stays at 1.
  framesSinceConnect: number;
  // ms since the stream's underlying fetch connected.
  msSinceConnect: number;
  // ms since the most recent frame of ANY type (heartbeat included).
  // Infinity / very large when only the connect frame was ever seen.
  msSinceLastFrame: number;
};

// Pure decision: is this SSE stream stalled (mux stopped pumping) and thus
// in need of a forced ControlMaster eviction + reconnect?
//
// Stalled iff BOTH:
//   - it has been connected long enough that a healthy stream would have
//     emitted at least one heartbeat (msSinceConnect ≥ STREAM_STALL_MS), AND
//   - no frame of any kind has arrived for that same window
//     (msSinceLastFrame ≥ STREAM_STALL_MS).
// The heartbeat is the liveness signal: any frame — including a heartbeat —
// resets msSinceLastFrame and keeps the stream classified healthy. A stream
// that legitimately has no app activity is therefore still healthy as long
// as heartbeats flow; only true mux silence trips this.
export function classifyStreamHealth(
  i: StreamHealthInput,
  stallMs: number = STREAM_STALL_MS,
): "healthy" | "stalled" {
  if (i.msSinceConnect < stallMs) return "healthy"; // too soon to judge
  if (i.msSinceLastFrame >= stallMs) return "stalled";
  return "healthy";
}
