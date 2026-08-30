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
  planRestore,
  executeRestore,
  describeRestore,
} from "./topology.mjs";

// listProjects()-shaped fixture (src/server/tmux.mjs): one chat project with
// a TUI window + two chat windows (one worktree-backed), one TUI-only
// project, one empty project.
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
        paneCurrentPath: "/home/dev/alpha/.worktrees/fix",
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

// --- Required case 1: chat windows only; TUI window (null id) is dropped ---
test("snapshotFrom records chat windows only — a TUI window (null opencodeSessionId) is dropped", () => {
  const snap = snapshotFrom(P1, 1234);
  assert.equal(snap.version, TOPOLOGY_VERSION);
  assert.equal(snap.capturedAt, 1234);
  const alpha = snap.sessions.find((s) => s.tmuxSession === "alpha");
  assert.ok(alpha, "chat project present");
  assert.deepEqual(
    alpha.windows.map((w) => w.opencodeSessionId),
    ["oc-1", "oc-2"],
  );
  assert.ok(!alpha.windows.some((w) => w.name === "editor"), "TUI window dropped");
});

// --- Required case 2: a project left with no chat windows is dropped ---
test("snapshotFrom drops a project left with no chat windows entirely", () => {
  const snap = snapshotFrom(P1);
  assert.deepEqual(
    snap.sessions.map((s) => s.tmuxSession),
    ["alpha"],
  );
  assert.ok(!snap.sessions.some((s) => s.tmuxSession === "term-only"));
  assert.ok(!snap.sessions.some((s) => s.tmuxSession === "empty"));
});

// --- Required case 3: index/name/cwd/worktreePath preserved verbatim ---
test("snapshotFrom preserves index, name and worktreePath verbatim from the tmux listing", () => {
  const snap = snapshotFrom(P1);
  const w2 = snap.sessions[0].windows[1];
  assert.deepEqual(w2, {
    index: 2,
    name: "chat2",
    opencodeSessionId: "oc-2",
    cwd: "/home/dev/alpha/.worktrees/fix",
    worktreePath: "/home/dev/alpha/.worktrees/fix",
    active: false,
  });
});

// --- Required case 4: a non-worktree window keeps worktreePath: null ---
test("snapshotFrom keeps worktreePath null for a non-worktree window (never invented)", () => {
  const snap = snapshotFrom(P1);
  const w1 = snap.sessions[0].windows[0];
  assert.equal(w1.worktreePath, null);
});

// --- Required case 5: mantaOwned carried onto the snapshot session ---
test("snapshotFrom carries mantaOwned onto the snapshot session", () => {
  const snap = snapshotFrom(P1);
  const alpha = snap.sessions[0];
  assert.equal(alpha.mantaOwned, true);
  assert.equal(alpha.defaultCwd, "/home/dev/alpha");
});

test("snapshotFrom maps cwd from paneCurrentPath with a defaultCwd fallback", () => {
  const snap = snapshotFrom(
    [
      {
        tmuxSession: "x",
        defaultCwd: "/home/dev/x",
        mantaOwned: false,
        windows: [
          { index: 0, name: "chat", active: true, paneCurrentPath: "", opencodeSessionId: "oc-9" },
        ],
      },
    ],
    7,
  );
  // empty paneCurrentPath falls back to the project defaultCwd
  assert.equal(snap.sessions[0].windows[0].cwd, "/home/dev/x");
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

// --- Required case 6: shouldPersist REFUSES empty over non-empty ---
test("shouldPersist refuses an empty listing over a non-empty snapshot", () => {
  const full = snapshotFrom(P1);
  const empty = { version: TOPOLOGY_VERSION, capturedAt: 0, sessions: [] };
  assert.equal(shouldPersist(full, empty), false);
});

// --- Required case 7: empty-over-empty allowed; any non-empty allowed ---
test("shouldPersist allows empty-over-empty and any non-empty listing", () => {
  const full = snapshotFrom(P1);
  const empty = { version: TOPOLOGY_VERSION, capturedAt: 0, sessions: [] };
  assert.equal(shouldPersist(empty, empty), true);
  assert.equal(shouldPersist(null, full), true); // no file yet
  assert.equal(shouldPersist(null, empty), true); // no file yet, empty box converges once
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

test("loadTopology: valid file parses; missing/unparsable/malformed/unreadable → null", async () => {
  const good = JSON.stringify(snapshotFrom(P1, 99));
  const ok = makeIo({ initial: good });
  const parsed = await loadTopology("/tmp/ignored.json", ok.io);
  assert.equal(parsed.version, TOPOLOGY_VERSION);
  assert.equal(parsed.capturedAt, 99);
  assert.equal(countWindows(parsed), 2);

  for (const bad of [
    makeIo({ initial: null }), // missing file
    makeIo({ initial: "{not json" }), // invalid JSON
    makeIo({ initial: JSON.stringify({ version: TOPOLOGY_VERSION, sessions: {} }) }), // non-array sessions
    makeIo({ failRead: true }), // unreadable
  ]) {
    assert.equal(await loadTopology("/tmp/ignored.json", bad.io), null);
  }
});

// --- Required case 10: loadTopology returns null for an unknown version ---
test("loadTopology returns null for an unknown version (never guesses)", async () => {
  const { io } = makeIo({ initial: JSON.stringify({ version: 999, sessions: [] }) });
  assert.equal(await loadTopology("/tmp/ignored.json", io), null);
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

// --- Required case 8: persister skips an unchanged tick ---
test("persister skips an unchanged tick — save fn ran once for two identical calls", async () => {
  const { calls, io } = makeIo();
  const persist = createTopologyPersister({ save: io.writeFile, load: io.readFile, now: () => 1234 });
  const r1 = await persist(P1);
  assert.deepEqual(r1, { persisted: true, reason: "written" });
  assert.equal(calls.reads, 1); // hydrated exactly once, lazily
  assert.equal(calls.writes.length, 1);
  assert.deepEqual(JSON.parse(calls.writes[0][1]).capturedAt, 1234);

  const r2 = await persist(P1); // identical topology → no write
  assert.deepEqual(r2, { persisted: false, reason: "unchanged" });
  assert.equal(calls.writes.length, 1);

  const r3 = await persist(P1); // still hydrated once, not per call
  assert.deepEqual(r3, { persisted: false, reason: "unchanged" });
  assert.equal(calls.reads, 1);
});

// --- Required case 9: clobber refused against a snapshot hydrated from disk ---
test("persister refuses the clobber against a snapshot hydrated from disk", async () => {
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

// ---------------------------------------------------------------------------
// BET-1453 — restore planning + execution (pure)
// ---------------------------------------------------------------------------

// A snapshot in the exact shape snapshotFrom writes: two chat sessions,
// windows at NON-trivial indices (5 before 3 in the saved order) so the
// ascending-sort and the explicit-index behaviour are both exercised.
const SNAP = {
  version: TOPOLOGY_VERSION,
  capturedAt: 1234,
  sessions: [
    {
      tmuxSession: "alpha",
      defaultCwd: "/home/dev/alpha",
      mantaOwned: true,
      windows: [
        { index: 5, name: "w5", opencodeSessionId: "oc-5", cwd: "/home/dev/alpha", worktreePath: null, active: false },
        { index: 3, name: "w3", opencodeSessionId: "oc-3", cwd: "/home/dev/alpha", worktreePath: "/home/dev/alpha/.worktrees/fix", active: true },
        { index: 4, name: "w4", opencodeSessionId: "oc-4", cwd: "/home/dev/alpha", worktreePath: null, active: false },
      ],
    },
    {
      tmuxSession: "beta",
      defaultCwd: "/home/dev/beta",
      mantaOwned: false,
      windows: [
        { index: 1, name: "b1", opencodeSessionId: "oc-b", cwd: "/home/dev/beta", worktreePath: null, active: false },
      ],
    },
  ],
};

// A listProjects()-shaped live tree with one window, for idempotency checks.
function liveWindow(tmuxSession, index, opencodeSessionId) {
  return {
    tmuxSession,
    defaultCwd: "/home/dev/x",
    mantaOwned: false,
    windows: [{ index, name: "live", active: false, paneCurrentPath: "/home/dev/x", opencodeSessionId, worktreePath: null, owner: "user" }],
  };
}

// --- Required case 1: rebuilds into a dead box — create-session first, then
// create-window, indices ascending ---
test("planRestore rebuilds into a dead box — create-session first, then create-window, indices ascending", () => {
  const { ops, skipped } = planRestore(SNAP, [], null);
  assert.equal(skipped.length, 0);
  assert.deepEqual(ops.map((o) => [o.tmuxSession, o.index]), [
    ["alpha", 3], ["alpha", 4], ["alpha", 5], ["beta", 1],
  ]);
  assert.equal(ops[0].kind, "create-session");
  assert.equal(ops[1].kind, "create-window");
  assert.equal(ops[2].kind, "create-window");
  // beta is also dead → its first window is a create-session too
  assert.equal(ops[3].kind, "create-session");
  // the create-session op carries the full payload the executor needs
  assert.deepEqual(
    { ...ops[0], kind: undefined },
    {
      tmuxSession: "alpha", mantaOwned: true, index: 3, name: "w3",
      opencodeSessionId: "oc-3", cwd: "/home/dev/alpha",
      worktreePath: "/home/dev/alpha/.worktrees/fix", kind: undefined,
    },
  );
});

// --- Required case 2: reproduces the EXACT index ---
test("planRestore reproduces the exact snapshot index (5 stays 5)", () => {
  const { ops } = planRestore(SNAP, [], null);
  const op5 = ops.find((o) => o.tmuxSession === "alpha" && o.opencodeSessionId === "oc-5");
  assert.equal(op5.index, 5);
});

// --- Required case 3: never emits a non-creation op ---
test("planRestore never emits a non-creation op", () => {
  const { ops } = planRestore(SNAP, [], null);
  for (const op of ops) {
    assert.ok(op.kind === "create-session" || op.kind === "create-window", op.kind);
  }
});

// --- Required case 4: idempotent — a fully restored box plans nothing ---
test("planRestore is idempotent — a fully restored box plans nothing", () => {
  const live = [
    liveWindow("alpha", 3, "oc-3"),
    liveWindow("alpha", 4, "oc-4"),
    liveWindow("alpha", 5, "oc-5"),
    liveWindow("beta", 1, "oc-b"),
  ];
  const { ops } = planRestore(SNAP, live, null);
  assert.equal(ops.length, 0);
});

// --- Required case 5: after a partial restore only the remainder is planned,
// as create-window (session already exists) ---
test("planRestore after a partial restore plans only the remainder, as create-window", () => {
  const live = [liveWindow("alpha", 3, "oc-3"), liveWindow("alpha", 4, "oc-4")];
  const { ops, skipped } = planRestore(SNAP, live, null);
  assert.deepEqual(ops.map((o) => [o.tmuxSession, o.index, o.kind]), [
    ["alpha", 5, "create-window"],
    ["beta", 1, "create-session"],
  ]);
  // the two windows run 1 already rebuilt skip as already-restored (they are
  // stamped live at their reproduced indices) — not the alarming
  // "index-occupied"
  assert.deepEqual(
    skipped.map((s) => [s.tmuxSession, s.index, s.reason]),
    [["alpha", 3, "already-restored"], ["alpha", 4, "already-restored"]],
  );
});

// --- Required case 6: skips an id already stamped under a DIFFERENT session ---
test("planRestore skips an id already stamped under a different session (already-restored)", () => {
  const live = [liveWindow("gamma", 9, "oc-5")];
  const { ops, skipped } = planRestore(SNAP, live, null);
  const skip = skipped.find((s) => s.tmuxSession === "alpha" && s.index === 5);
  assert.equal(skip.reason, "already-restored");
  assert.ok(!ops.some((o) => o.opencodeSessionId === "oc-5"));
  // the rest of alpha is still planned (its session is dead → create-session)
  assert.equal(ops[0].kind, "create-session");
  assert.deepEqual(ops.map((o) => o.index), [3, 4, 1]);
});

// --- Required case 7: skips an occupied index ---
test("planRestore skips an occupied index (index-occupied)", () => {
  // alpha IS live and index 5 is held by a TUI window (no opencode id) —
  // the slot is taken, the conversation's id is stamped nowhere.
  const live = [
    { tmuxSession: "alpha", defaultCwd: "/home/dev/alpha", mantaOwned: true, windows: [{ index: 5, name: "shell", active: false, paneCurrentPath: "/home/dev/alpha", opencodeSessionId: null, worktreePath: null, owner: "user" }] },
  ];
  const { ops, skipped } = planRestore(SNAP, live, null);
  const skip = skipped.find((s) => s.tmuxSession === "alpha" && s.index === 5);
  assert.equal(skip.reason, "index-occupied");
  // alpha exists live → every planned alpha op is a create-window
  assert.deepEqual(ops.map((o) => [o.tmuxSession, o.kind]), [["alpha", "create-window"], ["alpha", "create-window"], ["beta", "create-session"]]);
});

// --- Required case 8: drops windows whose opencode session is gone ---
test("planRestore drops windows whose opencode session is gone (knownSessionIds Set)", () => {
  const { ops, skipped } = planRestore(SNAP, [], new Set(["oc-3", "oc-4"]));
  assert.deepEqual(ops.map((o) => o.opencodeSessionId), ["oc-3", "oc-4"]);
  assert.deepEqual(
    skipped.map((s) => [s.tmuxSession, s.index, s.reason]),
    [["alpha", 5, "opencode-session-gone"], ["beta", 1, "opencode-session-gone"]],
  );
});

// --- Required case 9: knownSessionIds === null keeps everything ---
test("planRestore with knownSessionIds === null keeps everything (unknown ≠ nothing survives)", () => {
  const { ops, skipped } = planRestore(SNAP, [], null);
  assert.equal(ops.length, 4);
  assert.equal(skipped.length, 0);
});

test("planRestore tolerates null and {sessions: []} input", () => {
  assert.deepEqual(planRestore(null, [], null), { ops: [], skipped: [] });
  assert.deepEqual(planRestore({ version: TOPOLOGY_VERSION, capturedAt: 0, sessions: [] }, [], null), { ops: [], skipped: [] });
});

test("planRestore claims an id as it plans it — a duplicate id in one snapshot cannot be created twice", () => {
  const snap = {
    version: TOPOLOGY_VERSION,
    capturedAt: 1,
    sessions: [
      {
        tmuxSession: "alpha", defaultCwd: "/d", mantaOwned: false,
        windows: [
          { index: 2, name: "a", opencodeSessionId: "oc-dup", cwd: "/d", worktreePath: null, active: false },
          { index: 7, name: "b", opencodeSessionId: "oc-dup", cwd: "/d", worktreePath: null, active: false },
        ],
      },
    ],
  };
  const { ops, skipped } = planRestore(snap, [], null);
  assert.deepEqual(ops.map((o) => o.index), [2]);
  assert.equal(ops[0].kind, "create-session");
  assert.deepEqual(skipped.map((s) => [s.index, s.reason]), [[7, "already-restored"]]);
});

// --- Required case 10: executeRestore continues past a failed create-window ---
test("executeRestore continues past a failed create-window", async () => {
  const { ops, skipped } = planRestore(SNAP, [], null);
  const attempted = [];
  const result = await executeRestore({ ops, skipped }, async (op) => {
    attempted.push(`${op.tmuxSession}/${op.index}`);
    if (op.tmuxSession === "alpha" && op.index === 4) throw new Error("tmux boom");
  });
  assert.deepEqual(attempted, ["alpha/3", "alpha/4", "alpha/5", "beta/1"]);
  assert.equal(result.created, 3);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.windows.map((w) => `${w.tmuxSession}/${w.index}`), ["alpha/3", "alpha/5", "beta/1"]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].index, 4);
  assert.equal(result.failures[0].error, "tmux boom");
});

// --- Required case 11: executeRestore skips the rest of a session after a
// failed create-session ---
test("executeRestore skips the rest of a session after a failed create-session", async () => {
  const { ops, skipped } = planRestore(SNAP, [], null);
  const attempted = [];
  const result = await executeRestore({ ops, skipped }, async (op) => {
    attempted.push(`${op.tmuxSession}/${op.index}`);
    if (op.kind === "create-session" && op.tmuxSession === "alpha") throw new Error("can't create session");
  });
  // alpha/3 attempted once; alpha/4 + alpha/5 failed WITHOUT an attempt;
  // beta still restored.
  assert.deepEqual(attempted, ["alpha/3", "beta/1"]);
  assert.equal(result.created, 1);
  assert.equal(result.failed, 3);
  assert.deepEqual(result.failures.map((f) => [f.index, f.error]), [
    [3, "can't create session"],
    [4, "skipped — its tmux session could not be created"],
    [5, "skipped — its tmux session could not be created"],
  ]);
  // created + failed always equals the planned window count
  assert.equal(result.created + result.failed, ops.length);
});

// --- Required case 12: describeRestore covers created-only, created+failed,
// and nothing-to-do ---
test("describeRestore covers created-only, created+failed, and nothing-to-do", () => {
  assert.equal(describeRestore({ created: 3, failed: 0 }), "Restored 3 windows.");
  assert.equal(describeRestore({ created: 3, failed: 2 }), "Restored 3 windows · 2 failed.");
  assert.equal(describeRestore({ created: 0, failed: 0 }), "Nothing to restore — every saved window is already open.");
  assert.equal(describeRestore({ created: 1, failed: 0 }), "Restored 1 window.");
});
