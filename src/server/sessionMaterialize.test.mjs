import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeSession, promoteViewWindows, createViewWindowCloser, createViewWindowArmer } from "./sessionMaterialize.mjs";
import { createHandoffEngine } from "./handoff/engine.mjs";
import { createWorld, readyRecord } from "./handoff/testWorld.mjs";
import { cleanupTerminalJob, adoptExistingSession, deleteJob } from "./delegate.mjs";

function world() {
  const windows = [];
  const calls = [];
  const h = createHandoffEngine();
  const deps = {
    handoff: h,
    sessionStatus: {
      canonicalSessionOf: (sid) => h.successorOf(sid) ?? sid,
      placementOf: (sid) => ({ project: "p", canonicalSessionId: h.successorOf(sid) ?? sid, rootPath: "/root", defaultCwd: "/default" }),
    },
    tmux: {
      listProjects: async () => [{ tmuxSession: "p", windows }],
      newWindow: async (args) => { calls.push(["create", args]); await Promise.resolve(); const index = windows.length; windows.push({ index, opencodeSessionId: args.existingSessionId }); return { windowIndex: index }; },
      stampOwner: async (...a) => calls.push(["owner", ...a]),
    },
    readSession: async () => ({ state: "found", session: { title: "Child", directory: "/own" } }),
    directoryExists: async () => true,
    refresh: async () => { await Promise.resolve(); calls.push(["refresh"]); },
    warn: () => {},
  };
  return { deps, windows, calls, run: (sid = "s") => materializeSession({ sessionId: sid }, deps) };
}

test("materialize serialises concurrent calls to one viewer holder, refreshes before every answer, reuses existing", async () => {
  const w = world();
  const result = await Promise.all([w.run(), w.run(), w.run()]);
  assert.ok(result.every((r) => r.ok && r.windowIndex === 0 && r.sessionId === "s"));
  assert.equal(w.windows.length, 1);
  assert.equal(w.calls.filter(([k]) => k === "create").length, 1);
  assert.deepEqual(w.calls.find(([k]) => k === "owner"), ["owner", "p", 0, "view"]);
  // two fresh reads under the exclusions + one before the answer, per call
  assert.equal(w.calls.filter(([k]) => k === "refresh").length, 9);
  assert.equal(w.calls.at(-1)[0], "refresh");
});

test("materialize never re-annotates the session list itself (the served tree signature stays the sync path's)", async () => {
  const w = world();
  let annotated = 0;
  w.deps.sessionStatus.annotateProjects = () => { annotated++; };
  assert.equal((await w.run()).ok, true);
  assert.equal(annotated, 0);
});

test("materialize expected refusals and safe failure copy", async () => {
  const w = world();
  assert.deepEqual(await materializeSession(null, w.deps), { ok: false, reason: "not-found", message: "This session no longer exists." });
  w.deps.sessionStatus.placementOf = () => null;
  assert.deepEqual(await w.run(), { ok: false, reason: "no-project", message: "No workspace owns this session." });
  w.deps.sessionStatus.placementOf = () => ({ project: "p", canonicalSessionId: "s" });
  w.deps.readSession = async () => ({ state: "missing" });
  assert.deepEqual(await w.run(), { ok: false, reason: "not-found", message: "This session no longer exists." });
  w.deps.handoff.chainOf = () => ["old", "s"];
  w.deps.handoff.hasPendingSend = (sid) => sid === "old";
  assert.deepEqual(await w.run(), { ok: false, reason: "handoff", message: "A handoff of this conversation is in progress — try again in a moment." });
  w.deps.handoff.hasPendingSend = () => false;
  w.deps.readSession = async () => { throw new Error("/private/path ENOENT"); };
  assert.deepEqual(await w.run(), { ok: false, reason: "failed", message: "Couldn't open this session." });
  assert.equal(w.windows.length, 0);
});

test("materialize chooses the resource lock from fresh stamps after a handoff, not the stale sync snapshot", async () => {
  const w = world();
  let canonical = "old";
  w.deps.sessionStatus.canonicalSessionOf = () => canonical;
  const refresh = w.deps.refresh;
  w.deps.refresh = async () => { canonical = "new"; await refresh(); };
  w.deps.sessionStatus.placementOf = () => ({ project: "p", canonicalSessionId: canonical, rootPath: "/root" });
  let locked;
  w.deps.sessionLock = async (sid, fn) => { locked = sid; return fn(); };
  assert.equal((await w.run("old")).sessionId, "new");
  assert.equal(locked, "new");
});

for (const [available, expected] of [[["/own", "/root", "/default"], "/own"], [["/root", "/default"], "/root"], [["/default"], "/default"], [["/config"], "/config"]]) {
  test(`materialize cwd falls back to ${expected}`, async () => {
    const w = world();
    w.deps.directoryExists = async (p) => available.includes(p);
    w.deps.configGet = async () => ({ projects: [{ tmuxSession: "p", defaultCwd: "/config" }] });
    assert.equal((await w.run()).ok, true);
    assert.equal(w.calls.find(([k]) => k === "create")[1].cwd, expected);
  });
}

for (const first of ["materialize", "commit"]) {
  test(`handoff exclusion: ${first} first leaves exactly one holder stamped with successor`, async () => {
    const hw = createWorld();
    hw.addSession("ses_p");
    let entered, release;
    const enteredGate = new Promise((r) => entered = r);
    const gate = new Promise((r) => release = r);
    const h = hw.build({ hooks: { step: async (step) => {
      if (first === "commit" && step === "attach") { entered(); await gate; }
    } } });
    // Prepare while the predecessor still has the window required for handoff preparation, then close it.
    hw.addWindow("proj", 3, "work", "ses_p");
    const record = await readyRecord(hw, { engine: h });
    hw.windows.splice(0);
    const w = world();
    w.deps.handoff = h;
    w.deps.tmux.listProjects = async () => [{ tmuxSession: "proj", windows: hw.windows.map((x) => ({ index: x.windowIndex, opencodeSessionId: x.sid })) }];
    w.deps.tmux.newWindow = async (a) => { hw.addWindow("proj", 3, "work", a.existingSessionId); return { windowIndex: 3 }; };
    const canonical = () => h.successorOf("ses_p") ?? "ses_p";
    w.deps.sessionStatus.canonicalSessionOf = canonical;
    w.deps.sessionStatus.placementOf = () => ({ project: "proj", canonicalSessionId: canonical(), rootPath: "/proj" });
    let clicked;
    if (first === "materialize") {
      const newWindow = w.deps.tmux.newWindow;
      w.deps.tmux.newWindow = async (a) => { entered(); await gate; return newWindow(a); };
      clicked = w.run("ses_p");
      await enteredGate;
    }
    const commit = h.start(record.id, { how: "clear", disposition: "draft" });
    if (first === "materialize") release();
    else {
      await enteredGate;
      clicked = w.run("ses_p");
      await Promise.resolve();
      assert.equal(hw.windows.length, 0, "materialize waits while the commit owns the exclusion");
      release();
    }
    const result = await commit;
    assert.equal((await clicked).ok, true);
    assert.equal(hw.windows.length, 1);
    assert.equal(hw.windows[0].sid, result.successorId);
  });
}

for (const owner of ["user", null, "job"]) {
  test(`cleanup respects current owner ${owner}`, async () => {
    const calls = [];
    const job = { id: "j", tmuxSession: "p", windowIndex: owner === "job" ? 2 : null, childSessionID: "s", worktree: "/wt", parentDirectory: "/repo" };
    const out = await cleanupTerminalJob(job, {
      load: async () => [job],
      listProjects: async () => [{ tmuxSession: "p", windows: [{ index: 2, opencodeSessionId: "s" }] }],
      getWindowOption: async () => owner,
      gitRemoveWorktree: async () => { calls.push("remove"); return { removed: true }; },
      killWindow: async () => calls.push("kill"),
      rebaseHolder: async (...a) => calls.push(["rebase", ...a]),
      setWindowOption: async (...a) => calls.push(["clear", ...a]),
    });
    assert.equal(out.cleanedUp, true);
    assert.deepEqual(calls, owner === "job" ? ["remove", "kill"] : ["remove", ["rebase", "p", 2, "/repo"], ["clear", "p", 2, "@manta-worktree-path", ""]]);
  });
}

test("adoption never creates or changes ownership of a holder, reuses a stamped one when present", async () => {
  for (const windowIndex of [null, 4]) {
    let records = [];
    const out = await adoptExistingSession({ childSessionID: "s", owner: { tmuxSession: "p" }, name: "child", origin: "subagent" }, {
      load: async () => records, save: async (v) => records = v,
      listProjects: async () => [{ tmuxSession: "p", windows: windowIndex === null ? [] : [{ index: windowIndex, opencodeSessionId: "s" }] }],
      newWindow: async () => assert.fail("must not create"), stampOwner: async () => assert.fail("must not change owner"),
    });
    assert.equal(out.ok, true);
    assert.equal(out.job.windowIndex, windowIndex);
  }
});

test("automatic cleanup preserves a user no-worktree holder, but explicit job deletion closes its newly materialised holder", async () => {
  let records = [{ id: "j", childSessionID: "s", tmuxSession: "p", windowIndex: null, worktree: null, status: "running" }];
  const killed = [];
  const deps = {
    load: async () => records, save: async (v) => records = v,
    listProjects: async () => [{ tmuxSession: "p", windows: [{ index: 8, opencodeSessionId: "s" }] }],
    getWindowOption: async () => "user",
    killWindow: async (i) => killed.push(i),
  };
  await cleanupTerminalJob(records[0], deps);
  assert.deepEqual(killed, []);
  assert.equal((await deleteJob("j", deps)).ok, true);
  assert.deepEqual(killed, [{ sessionName: "p", windowIndex: 8 }]);
});

test("materialize answers an existing window without restamping it (a user's window stays the user's)", async () => {
  const w = world();
  w.windows.push({ index: 4, opencodeSessionId: "s", owner: "user" });
  assert.equal((await w.run()).windowIndex, 4);
  assert.equal(w.calls.some(([k]) => k === "owner"), false);
});

// ---- viewer windows: promotion on a send, and the box's closer, share materialize's ordering ----

/** One window, and the ordering primitives: a per-chain mutex (the handoff engine's chain exclusion) + the real session lock. */
function viewWorld(window = { sid: "S", owner: "view", armed: true }) {
  const w = { window, log: [], kills: [], active: [], gate: null };
  let tail = Promise.resolve();
  w.exclusive = (_sid, fn) => {
    const run = tail.then(() => fn());
    tail = run.catch(() => {});
    return run;
  };
  w.listProjects = async () => {
    w.log.push("read");
    return [{ tmuxSession: "p", windows: w.window ? [{ index: 7, opencodeSessionId: w.window.sid, owner: w.window.owner, ...(w.window.armed ? { viewArmed: true } : {}) }] : [] }];
  };
  w.close = (sid = "S") => createViewWindowCloser({
    listProjects: w.listProjects,
    listActiveSessionIds: async () => { w.log.push("active"); if (w.gate) await w.gate; return w.active; },
    killWindow: async (a) => { w.kills.push({ a, at: { ...w.window } }); w.window = null; },
    refresh: async () => { w.log.push("refresh"); },
    chainOf: () => ["S", "T"],
    canonicalSessionOf: (s) => { w.log.push(`canon:${s}`); return s; },
    withChainExclusive: (s, fn) => { w.log.push("exclusive"); return w.exclusive(s, fn); },
    warn: () => {},
  })({ project: "p", windowIndex: 7, sessionId: sid });
  w.promote = (sid = "T", over = {}) => promoteViewWindows(sid, {
    listProjects: w.listProjects,
    stampOwner: async (_p, _i, owner) => { w.log.push("stamp"); if (w.window) w.window.owner = owner; },
    chainOf: () => ["S", "T"],
    canonicalSessionOf: (s) => { w.log.push(`canon:${s}`); return s; },
    withChainExclusive: (s, fn) => { w.log.push("exclusive"); return w.exclusive(s, fn); },
    refresh: async () => { w.log.push("refresh"); },
    warn: () => {},
    ...over,
  });
  return w;
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

test("promoteViewWindows: restamps only viewer windows of the session's chain; one failure never stops the rest", async () => {
  const stamps = [];
  const warned = [];
  const listProjects = async () => [{ tmuxSession: "p", windows: [
    { index: 1, opencodeSessionId: "a", owner: "view" },
    { index: 2, opencodeSessionId: "a", owner: "user" },
    { index: 3, opencodeSessionId: "b", owner: "view" },
    { index: 4, opencodeSessionId: "old", owner: "view" },
  ] }];
  const stampOwner = async (...a) => { if (a[1] === 1) throw new Error("tmux down"); stamps.push(a); };
  const n = await promoteViewWindows("a", { listProjects, stampOwner, chainOf: () => ["old", "a"], warn: (m) => warned.push(m) });
  assert.equal(n, 1);
  assert.deepEqual(stamps, [["p", 4, "user"]]);
  assert.equal(warned.length, 1);
  assert.equal(await promoteViewWindows("", { listProjects: async () => assert.fail("no session"), stampOwner }), 0);
  assert.equal(await promoteViewWindows("a", { listProjects: async () => { throw new Error("no tmux"); }, stampOwner, warn: () => {} }), 0);
});

test("promoteViewWindows: with no LIVE viewer window it takes no exclusion and no lock; otherwise the order is materialize's", async () => {
  const idle = viewWorld({ sid: "S", owner: "user", armed: false });
  assert.equal(await idle.promote(), 0);
  assert.deepEqual(idle.log, ["read"], "one cheap live read: no exclusion, no refresh, no canonical lookup");

  const w = viewWorld();
  assert.equal(await w.promote(), 1);
  assert.deepEqual(w.log, ["read", "exclusive", "refresh", "canon:T", "read", "stamp"], "live read · chain exclusion · fresh list · canonical inside it · LIVE read again · stamp");
  assert.equal(w.window.owner, "user");
});

test("promoteViewWindows: a cached list is never consulted — a viewer the sync snapshot lacks (or still shows) is judged by the live list", async () => {
  // The live list has the viewer while any cached snapshot would not: promoted.
  const stamps = [];
  const n = await promoteViewWindows("T", {
    listProjects: async () => [{ tmuxSession: "p", windows: [{ index: 7, opencodeSessionId: "S", owner: "view" }] }],
    stampOwner: async (...a) => stamps.push(a),
    chainOf: () => ["S", "T"],
    warn: () => {},
  });
  assert.equal(n, 1);
  assert.deepEqual(stamps, [["p", 7, "user"]]);
  // Between the first live read and the one under the exclusions the window was promoted by someone else: nothing to stamp.
  const reads = [
    [{ tmuxSession: "p", windows: [{ index: 7, opencodeSessionId: "S", owner: "view" }] }],
    [{ tmuxSession: "p", windows: [{ index: 7, opencodeSessionId: "S", owner: "user" }] }],
  ];
  const again = [];
  const m = await promoteViewWindows("T", {
    listProjects: async () => reads.shift(),
    stampOwner: async (...a) => again.push(a),
    chainOf: () => ["S", "T"],
    warn: () => {},
  });
  assert.equal(m, 0);
  assert.deepEqual(again, []);
});

test("view closer: kills a still-armed viewer window of a session that is still not running, in materialize's order", async () => {
  const w = viewWorld();
  assert.deepEqual(await w.close(), { closed: true });
  assert.deepEqual(w.log, ["exclusive", "refresh", "canon:S", "read", "active", "refresh"]);
  assert.deepEqual(w.kills.map((k) => k.a), [{ sessionName: "p", windowIndex: 7 }]);
});

test("view closer: never kills a promoted, re-stamped, unarmed or running window (any chain member)", async () => {
  for (const [patch, reason] of [
    [{ owner: "user" }, "changed"], [{ owner: "job" }, "changed"], [{ sid: "other" }, "changed"], [{ armed: false }, "unarmed"],
  ]) {
    const w = viewWorld({ sid: "S", owner: "view", armed: true, ...patch });
    assert.deepEqual(await w.close(), { closed: false, reason }, JSON.stringify(patch));
    assert.deepEqual(w.kills, []);
  }
  for (const active of [["S"], ["T"]]) {
    const w = viewWorld();
    w.active = active;
    assert.deepEqual(await w.close(), { closed: false, reason: "running" });
    assert.deepEqual(w.kills, []);
  }
  const gone = viewWorld(null);
  assert.equal((await gone.close()).closed, false);
});

test("view closer: unreadable state leaves the window open; a failed refresh does not undo the close", async () => {
  const w = viewWorld();
  const closer = createViewWindowCloser({
    listProjects: w.listProjects, listActiveSessionIds: async () => { throw new Error("opencode down"); },
    killWindow: async () => assert.fail("must not kill"), withChainExclusive: w.exclusive, warn: () => {},
  });
  assert.deepEqual(await closer({ project: "p", windowIndex: 7, sessionId: "S" }), { closed: false, reason: "failed" });
  const refreshFails = viewWorld();
  const closer2 = createViewWindowCloser({
    listProjects: refreshFails.listProjects, listActiveSessionIds: async () => [],
    killWindow: async () => { refreshFails.window = null; }, refresh: async () => { throw new Error("sync failed"); },
    withChainExclusive: refreshFails.exclusive, warn: () => {},
  });
  assert.deepEqual(await closer2({ project: "p", windowIndex: 7, sessionId: "S" }), { closed: true });
});

test("interleaving: a closer queued behind a handoff commit and a promotion never kills the window the user now owns", async () => {
  const w = viewWorld();
  let releaseCommit;
  const commitGate = new Promise((r) => { releaseCommit = r; });
  // A handoff commit holds the chain exclusion and is about to restamp the window S → T…
  const commit = w.exclusive("S", async () => { await commitGate; w.window.sid = "T"; w.log.push("commit"); });
  // …while the box (acting on a decision made when the window still read as S) asks to close it, and the user sends.
  const closing = w.close("S");
  const promoting = w.promote("T");
  await flush();
  assert.deepEqual(w.log.filter((e) => e === "read" || e === "active"), ["read"], "only the promotion's cheap peek ran: the closer has not touched the window");
  releaseCommit();
  const [closed, promoted] = await Promise.all([closing, promoting, commit]).then(([c, p]) => [c, p]);
  assert.deepEqual(closed, { closed: false, reason: "changed" }, "the live window is T now: not the one the decision was about");
  assert.equal(promoted, 1);
  assert.deepEqual(w.kills, []);
  assert.deepEqual(w.window, { sid: "T", owner: "user", armed: true });
});

test("interleaving: a closer that holds the exclusion first kills only a window that is still an armed viewer at that moment", async () => {
  const w = viewWorld();
  let releaseGate;
  w.gate = new Promise((r) => { releaseGate = r; });
  const closing = w.close("S");
  await flush();
  assert.ok(w.log.includes("active"), "the closer read the window as S and is deciding");
  const commit = w.exclusive("S", async () => { if (w.window) w.window.sid = "T"; w.log.push("commit"); });
  const promoting = w.promote("T");
  await flush();
  assert.ok(!w.log.includes("commit"), "the commit waits for the closer");
  releaseGate();
  await Promise.all([closing, commit, promoting]);
  assert.equal(w.kills.length, 1);
  assert.deepEqual(w.kills[0].at, { sid: "S", owner: "view", armed: true }, "at the moment of the kill it was still the armed viewer of S");
  assert.equal(w.window, null);
});

// ---- arming validates identity ----
function armWorld(window = { sid: "S", owner: "view", armed: false }) {
  const w = viewWorld(window);
  w.stamps = [];
  w.arm = (sid = "S") => createViewWindowArmer({
    listProjects: w.listProjects,
    stampViewArmed: async (project, index) => { w.stamps.push([project, index, w.window && { ...w.window }]); },
    refresh: async () => { w.log.push("refresh"); },
    chainOf: () => ["S", "T"],
    canonicalSessionOf: (s) => { w.log.push(`canon:${s}`); return s; },
    withChainExclusive: (s, fn) => { w.log.push("exclusive"); return w.exclusive(s, fn); },
  })({ project: "p", windowIndex: 7, sessionId: sid });
  return w;
}

test("view armer: stamps a window that is still a viewer of that session (or a member of its chain), in materialize's order", async () => {
  const w = armWorld();
  assert.deepEqual(await w.arm("S"), { armed: true });
  assert.deepEqual(w.log, ["exclusive", "refresh", "canon:S", "read"]);
  assert.equal(w.stamps.length, 1);
  const chain = armWorld({ sid: "T", owner: "view", armed: false });
  assert.deepEqual(await chain.arm("S"), { armed: true }, "the window now carries a successor of the session");
});

test("view armer: never stamps a window that is not that session's viewer any more", async () => {
  for (const patch of [{ sid: "Z" }, { owner: "user" }, { owner: "job" }]) {
    const w = armWorld({ sid: "S", owner: "view", armed: false, ...patch });
    assert.deepEqual(await w.arm("S"), { armed: false, reason: "changed" }, JSON.stringify(patch));
    assert.deepEqual(w.stamps, []);
  }
  const gone = armWorld(null);
  assert.equal((await gone.arm()).armed, false);
  assert.deepEqual(gone.stamps, []);
});

test("interleaving: a tmux index reused by a viewer of an unrelated finished session between queueing and stamping is not armed", async () => {
  const w = armWorld();
  let release;
  const gate = new Promise((r) => { release = r; });
  // Something holds the chain exclusion (a handoff commit); the arm for S (viewer at index 7) queues behind it.
  const holder = w.exclusive("S", async () => { await gate; });
  const arming = w.arm("S");
  await flush();
  // Meanwhile the window at index 7 was closed and the index reused by a viewer of a different, finished session.
  w.window = { sid: "OTHER", owner: "view", armed: false };
  release();
  await holder;
  assert.deepEqual(await arming, { armed: false, reason: "changed" });
  assert.deepEqual(w.stamps, [], "the reused index was not armed");
});
