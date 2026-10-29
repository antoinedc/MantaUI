import { test } from "node:test";
import assert from "node:assert/strict";
import { previewClose, closeSession, METADATA_WARNING, CLOSE_FAILED, SESSION_CHANGED, CONVERSATION_WARNING } from "./sessionClose.mjs";

const win = (index, name, over = {}) => ({ index, name, ...over });
const projects = [
  { tmuxSession: "p", windows: [win(0, "a"), win(1, "b", { worktreePath: "/wt/b" }), win(2, "c", { worktreePath: "/wt/b" })] },
  { tmuxSession: "empty", windows: [] },
  { tmuxSession: "one", windows: [win(0, "solo")] },
];
const running = (set) => (w, p) => set.has(`${p}:${w.index}`);

test("preview: a single window — copy, running and worktree outcomes", () => {
  assert.deepEqual(previewClose({ project: "p", windowIndex: 0, projects, cleanOnClose: true, isRunning: running(new Set()) }), {
    title: "Close “a”?", body: "Its tmux window will be killed on the server.", confirmLabel: "Close session", runningCount: 0, worktreeLine: null, worktrees: [],
  });
  const r = previewClose({ project: "p", windowIndex: 1, projects, cleanOnClose: true, isRunning: running(new Set(["p:1"])) });
  assert.equal(r.body, "Its tmux window will be killed on the server. A turn is currently running and will be stopped. Its worktree at /wt/b will be removed.");
  assert.deepEqual(r.worktrees, [{ path: "/wt/b", willRemove: true }]);
  assert.equal(r.worktreeLine, "Its worktree at /wt/b will be removed.", "the worktree sentence on its own (iOS shows it inside its own running-turn confirm)");
  const off = previewClose({ project: "p", windowIndex: 1, projects, cleanOnClose: false, isRunning: running(new Set()) });
  assert.doesNotMatch(off.body, /worktree at/);
  assert.deepEqual(off.worktrees, [{ path: "/wt/b", willRemove: false }]);
});

test("preview: a project — 0 / 1 / N sessions, running counts, a shared worktree counted once", () => {
  assert.deepEqual(previewClose({ project: "empty", projects, cleanOnClose: true, isRunning: running(new Set()) }), {
    title: "Close “empty”?", body: "Its tmux session will be killed on the server.", confirmLabel: "Close project", runningCount: 0, worktreeLine: null, worktrees: [],
  });
  const one = previewClose({ project: "one", projects, cleanOnClose: true, isRunning: running(new Set(["one:0"])) });
  assert.equal(one.title, "Close “one” and its 1 session?");
  assert.equal(one.body, "All 1 tmux window will be killed on the server. 1 session is mid-turn and will be stopped.");
  const many = previewClose({ project: "p", projects, cleanOnClose: true, isRunning: running(new Set(["p:0", "p:1"])) });
  assert.equal(many.title, "Close “p” and its 3 sessions?");
  assert.equal(many.body, "All 3 tmux windows will be killed on the server. 2 sessions are mid-turn and will be stopped. 1 worktree will be removed.");
  assert.deepEqual(many.worktrees, [{ path: "/wt/b", willRemove: true }]);
  assert.doesNotMatch(previewClose({ project: "p", projects, cleanOnClose: false, isRunning: running(new Set()) }).body, /worktree/);
});

function fakes(over = {}) {
  const calls = [];
  const d = {
    listProjects: async () => projects,
    cleanOnClose: async () => true,
    removeWorktree: async (a) => (calls.push(["remove", a]), { removed: true }),
    killWindow: async (a) => (calls.push(["killWindow", a]), {}),
    killSession: async (n) => (calls.push(["killSession", n]), {}),
    projectMetaDelete: async (n) => (calls.push(["meta", n]), {}),
    refresh: async () => calls.push(["refresh"]),
    warn: () => {},
    ...over,
  };
  return { d, calls };
}

test("close window: removes the worktree, kills, refreshes — in that order", async () => {
  const { d, calls } = fakes();
  const r = await closeSession({ project: "p", windowIndex: 1 }, d);
  assert.deepEqual(r, { ok: true, removed: ["/wt/b"], kept: [], failed: [], warnings: [], notice: null });
  assert.deepEqual(calls.map((c) => c[0]), ["remove", "killWindow", "refresh"]);
  assert.deepEqual(calls[0][1], { path: "/wt/b", force: false });
});

test("close window: a dirty worktree asks first and kills NOTHING", async () => {
  const { d, calls } = fakes({ removeWorktree: async () => ({ removed: false, reason: "dirty" }) });
  const r = await closeSession({ project: "p", windowIndex: 1 }, d);
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirm.kind, "worktree-dirty");
  assert.equal(r.needsConfirm.path, "/wt/b");
  assert.equal(r.needsConfirm.removeLabel, "Remove worktree");
  assert.equal(r.needsConfirm.keepLabel, "Keep worktree");
  assert.deepEqual(calls.filter((c) => c[0].startsWith("kill")), []);
});

test("close window: dirtyWorktree 'remove' forces; 'keep' leaves it with today's notice", async () => {
  const f1 = fakes();
  const forced = await closeSession({ project: "p", windowIndex: 1, dirtyWorktree: "remove", expect: { opencodeSessionId: null, worktreePath: "/wt/b" } }, f1.d);
  assert.deepEqual(f1.calls[0][1], { path: "/wt/b", force: true });
  assert.deepEqual(forced.removed, ["/wt/b"]);
  const f2 = fakes();
  const kept = await closeSession({ project: "p", windowIndex: 1, dirtyWorktree: "keep" }, f2.d);
  assert.deepEqual(f2.calls.filter((c) => c[0] === "remove"), [], "keep never touches git");
  assert.deepEqual(kept.kept, ["/wt/b"]);
  assert.equal(kept.notice, "Kept worktree at /wt/b");
});

test("close project: a dirty worktree is kept (never asked, never forced) and noticed; shared path removed once", async () => {
  let attempts = 0;
  const f = fakes({ removeWorktree: async () => (attempts++, { removed: false, reason: "dirty" }) });
  const r = await closeSession({ project: "p" }, f.d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, ["/wt/b"]);
  assert.equal(r.notice, "Kept worktree at /wt/b — it has uncommitted changes.");
  assert.equal(attempts, 1, "two windows sharing one worktree → one attempt");
  assert.deepEqual(f.calls.map((c) => c[0]), ["killSession", "meta", "refresh"]);
  // N worktrees
  const many = [{ tmuxSession: "m", windows: [win(0, "a", { worktreePath: "/1" }), win(1, "b", { worktreePath: "/2" })] }];
  const f2 = fakes({ listProjects: async () => many, removeWorktree: async () => ({ removed: false, reason: "dirty" }) });
  assert.equal((await closeSession({ project: "m" }, f2.d)).notice, "Kept 2 worktrees with uncommitted changes.");
});

test("a worktree removal that THROWS does not stop the kill: ok, listed in `failed` (not `removed`), one warning", async () => {
  const f = fakes({ removeWorktree: async () => { throw new Error("EBUSY /secret/path"); } });
  const r = await closeSession({ project: "p", windowIndex: 1 }, f.d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.failed, [{ path: "/wt/b", message: "Couldn't remove the worktree at /wt/b — it was left in place." }]);
  assert.deepEqual(r.warnings, [r.failed[0].message]);
  assert.doesNotMatch(JSON.stringify(r), /EBUSY/, "the raw error never reaches the client");
  assert.ok(f.calls.some((c) => c[0] === "killWindow"));
});

test("a refusal other than dirty is `failed` too; each path is in exactly one list", async () => {
  const f = fakes({ removeWorktree: async () => ({ removed: false, reason: "locked" }) });
  const r = await closeSession({ project: "p" }, f.d);
  assert.deepEqual([r.removed, r.kept, r.failed.map((x) => x.path)], [[], [], ["/wt/b"]]);
});

test("project metadata that cannot be cleared: ok:true plus the metadata warning", async () => {
  const f = fakes({ projectMetaDelete: async () => { throw new Error("disk"); } });
  const r = await closeSession({ project: "one" }, f.d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [METADATA_WARNING]);
});

test("a tmux failure is a sentence, not the raw error", async () => {
  const f = fakes({ killWindow: async () => { throw new Error("tmux: raw /home/x"); } });
  const r = await closeSession({ project: "p", windowIndex: 0 }, f.d);
  assert.deepEqual(r, { ok: false, error: CLOSE_FAILED, removed: [], kept: [], failed: [], warnings: [] });
  assert.doesNotMatch(JSON.stringify(r), /raw|\/home\/x/);
});

test("a kill that fails AFTER the worktree was removed says so, with the lists", async () => {
  const f = fakes({ killWindow: async () => { throw new Error("boom"); } });
  const r = await closeSession({ project: "p", windowIndex: 1 }, f.d);
  assert.equal(r.ok, false);
  assert.equal(r.error, `${CLOSE_FAILED} Its worktree at /wt/b was already removed.`);
  assert.deepEqual(r.removed, ["/wt/b"]);
  const many = [{ tmuxSession: "m", windows: [win(0, "a", { worktreePath: "/1" }), win(1, "b", { worktreePath: "/2" })] }];
  const g = fakes({ listProjects: async () => many, killSession: async () => { throw new Error("boom"); } });
  assert.equal((await closeSession({ project: "m" }, g.d)).error, `${CLOSE_FAILED} 2 worktrees were already removed.`);
});

test("expect: an index re-used by ANOTHER window is refused and nothing is touched (no removal, no delete, no kill)", async () => {
  const reused = [{ tmuxSession: "c", windows: [win(0, "other", { opencodeSessionId: "ses_other", worktreePath: "/wt/other" })] }];
  const order = [];
  const f = fakes({
    listProjects: async () => reused,
    removeWorktree: async (a) => (order.push(["remove", a]), { removed: true }),
    deleteConversation: async (sid) => order.push(["delete", sid]),
    killWindow: async () => order.push(["kill"]),
  });
  const r = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect: { opencodeSessionId: "ses_mine", worktreePath: "/wt/mine" } }, f.d);
  assert.deepEqual(r, { ok: false, error: SESSION_CHANGED });
  assert.deepEqual(order, []);
  // The window is gone altogether → also refused.
  const gone = fakes({ listProjects: async () => [{ tmuxSession: "c", windows: [] }] });
  assert.deepEqual(await closeSession({ project: "c", windowIndex: 0, expect: { opencodeSessionId: null } }, gone.d), { ok: false, error: SESSION_CHANGED });
  // A matching call behaves as before.
  const same = [{ tmuxSession: "c", windows: [win(0, "mine", { opencodeSessionId: "ses_mine", worktreePath: "/wt/mine" })] }];
  const ok = fakes({ listProjects: async () => same, deleteConversation: async (sid) => order.push(["delete", sid]) });
  const done = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect: { opencodeSessionId: "ses_mine", worktreePath: "/wt/mine" } }, ok.d);
  assert.equal(done.ok, true);
  assert.deepEqual(order, [["delete", "ses_mine"]]);
});

test("expect: a forced removal needs the path that was SHOWN; otherwise it never forces and asks again", async () => {
  const live = [{ tmuxSession: "c", windows: [win(0, "w", { worktreePath: "/wt/q" })] }];
  const attempts = [];
  const f = fakes({ listProjects: async () => live, removeWorktree: async (a) => (attempts.push(a), { removed: false, reason: "dirty" }) });
  // 'remove' for a path that is not the window's current one: the identity check refuses it first.
  const stale = await closeSession({ project: "c", windowIndex: 0, dirtyWorktree: "remove", expect: { worktreePath: "/wt/p" } }, f.d);
  assert.deepEqual(stale, { ok: false, error: SESSION_CHANGED });
  assert.deepEqual(attempts, [], "no git call at all");
  // 'remove' with no expect never forces: a fresh question.
  const bare = await closeSession({ project: "c", windowIndex: 0, dirtyWorktree: "remove" }, f.d);
  assert.equal(bare.needsConfirm?.path, "/wt/q");
  assert.deepEqual(attempts, [{ path: "/wt/q", force: false }]);
});

test("a window moved to a different index between preview and confirm: the expect check protects the conversation", async () => {
  const before = [{ tmuxSession: "c", windows: [win(0, "a", { opencodeSessionId: "ses_a" }), win(1, "b", { opencodeSessionId: "ses_b" })] }];
  const after = [{ tmuxSession: "c", windows: [win(0, "b", { opencodeSessionId: "ses_b" })] }]; // a closed elsewhere; renumbered
  const deleted = [];
  const f = fakes({ listProjects: async () => after, deleteConversation: async (sid) => deleted.push(sid) });
  const r = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect: { opencodeSessionId: "ses_a", worktreePath: null } }, f.d);
  assert.equal(r.error, SESSION_CHANGED);
  assert.deepEqual(deleted, [], "ses_b was never offered for deletion");
  void before;
});

test("worktreeCleanOnClose off: no git calls at all, nothing listed", async () => {
  const f = fakes({ cleanOnClose: async () => false });
  const r = await closeSession({ project: "p" }, f.d);
  assert.deepEqual(f.calls.filter((c) => c[0] === "remove"), []);
  assert.deepEqual([r.removed, r.kept, r.failed], [[], [], []]);
});

test("deleteConversation (iOS delete): the window is killed FIRST, then its conversation is deleted", async () => {
  const chat = [{ tmuxSession: "c", windows: [win(0, "chat", { opencodeSessionId: "ses_1" })] }];
  const order = [];
  const f = fakes({
    listProjects: async () => chat,
    deleteConversation: async (sid) => order.push(`delete:${sid}`),
    killWindow: async () => order.push("kill"),
  });
  const r = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect: { opencodeSessionId: "ses_1" } }, f.d);
  assert.equal(r.ok, true);
  assert.deepEqual(order, ["kill", "delete:ses_1"]);
  const plain = fakes({ listProjects: async () => chat, deleteConversation: async () => order.push("never") });
  await closeSession({ project: "c", windowIndex: 0 }, plain.d);
  assert.ok(!order.includes("never"), "without the flag the conversation is kept (desktop close)");
});

test("a conversation that cannot be deleted AFTER the kill is a warning (ok:true); an already-gone one (404) is silent", async () => {
  const chat = [{ tmuxSession: "c", windows: [win(0, "chat", { opencodeSessionId: "ses_1" })] }];
  const bad = fakes({ listProjects: async () => chat, deleteConversation: async () => { throw new Error("boom"); } });
  const r = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect: { opencodeSessionId: "ses_1" } }, bad.d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [CONVERSATION_WARNING]);
  assert.ok(bad.calls.some((c) => c[0] === "killWindow"), "the window was killed regardless");
  const gone = fakes({ listProjects: async () => chat, deleteConversation: async () => { throw Object.assign(new Error("Not Found"), { status: 404 }); } });
  const r2 = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect: { opencodeSessionId: "ses_1" } }, gone.d);
  assert.deepEqual(r2.warnings, []);
});

test("deleteConversation without the confirmed conversation id is refused before anything is touched", async () => {
  const chat = [{ tmuxSession: "c", windows: [win(0, "chat", { opencodeSessionId: "ses_1" })] }];
  for (const expect of [undefined, {}, { worktreePath: null }, { opencodeSessionId: "" }]) {
    const f = fakes({ listProjects: async () => chat, deleteConversation: async () => { throw new Error("must not delete"); } });
    const r = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true, expect }, f.d);
    assert.deepEqual(r, { ok: false, error: SESSION_CHANGED }, JSON.stringify(expect));
    assert.ok(!f.calls.some((c) => c[0] === "killWindow" || c[0] === "remove"), "nothing killed or removed");
  }
});
