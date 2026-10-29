import { test } from "node:test";
import assert from "node:assert/strict";
import { previewClose, closeSession, METADATA_WARNING, CLOSE_FAILED } from "./sessionClose.mjs";

const win = (index, name, over = {}) => ({ index, name, ...over });
const projects = [
  { tmuxSession: "p", windows: [win(0, "a"), win(1, "b", { worktreePath: "/wt/b" }), win(2, "c", { worktreePath: "/wt/b" })] },
  { tmuxSession: "empty", windows: [] },
  { tmuxSession: "one", windows: [win(0, "solo")] },
];
const running = (set) => (w, p) => set.has(`${p}:${w.index}`);

test("preview: a single window — copy, running and worktree outcomes", () => {
  assert.deepEqual(previewClose({ project: "p", windowIndex: 0, projects, cleanOnClose: true, isRunning: running(new Set()) }), {
    title: "Close “a”?", body: "Its tmux window will be killed on the server.", confirmLabel: "Close session", runningCount: 0, worktrees: [],
  });
  const r = previewClose({ project: "p", windowIndex: 1, projects, cleanOnClose: true, isRunning: running(new Set(["p:1"])) });
  assert.equal(r.body, "Its tmux window will be killed on the server. A turn is currently running and will be stopped. Its worktree at /wt/b will be removed.");
  assert.deepEqual(r.worktrees, [{ path: "/wt/b", willRemove: true }]);
  const off = previewClose({ project: "p", windowIndex: 1, projects, cleanOnClose: false, isRunning: running(new Set()) });
  assert.doesNotMatch(off.body, /worktree at/);
  assert.deepEqual(off.worktrees, [{ path: "/wt/b", willRemove: false }]);
});

test("preview: a project — 0 / 1 / N sessions, running counts, a shared worktree counted once", () => {
  assert.deepEqual(previewClose({ project: "empty", projects, cleanOnClose: true, isRunning: running(new Set()) }), {
    title: "Close “empty”?", body: "Its tmux session will be killed on the server.", confirmLabel: "Close project", runningCount: 0, worktrees: [],
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
  const forced = await closeSession({ project: "p", windowIndex: 1, dirtyWorktree: "remove" }, f1.d);
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
  assert.deepEqual(r, { ok: false, error: CLOSE_FAILED });
});

test("worktreeCleanOnClose off: no git calls at all, nothing listed", async () => {
  const f = fakes({ cleanOnClose: async () => false });
  const r = await closeSession({ project: "p" }, f.d);
  assert.deepEqual(f.calls.filter((c) => c[0] === "remove"), []);
  assert.deepEqual([r.removed, r.kept, r.failed], [[], [], []]);
});

test("deleteConversation (iOS delete) removes the window's opencode conversation before the kill; a failure is the close sentence", async () => {
  const chat = [{ tmuxSession: "c", windows: [win(0, "chat", { opencodeSessionId: "ses_1" })] }];
  const order = [];
  const f = fakes({
    listProjects: async () => chat,
    deleteConversation: async (sid) => order.push(`delete:${sid}`),
    killWindow: async () => order.push("kill"),
  });
  const r = await closeSession({ project: "c", windowIndex: 0, deleteConversation: true }, f.d);
  assert.equal(r.ok, true);
  assert.deepEqual(order, ["delete:ses_1", "kill"]);
  const plain = fakes({ listProjects: async () => chat, deleteConversation: async () => order.push("never") });
  await closeSession({ project: "c", windowIndex: 0 }, plain.d);
  assert.ok(!order.includes("never"), "without the flag the conversation is kept (desktop close)");
  const bad = fakes({ listProjects: async () => chat, deleteConversation: async () => { throw new Error("boom"); } });
  assert.deepEqual(await closeSession({ project: "c", windowIndex: 0, deleteConversation: true }, bad.d), { ok: false, error: CLOSE_FAILED });
});
