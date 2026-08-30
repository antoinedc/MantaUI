import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPOLOGY_VERSION,
  snapshotFrom,
  countWindows,
  shouldPersist,
  loadTopology,
  saveTopology,
  createTopologyPersister,
} from "./topology.mjs";

// listProjects()-shaped fixture (src/server/tmux.mjs): one chat project, one
// project with only terminal windows, one empty project.
const P1 = [
  {
    tmuxSession: "alpha",
    defaultCwd: "/home/dev/alpha",
    mantaOwned: true,
    attached: false,
    windows: [
      {
        index: 0,
        name: "editor",
        active: false,
        paneCurrentPath: "/home/dev/alpha",
        opencodeSessionId: null,
        worktreePath: null,
        owner: "user",
      },
      {
        index: 1,
        name: "chat",
        active: true,
        paneCurrentPath: "/home/dev/alpha",
        opencodeSessionId: "oc-1",
        worktreePath: null,
        owner: "user",
      },
      {
        index: 2,
        name: "chat2",
        active: false,
        paneCurrentPath: "",
        opencodeSessionId: "oc-2",
        worktreePath: "/home/dev/alpha/.worktrees/fix",
        owner: "user",
      },
    ],
  },
  {
    tmuxSession: "term-only",
    defaultCwd: "/home/dev/term",
    mantaOwned: false,
    attached: true,
    windows: [
      {
        index: 0,
        name: "shell",
        active: true,
        paneCurrentPath: "/home/dev/term",
        opencodeSessionId: null,
        worktreePath: null,
        owner: "user",
      },
    ],
  },
  { tmuxSession: "empty", defaultCwd: "/home/dev/empty", mantaOwned: false, attached: false, windows: [] },
];

test("snapshotFrom keeps only chat windows and drops empty projects", () => {
  const snap = snapshotFrom(P1, 1234);
  assert.equal(snap.version, TOPOLOGY_VERSION);
  assert.equal(snap.capturedAt, 1234);
  assert.deepEqual(
    snap.sessions.map((s) => s.tmuxSession),
    ["alpha"],
  );
  const s = snap.sessions[0];
  assert.equal(s.defaultCwd, "/home/dev/alpha");
  assert.equal(s.mantaOwned, true);
  assert.deepEqual(
    s.windows.map((w) => w.opencodeSessionId),
    ["oc-1", "oc-2"],
  );
});

test("snapshotFrom maps per-window fields per the BET-1452 contract", () => {
  const snap = snapshotFrom(P1);
  const [w1, w2] = snap.sessions[0].windows;
  // name ← live tmux window name; cwd ← paneCurrentPath, defaultCwd fallback
  assert.deepEqual(w1, {
    index: 1,
    name: "chat",
    opencodeSessionId: "oc-1",
    cwd: "/home/dev/alpha",
    worktreePath: null,
    active: true,
  });
  // empty paneCurrentPath falls back to the project defaultCwd; observed
  // worktreePath passes through untouched, never invented
  assert.equal(w2.name, "chat2");
  assert.equal(w2.cwd, "/home/dev/alpha");
  assert.equal(w2.worktreePath, "/home/dev/alpha/.worktrees/fix");
  assert.equal(w2.active, false);
});

test("snapshotFrom normalizes mantaOwned/active strictly to === true from malformed input", () => {
  const snap = snapshotFrom(
    [
      {
        tmuxSession: "x",
        defaultCwd: "/x",
        mantaOwned: undefined,
        windows: [
          // active: 1 is not === true — pinned strict, matching the
          // `active === true` contract (parseSessions emits real booleans)
          { index: 0, name: "c", active: 1, paneCurrentPath: "/x", opencodeSessionId: "oc-9" },
          { index: 1, name: "c2", active: true, paneCurrentPath: "/x", opencodeSessionId: "oc-8" },
        ],
      },
    ],
    7,
  );
  assert.equal(snap.sessions[0].mantaOwned, false);
  assert.equal(snap.sessions[0].windows[0].active, false);
  assert.equal(snap.sessions[0].windows[1].active, true);
});

test("snapshotFrom with no input → empty snapshot, null/empty tolerated", () => {
  assert.deepEqual(snapshotFrom(null, 5), { version: TOPOLOGY_VERSION, capturedAt: 5, sessions: [] });
  assert.equal(countWindows(snapshotFrom(undefined)), 0);
});

test("countWindows counts across sessions; malformed input → 0", () => {
  const snap = snapshotFrom(P1);
  snap.sessions.push({ tmuxSession: "y", windows: [{ index: 3, name: "c", opencodeSessionId: "oc-3" }] });
  assert.equal(countWindows(snap), 3);
  assert.equal(countWindows(null), 0);
  assert.equal(countWindows({ version: 1, sessions: "nope" }), 0);
});

test("shouldPersist: windows present → true; empty→empty → true; non-empty→empty → false", () => {
  const full = snapshotFrom(P1);
  const empty = { version: TOPOLOGY_VERSION, capturedAt: 0, sessions: [] };
  assert.equal(shouldPersist(null, full), true);
  assert.equal(shouldPersist(null, empty), true); // no file yet, empty box converges once
  assert.equal(shouldPersist(empty, empty), true);
  assert.equal(shouldPersist(full, empty), false); // would-clobber
});

function makeIo({ initial = null, failRead = false } = {}) {
  const calls = { reads: 0, writes: [] };
  return {
    calls,
    io: {
      readFile: async () => {
        calls.reads += 1;
        if (failRead) throw new Error("EACCES");
        if (initial === null) throw new Error("ENOENT");
        return initial;
      },
      writeFile: async (path, data) => {
        calls.writes.push([path, data]);
      },
    },
  };
}

test("loadTopology: valid file parses; missing/unparsable/version-mismatch/malformed → null", async () => {
  const good = JSON.stringify(snapshotFrom(P1, 99));
  const ok = makeIo({ initial: good });
  const parsed = await loadTopology("/tmp/ignored.json", ok.io);
  assert.equal(parsed.version, TOPOLOGY_VERSION);
  assert.equal(parsed.capturedAt, 99);
  assert.equal(countWindows(parsed), 2);

  for (const bad of [
    makeIo({ initial: null }), // missing file
    makeIo({ initial: "{not json" }), // invalid JSON
    makeIo({ initial: JSON.stringify({ version: 999, sessions: [] }) }), // version mismatch
    makeIo({ initial: JSON.stringify({ version: TOPOLOGY_VERSION, sessions: {} }) }), // non-array sessions
    makeIo({ failRead: true }), // unreadable
  ]) {
    assert.equal(await loadTopology("/tmp/ignored.json", bad.io), null);
  }
});

test("saveTopology writes pretty-printed JSON to the injected io", async () => {
  const { calls, io } = makeIo();
  const snap = snapshotFrom(P1, 42);
  await saveTopology(snap, "/state/topology.json", io);
  assert.equal(calls.writes.length, 1);
  const [path, data] = calls.writes[0];
  assert.equal(path, "/state/topology.json");
  assert.equal(data, JSON.stringify(snap, null, 2));
  assert.ok(data.includes('\n  "sessions"')); // pretty-printed, readable diffs
});

test("persister: first call hydrates lazily then writes; identical tick skips as unchanged", async () => {
  const { calls, io } = makeIo();
  const persist = createTopologyPersister({ save: io.writeFile, load: io.readFile, now: () => 1234 });
  const r1 = await persist(P1);
  assert.deepEqual(r1, { persisted: true, reason: "written" });
  assert.equal(calls.reads, 1); // hydrated exactly once
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(JSON.parse(calls.writes[0][1]).capturedAt, 1234);

  const r2 = await persist(P1); // identical topology → no write
  assert.deepEqual(r2, { persisted: false, reason: "unchanged" });
  assert.equal(calls.writes.length, 1);

  const r3 = await persist(P1); // still hydrated once, not per call
  assert.deepEqual(r3, { persisted: false, reason: "unchanged" });
  assert.equal(calls.reads, 1);
});

test("persister: changed topology writes again and updates the baseline", async () => {
  const { calls, io } = makeIo();
  const persist = createTopologyPersister({ save: io.writeFile, load: io.readFile, now: () => 1 });
  await persist(P1);
  const renamed = JSON.parse(JSON.stringify(P1));
  renamed[0].windows[1].name = "renamed-by-user"; // BET-1364 rename drift flows in
  const r2 = await persist(renamed);
  assert.deepEqual(r2, { persisted: true, reason: "written" });
  assert.equal(calls.writes.length, 2);
  const saved = JSON.parse(calls.writes[1][1]);
  // only the chat windows survive — "editor" (no opencodeSessionId) is gone
  assert.deepEqual(
    saved.sessions[0].windows.map((w) => w.name),
    ["renamed-by-user", "chat2"],
  );
});

test("persister: hydrating a non-empty file, zero-window tick → would-clobber, no write", async () => {
  const existing = JSON.stringify(snapshotFrom(P1, 77));
  const { calls, io } = makeIo({ initial: existing });
  const persist = createTopologyPersister({ save: io.writeFile, load: io.readFile, now: () => 2 });
  const r = await persist([]); // box observed with zero chat windows
  assert.deepEqual(r, { persisted: false, reason: "would-clobber" });
  assert.equal(calls.writes.length, 0);
});

test("persister: zero-window tick after empty hydrate writes an empty snapshot once", async () => {
  const { calls, io } = makeIo();
  const persist = createTopologyPersister({ save: io.writeFile, load: io.readFile, now: () => 3 });
  const r = await persist([]);
  assert.deepEqual(r, { persisted: true, reason: "written" });
  assert.deepEqual(JSON.parse(calls.writes[0][1]).sessions, []);
  const r2 = await persist([]);
  assert.deepEqual(r2, { persisted: false, reason: "unchanged" });
});

test("persister: identical sessions with a moved clock skip (churn guard); rename writes", async () => {
  const { calls, io } = makeIo({ initial: JSON.stringify(snapshotFrom(P1, 5)) });
  let tick = 6;
  const persist = createTopologyPersister({
    save: io.writeFile,
    load: io.readFile,
    now: () => tick++,
  });
  // identical topology, NEWER capturedAt → must still be "unchanged": a
  // whole-snapshot compare would rewrite the file on every 2s poller tick
  const r = await persist(P1);
  assert.deepEqual(r, { persisted: false, reason: "unchanged" });
  assert.equal(calls.writes.length, 0);

  const renamed = JSON.parse(JSON.stringify(P1));
  renamed[0].windows[1].name = "renamed-by-user";
  const r2 = await persist(renamed);
  assert.deepEqual(r2, { persisted: true, reason: "written" });
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(JSON.parse(calls.writes[0][1]).capturedAt, 7); // stamp of the write
});
