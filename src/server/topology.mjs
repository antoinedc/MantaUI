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
//
// BET-1453 (Stage 2a) adds the restore half: planRestore / executeRestore /
// describeRestore turn a snapshot back into tmux windows AT THEIR ORIGINAL
// INDICES. The exact index is load-bearing, not cosmetic — a sidebar pin is
// `<tmuxSession>/<windowIndex>` persisted in config.json and it SURVIVES the
// crash, so appending rebuilt windows elsewhere would silently reattach a
// surviving pin to whatever now occupies that slot: the wrong conversation.

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

// ---------------------------------------------------------------------------
// BET-1453 — restore planning + execution (pure)
// ---------------------------------------------------------------------------

// True when `projects` (a listProjects() tree) has a live window at
// (tmuxSession, index). ANY window occupies an index — chat or claude-TUI —
// because the pin pair names the slot, not the kind of window in it.
function liveIndexSet(liveProjects) {
  const occupied = new Set();
  for (const p of liveProjects ?? []) {
    for (const w of p?.windows ?? []) {
      if (p?.tmuxSession != null && w?.index != null) occupied.add(`${p.tmuxSession}/${w.index}`);
    }
  }
  return occupied;
}

// The set of opencode session ids already stamped on ANY live window across
// ALL sessions — an id restored under a different session than the snapshot
// recorded still means "this conversation already has a window".
function liveStampedIdSet(liveProjects) {
  const stamped = new Set();
  for (const p of liveProjects ?? []) {
    for (const w of p?.windows ?? []) {
      if (typeof w?.opencodeSessionId === "string" && w.opencodeSessionId !== "") {
        stamped.add(w.opencodeSessionId);
      }
    }
  }
  return stamped;
}

// Plan the restore of a saved snapshot against the live tree. Pure.
//
// Emits ONLY creation ops — never a kill, rename, restamp or reorder — so
// running the plan after a partial recovery is safe: whatever a previous run
// managed to create is skipped, the remainder is completed.
//
// Per-window skip rules (checked in this order):
//   - `opencode-session-gone` — `knownSessionIds` is a Set and the window's
//     id is absent from it. Restoring one would produce a sidebar row that
//     opens onto nothing. When `knownSessionIds` is null the filter is OFF
//     (an unreachable opencode must mean "do not filter", never "drop all").
//   - `already-restored` — the window's opencodeSessionId is already stamped
//     on any live window (including under a different session), or the same
//     id was claimed by an earlier op in THIS plan, so a duplicate id inside
//     one snapshot cannot be created twice.
//   - `index-occupied` — a live window already sits at (tmuxSession, index).
//
// Each session's windows are sorted ascending by index; the first op for a
// session that does not exist live is `create-session` (tmux's new-session
// cannot pick its first window's index — the caller moves it into place),
// the rest are `create-window` (new-window -t accepts an explicit index and
// works out of order). Tolerates null / `{sessions: []}` input.
export function planRestore(snapshot, liveProjects, knownSessionIds = null) {
  const occupied = liveIndexSet(liveProjects);
  const stamped = liveStampedIdSet(liveProjects);
  const ops = [];
  const skipped = [];
  const claimedIds = new Set();
  for (const session of snapshot?.sessions ?? []) {
    const tmuxSession = session?.tmuxSession;
    if (tmuxSession == null) continue;
    const windows = [...(session.windows ?? [])]
      .filter((w) => w && w.index != null)
      .sort((a, b) => a.index - b.index);
    const sessionLive = (liveProjects ?? []).some((p) => p?.tmuxSession === tmuxSession);
    let first = true;
    for (const w of windows) {
      const base = {
        tmuxSession,
        mantaOwned: session.mantaOwned === true,
        index: w.index,
        name: w.name,
        opencodeSessionId: w.opencodeSessionId,
        cwd: w.cwd,
        worktreePath: w.worktreePath ?? null,
      };
      if (knownSessionIds instanceof Set && !knownSessionIds.has(w.opencodeSessionId)) {
        skipped.push({ ...base, reason: "opencode-session-gone" });
        continue;
      }
      // Stamp check BEFORE the index check on purpose: a window a previous
      // restore run created is both stamped AND sits at its (reproduced)
      // index — the truthful reason it is skipped is "already-restored",
      // not the alarming "index-occupied".
      if (stamped.has(w.opencodeSessionId) || claimedIds.has(w.opencodeSessionId)) {
        skipped.push({ ...base, reason: "already-restored" });
        continue;
      }
      if (occupied.has(`${tmuxSession}/${w.index}`)) {
        skipped.push({ ...base, reason: "index-occupied" });
        continue;
      }
      claimedIds.add(w.opencodeSessionId);
      ops.push({
        kind: !sessionLive && first ? "create-session" : "create-window",
        ...base,
      });
      first = false;
    }
  }
  return { ops, skipped };
}

// Execute a plan by awaiting `restoreWindow(op)` for each op IN ORDER. The
// only I/O is the injected callback — pure for tests.
//
// A per-op throw is caught and recorded in `failures`; the loop CONTINUES
// (parent decision 3: a window that cannot be rebuilt fails alone). EXCEPT
// when a `create-session` op fails: the remaining ops for THAT tmux session
// are failed immediately with "skipped — its tmux session could not be
// created" — every one of them targets a session that does not exist, so
// continuing would only bury the real cause under identical errors.
//
// Returns { created, failed, skipped, windows, failures }: `created` +
// `failed` always equals the number of planned window ops (session-skipped
// windows count as failed), `windows` lists the created identities, and
// `skipped` carries the plan's pre-filtered entries through untouched.
export async function executeRestore(plan, restoreWindow) {
  const windows = [];
  const failures = [];
  const skippedSessions = new Set();
  let created = 0;
  let failed = 0;
  for (const op of plan?.ops ?? []) {
    const identity = {
      tmuxSession: op.tmuxSession,
      index: op.index,
      name: op.name,
      opencodeSessionId: op.opencodeSessionId,
    };
    if (skippedSessions.has(op.tmuxSession)) {
      failed++;
      failures.push({
        ...identity,
        error: "skipped — its tmux session could not be created",
      });
      continue;
    }
    try {
      await restoreWindow(op);
      created++;
      windows.push(identity);
    } catch (e) {
      failed++;
      failures.push({ ...identity, error: e?.message ?? String(e) });
      if (op.kind === "create-session") skippedSessions.add(op.tmuxSession);
    }
  }
  return { created, failed, skipped: plan?.skipped ?? [], windows, failures };
}

// One human line for the restore result. `created` and `failed` both zero
// means every saved window was already open (the fully-restored box) — say
// THAT rather than "Restored 0 windows", which reads like a malfunction.
export function describeRestore(result) {
  const created = result?.created ?? 0;
  const failed = result?.failed ?? 0;
  if (created === 0 && failed === 0) {
    return "Nothing to restore — every saved window is already open.";
  }
  const noun = created === 1 ? "window" : "windows";
  if (failed === 0) return `Restored ${created} ${noun}.`;
  return `Restored ${created} ${noun} · ${failed} failed.`;
}
