// topology.mjs — BET-1452 Stage 1 (server-side): the durable chat-window
// topology snapshot at `~/.manta/topology.json`.
//
// WHY IT EXISTS. Stage 2 (agent-relaunch preview) needs the list of a box's
// chat windows — index, tmux window name, opencode session id, cwd — BEFORE
// the user reconnects, i.e. when nothing can be asked of the live box state
// the renderer already has. Today that list only exists inside the in-memory
// syncState (src/server/syncState.mjs), which evaporates on every box-server
// restart. This module persists the same tree, CHAT WINDOWS ONLY, to disk so
// a later stage can hydrate from it.
//
// Data source: the exact `listProjects()` tree (src/server/tmux.mjs) that
// syncState already consumes — windows carry `opencodeSessionId` iff the
// window is a chat-mode window holding an opencode session, so "has an
// opencodeSessionId" is THE chat-window discriminator. Non-chat windows are
// dropped, projects left with zero windows are dropped.
//
// Safety contract (why the persister is so cautious about empty writes):
// the snapshot must NEVER regress to "zero chat windows" while one still
// exists. Two failure modes are guarded:
//   1. `shouldPersist` — a zero-window snapshot never overwrites a non-empty
//      file ("would-clobber"), only an already-empty one.
//   2. byte-identical skip — the 2s poller runs this on every tick; the write
//      happens once per actual topology change, not 43,200 times a day.
//
// Pure + injected-I/O, mirroring src/server/syncState.mjs. The only
// functions that touch disk by default are loadTopology / saveTopology,
// both of which accept an `io` override for tests — the suite never writes
// production data (see the MANTA_STATE_HOME note in src/shared/paths.mjs).

import { readFile } from "node:fs/promises";
import { atomicWrite } from "./storeUtils.mjs";
import { statePath } from "../shared/paths.mjs";

// Where the snapshot lives. Routed through statePath so the test sandbox
// (MANTA_STATE_HOME) applies, like every other state file on the box.
export const TOPOLOGY_PATH = statePath("topology.json");

// Bump when the snapshot shape changes incompatibly; loadTopology rejects
// anything else so a Stage-2 reader can trust the shape it sees.
export const TOPOLOGY_VERSION = 1;

// Default I/O: real fs read + the shared atomic-write primitive (temp file +
// rename, parent-dir creating — see src/server/jsonStore.mjs).
const defaultIo = {
  readFile: (path) => readFile(path, "utf-8"),
  writeFile: (path, data) => atomicWrite(path, data),
};

// Build a snapshot from a `listProjects()` tree. `now` (epoch ms) is stamped
// as `capturedAt`. Pure — never touches disk.
//
// Per-window mapping rules:
//   - keep only windows with a truthy string `opencodeSessionId` (chat)
//   - `name` ← the LIVE tmux window name (rename drift, BET-1364, flows in)
//   - `cwd` ← the window's `paneCurrentPath`, falling back to the project
//     `defaultCwd` (first window's cwd — which for a chat-first window is
//     the same value; the fallback only matters for malformed input)
//   - `worktreePath` ← as observed, or null. NEVER invented here.
//   - `mantaOwned` / `active` normalized to real booleans.
// Projects with no surviving windows are dropped entirely.
export function snapshotFrom(projects, now = Date.now()) {
  const sessions = [];
  for (const p of projects ?? []) {
    const windows = [];
    for (const w of p?.windows ?? []) {
      if (typeof w?.opencodeSessionId !== "string" || w.opencodeSessionId === "") continue;
      windows.push({
        index: w.index,
        name: w.name,
        opencodeSessionId: w.opencodeSessionId,
        cwd: w.paneCurrentPath || p.defaultCwd,
        worktreePath: w.worktreePath ?? null,
        active: w.active === true,
      });
    }
    if (windows.length === 0) continue;
    sessions.push({
      tmuxSession: p.tmuxSession,
      defaultCwd: p.defaultCwd,
      mantaOwned: p.mantaOwned === true,
      windows,
    });
  }
  return { version: TOPOLOGY_VERSION, capturedAt: now, sessions };
}

// Total chat-window count across a snapshot. Tolerates null / malformed
// input (→ 0) because callers compare raw loaded values against fresh ones.
export function countWindows(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.sessions)) return 0;
  return snapshot.sessions.reduce(
    (n, s) => n + (Array.isArray(s?.windows) ? s.windows.length : 0),
    0,
  );
}

// Write gate. True when the incoming snapshot has at least one window.
// Otherwise true ONLY when the previous snapshot had zero windows as well —
// so an empty box can converge to an empty file exactly once, but a
// transient empty observation can never clobber a non-empty snapshot.
// `prev === null` (no file / unparsable) counts as zero windows.
export function shouldPersist(prev, next) {
  if (countWindows(next) > 0) return true;
  return countWindows(prev) === 0;
}

// Read + validate the snapshot at `path`. Returns null on: missing file,
// unreadable file, invalid JSON, wrong `version`, or non-array `sessions`.
// Never throws. The injected `io` returns/throws like fs.readFile(path, "utf-8").
export async function loadTopology(path = TOPOLOGY_PATH, io = defaultIo) {
  let raw;
  try {
    raw = await io.readFile(path);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== TOPOLOGY_VERSION) return null;
  if (!Array.isArray(parsed.sessions)) return null;
  return parsed;
}

// Serialize + write the snapshot atomically. Pretty-printed so manual
// inspection and diffs of the file stay readable. Propagates write errors —
// callers decide whether persistence failure is fatal (the refreshNow hook
// in src/server/syncState.mjs warns + swallows so the sync path is never
// poisoned).
export async function saveTopology(snapshot, path = TOPOLOGY_PATH, io = defaultIo) {
  await io.writeFile(path, JSON.stringify(snapshot, null, 2));
}

// The per-refresh entry point wired into syncState.refreshNow's success
// branch (src/server/syncState.mjs — the single choke point, no new timer).
// Takes the freshly fetched `listProjects()` tree, hydrates the previous
// snapshot from disk ONCE on the first call (lazily — never at import), then:
//   1. would-clobber guard (shouldPersist) → {persisted:false, reason}
//   2. byte-identical skip — the freshly captured snapshot vs the last write
//   3. otherwise persist
// Returns {persisted, reason}: "would-clobber" / "unchanged" / "written".
//
// The churn comparison deliberately covers the `sessions` payload ONLY,
// excluding `capturedAt`: the poller ticks every 2s with a moving clock, so a
// whole-snapshot compare would rewrite the file forever. On disk,
// `capturedAt` therefore means "when the topology last actually changed" —
// strictly more useful to a Stage-2 staleness check.
//
// `save`/`load`/`now` are the test seams (resolve to the default io + clock).
export function createTopologyPersister({ save, load, now } = {}) {
  const io = {
    readFile: load ?? defaultIo.readFile,
    writeFile: save ?? defaultIo.writeFile,
  };
  const stamp = now ?? (() => Date.now());
  let hydrated = false;
  let prev = null;
  let lastSessionsJson = null;

  return async function persistTopology(projects) {
    if (!hydrated) {
      hydrated = true;
      prev = await loadTopology(TOPOLOGY_PATH, io).catch(() => null);
      lastSessionsJson = prev ? JSON.stringify(prev.sessions, null, 2) : null;
    }
    const snapshot = snapshotFrom(projects, stamp());
    if (!shouldPersist(prev, snapshot)) {
      return { persisted: false, reason: "would-clobber" };
    }
    const nextSessionsJson = JSON.stringify(snapshot.sessions, null, 2);
    if (nextSessionsJson === lastSessionsJson) {
      prev = snapshot;
      return { persisted: false, reason: "unchanged" };
    }
    await saveTopology(snapshot, TOPOLOGY_PATH, io);
    prev = snapshot;
    lastSessionsJson = nextSessionsJson;
    return { persisted: true, reason: "written" };
  };
}
