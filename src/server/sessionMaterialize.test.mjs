import { test } from "node:test";
import assert from "node:assert/strict";
import { materializeSession } from "./sessionMaterialize.mjs";
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

test("materialize serialises concurrent calls to one user holder, refreshes before every answer, reuses existing", async () => {
  const w = world();
  const result = await Promise.all([w.run(), w.run(), w.run()]);
  assert.ok(result.every((r) => r.ok && r.windowIndex === 0 && r.sessionId === "s"));
  assert.equal(w.windows.length, 1);
  assert.equal(w.calls.filter(([k]) => k === "create").length, 1);
  assert.deepEqual(w.calls.find(([k]) => k === "owner"), ["owner", "p", 0, "user"]);
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
