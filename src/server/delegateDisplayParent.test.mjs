// Display parent of an adopted (opencode-owned) background row: which windowed session its row nests under
// when the real parent has no window. Every rule in isolation + precedence, the recompute policy, and the
// read-only driver query against a real SQLite store with the V2 schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDisplayParents,
  resolveDisplayParent,
  refreshDisplayParents,
  adoptExistingSession,
  createActiveSessionReconciler,
  DRIVER_WINDOW_MS,
} from "./delegate.mjs";
import { TASKS } from "./dbTasks.mjs";
import { runOnHandle, _setOffloadMode } from "./dbOffload.mjs";

let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}

const T0 = 1_700_000_000_000;
const WS = "cantina";
const CHILD = "ses_child";

// A tiny world: sessions (id → parentID), windows (workspace → session ids), job records, handoff links.
function world({ sessions = {}, windows = { [WS]: [] }, jobs = [], successors = {}, references = null } = {}) {
  const store = jobs.map((j) => structuredClone(j));
  const calls = { refs: [], publish: [], saves: 0 };
  const deps = {
    now: () => T0,
    load: async () => store.map((j) => structuredClone(j)),
    save: async (next) => {
      calls.saves++;
      store.splice(0, store.length, ...next.map((j) => structuredClone(j)));
    },
    publish: (e) => calls.publish.push(e),
    listProjects: async () =>
      Object.entries(windows).map(([tmuxSession, ids]) => ({ tmuxSession, defaultCwd: "/x", windows: ids.map((id, i) => ({ index: i, opencodeSessionId: id, paneCurrentPath: "/x" })) })),
    readSession: async (sid) => (sid in sessions ? { state: "found", session: { id: sid, parentID: sessions[sid] ?? undefined, directory: "/x" } } : { state: "missing" }),
    successorOf: (sid) => successors[sid] ?? null,
    findSessionReferences:
      references === "none"
        ? undefined
        : async (args) => {
            calls.refs.push(args);
            return typeof references === "function" ? references(args) : (references ?? { hits: [], complete: true });
          },
    pathExists: () => false,
    newWindow: async (i) => ({ sessionId: i.existingSessionId, windowIndex: 9 }),
  };
  return { deps, store, calls };
}

const job = (over = {}) => ({
  id: "job00001",
  name: "builder",
  parentSessionID: "ses_old",
  sessionParentID: "ses_old",
  childSessionID: CHILD,
  tmuxSession: WS,
  windowIndex: 3,
  origin: "observed",
  completionOwner: "opencode",
  status: "running",
  createdAt: T0,
  ...over,
});

const hit = (sessionId, t, target = CHILD) => ({ target, sessionId, t });
const refs = (...hits) => ({ hits, complete: true });

// ---- rule 1: windowed ancestor ----------------------------------------------------------

test("rule 1: the nearest windowed ancestor wins over a successor and a driver", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: "ses_mid", ses_mid: "ses_root", ses_root: null },
    windows: { [WS]: ["ses_mid", "ses_root", "ses_succ", "ses_driver"] },
    successors: { ses_old: "ses_succ" },
    references: refs(hit("ses_driver", T0 - 10)),
  });
  const r = await resolveDisplayParent(job(), w.deps);
  assert.deepEqual(r, { displayParentID: "ses_mid", rule: 1 });
  assert.equal(w.calls.refs.length, 0, "no DB query when an earlier rule settled it");
});

// ---- rule 2: replacement successor ---------------------------------------------------------

test("rule 2: follows replacedBy links transitively to the live windowed end; precedence over the driver", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: ["ses_b", "ses_c", "ses_driver"] },
    successors: { ses_old: "ses_a", ses_a: "ses_b", ses_b: "ses_c" }, // a has no window; b (stale) and c (live) do
    references: refs(hit("ses_driver", T0 - 10)),
  });
  assert.deepEqual(await resolveDisplayParent(job(), w.deps), { displayParentID: "ses_c", rule: 2 });
  assert.equal(w.calls.refs.length, 0);
});

test("rule 2: an ancestor's successor counts too, and a successor cycle terminates", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: "ses_gp", ses_gp: null },
    windows: { [WS]: ["ses_live"] },
    successors: { ses_gp: "ses_live" },
  });
  assert.equal((await resolveDisplayParent(job(), w.deps)).displayParentID, "ses_live");
  const loop = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: [] },
    successors: { ses_old: "ses_a", ses_a: "ses_b", ses_b: "ses_old" },
  });
  assert.deepEqual(await resolveDisplayParent(job(), loop.deps), { displayParentID: null, rule: null });
});

test("rule 2: at most 8 hops", async () => {
  const successors = {};
  const ids = ["ses_old", ...Array.from({ length: 10 }, (_, i) => `ses_h${i + 1}`)];
  for (let i = 0; i < ids.length - 1; i++) successors[ids[i]] = ids[i + 1];
  const near = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_h8"] }, successors });
  assert.equal((await resolveDisplayParent(job(), near.deps)).displayParentID, "ses_h8");
  const far = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_h9"] }, successors });
  assert.equal((await resolveDisplayParent(job(), far.deps)).displayParentID, null);
});

// ---- rule 3: driver --------------------------------------------------------------------------

test("rule 3: the windowed session that most recently named the child; asks the DB once, for every windowless record", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null, ses_c2: "ses_old" },
    windows: { [WS]: ["ses_d1", "ses_d2"] },
    references: refs(hit("ses_d1", T0 - 5_000), hit("ses_d2", T0 - 1_000), hit("ses_d1", T0 - 100, "ses_c2")),
  });
  const a = job();
  const b = job({ id: "job00002", childSessionID: "ses_c2" });
  const out = await resolveDisplayParents([a, b], w.deps);
  assert.deepEqual(out.get("job00001"), { displayParentID: "ses_d2", rule: 3 });
  assert.deepEqual(out.get("job00002"), { displayParentID: "ses_d1", rule: 3 });
  assert.equal(w.calls.refs.length, 1);
  assert.deepEqual(new Set(w.calls.refs[0].targets), new Set([CHILD, "ses_c2"]));
  assert.deepEqual(new Set(w.calls.refs[0].sessionIds), new Set(["ses_d1", "ses_d2"]), "candidates are exactly the windowed sessions");
  assert.equal(w.calls.refs[0].sinceMs, T0 - DRIVER_WINDOW_MS, "the 24 h window is passed to the query");
});

test("rule 3: skips the child itself, its own descendants, other workspaces, and a candidate that would close a loop", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null, ses_kid: CHILD, ses_kidkid: "ses_kid", ses_ok: null },
    windows: { [WS]: [CHILD, "ses_kidkid", "ses_loop", "ses_ok"], other: ["ses_far"] },
    jobs: [job(), job({ id: "job00009", childSessionID: "ses_loop", parentSessionID: "ses_x", displayParentID: CHILD })],
    references: refs(hit(CHILD, T0 - 1), hit("ses_kidkid", T0 - 2), hit("ses_far", T0 - 3), hit("ses_loop", T0 - 4), hit("ses_ok", T0 - 5)),
  });
  const r = await resolveDisplayParent(w.store[0], w.deps);
  assert.deepEqual(r, { displayParentID: "ses_ok", rule: 3 });
});

test("rule 3: another live background row is never a driver (a builder naming a sibling's id), even when newest", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null, ses_sib: null, ses_orch: null },
    windows: { [WS]: ["ses_sib", "ses_orch"] },
    jobs: [job(), job({ id: "job00002", childSessionID: "ses_sib", parentSessionID: "ses_old" })],
    references: refs(hit("ses_sib", T0 - 1), hit("ses_orch", T0 - 50)),
  });
  const r = await resolveDisplayParent(w.store[0], w.deps);
  assert.deepEqual(r, { displayParentID: "ses_orch", rule: 3 });
});

test("rule 3: a hit that is the newest only in another workspace never wins", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: ["ses_here"], other: ["ses_there"] },
    references: refs(hit("ses_there", T0 - 1), hit("ses_here", T0 - 9_000)),
  });
  assert.equal((await resolveDisplayParent(job(), w.deps)).displayParentID, "ses_here");
});

test("rule 3 skipped: DB unavailable (null / throws / no reader) leaves the record out, an incomplete scan never claims 'none'", async () => {
  for (const references of [() => null, () => Promise.reject(new Error("busy")), "none"]) {
    const w = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_d"] }, references });
    assert.equal(await resolveDisplayParent(job(), w.deps), null, "unknown — not 'none'");
  }
  const partial = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_d"] }, references: { hits: [], complete: false } });
  assert.equal(await resolveDisplayParent(job(), partial.deps), null);
  const empty = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_d"] }, references: refs() });
  assert.deepEqual(await resolveDisplayParent(job(), empty.deps), { displayParentID: null, rule: null }, "rule 4: none");
});

test("manta-owned records are never resolved", async () => {
  const w = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_d"] }, references: refs(hit("ses_d", T0)) });
  const out = await resolveDisplayParents([job({ completionOwner: "manta", origin: "delegate" })], w.deps);
  assert.equal(out.size, 0);
  assert.equal(w.calls.refs.length, 0);
});

// ---- refresh: when it recomputes, what it writes ------------------------------------------------

test("refresh: patches displayParentID only when the current display parent has no window; parentSessionID is never changed", async () => {
  const stale = job();
  const stable = job({ id: "job00002", childSessionID: "ses_c2", parentSessionID: "ses_winparent" });
  const driven = job({ id: "job00003", childSessionID: "ses_c3", displayParentID: "ses_closed" });
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null, ses_c2: "ses_winparent", ses_c3: "ses_old" },
    windows: { [WS]: ["ses_winparent", "ses_drv"] },
    jobs: [stale, stable, driven],
    references: (a) => refs(...a.targets.map((t) => hit("ses_drv", T0 - 10, t))),
  });
  const patched = await refreshDisplayParents(w.deps);
  assert.deepEqual([...patched.keys()].sort(), ["job00001", "job00003"], "the record whose display parent has a window is left alone");
  const byId = Object.fromEntries(w.store.map((j) => [j.id, j]));
  assert.equal(byId.job00001.displayParentID, "ses_drv");
  assert.equal(byId.job00003.displayParentID, "ses_drv");
  assert.equal(byId.job00002.displayParentID, undefined);
  for (const [id, parent] of [["job00001", "ses_old"], ["job00002", "ses_winparent"], ["job00003", "ses_old"]]) assert.equal(byId[id].parentSessionID, parent);
  assert.equal(w.calls.publish.filter((e) => e.kind === "delegate.updated").length, 2);

  // second pass: nothing is windowless any more → no writes, no flapping
  const saves = w.calls.saves;
  assert.equal((await refreshDisplayParents(w.deps)).size, 0);
  assert.equal(w.calls.saves, saves);
});

test("refresh: a stale driver whose window closed is replaced, or cleared when nothing else qualifies; same value is not rewritten", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: [] },
    jobs: [job({ displayParentID: "ses_closed" })],
    references: refs(),
  });
  await refreshDisplayParents(w.deps);
  assert.equal(w.store[0].displayParentID, null);
  const saves = w.calls.saves;
  await refreshDisplayParents(w.deps);
  assert.equal(w.calls.saves, saves, "none → none is not a change");
});

test("refresh: never touches a manta-owned, terminal or superseded record", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: ["ses_drv"] },
    jobs: [
      job({ id: "m", completionOwner: "manta", origin: "delegate" }),
      job({ id: "t", status: "done" }),
      job({ id: "s", supersededBy: "x" }),
    ],
    references: refs(hit("ses_drv", T0)),
  });
  assert.equal((await refreshDisplayParents(w.deps)).size, 0);
  assert.equal(w.calls.saves, 0);
  assert.equal(w.calls.refs.length, 0);
});

// ---- adoption + the reconciler tick ------------------------------------------------------------------

test("adoption: an adopted row whose parent has no window gets its display parent stored; parentSessionID is the real parent", async () => {
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: ["ses_drv"] },
    references: refs(hit("ses_drv", T0 - 1)),
  });
  const out = await adoptExistingSession(
    { childSessionID: CHILD, owner: { tmuxSession: WS }, displayParentID: "ses_old", sessionParentID: "ses_old", cwd: "/x", name: "builder", origin: "observed", runStartedAt: T0 },
    w.deps,
  );
  assert.equal(out.ok, true);
  assert.equal(out.job.displayParentID, "ses_drv", "the returned record carries it");
  assert.equal(w.store[0].displayParentID, "ses_drv");
  assert.equal(w.store[0].parentSessionID, "ses_old");
});

test("adoption: a row whose parent has a window needs no display parent", async () => {
  const w = world({ sessions: { [CHILD]: "ses_win", ses_win: null }, windows: { [WS]: ["ses_win"] }, references: refs(hit("ses_win", T0)) });
  const out = await adoptExistingSession(
    { childSessionID: CHILD, owner: { tmuxSession: WS }, displayParentID: "ses_win", sessionParentID: "ses_win", cwd: "/x", name: "builder", origin: "subagent", runStartedAt: T0 },
    w.deps,
  );
  assert.equal(out.ok, true);
  assert.equal(w.store[0].displayParentID, undefined);
  assert.equal(w.calls.refs.length, 0);
});

test("reconciler tick: recomputes a windowless display parent, and the DB lookup is throttled per record", async () => {
  let now = T0;
  const w = world({
    sessions: { [CHILD]: "ses_old", ses_old: null },
    windows: { [WS]: ["ses_unrelated"] },
    jobs: [job()],
    references: refs(),
  });
  const deps = { ...w.deps, now: () => now, listActiveIds: async () => [] };
  const rec = createActiveSessionReconciler(deps);
  await rec.reconcile();
  assert.equal(w.calls.refs.length, 1);
  await rec.reconcile();
  assert.equal(w.calls.refs.length, 1, "within the throttle window the transcripts are not re-scanned");
  now += 61_000;
  await rec.reconcile();
  assert.equal(w.calls.refs.length, 2);
});

test("reconciler tick: picks up a driver that appears later", async () => {
  const w = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_drv"] }, jobs: [job()], references: refs() });
  const deps = { ...w.deps, listActiveIds: async () => [], driverLookupMinIntervalMs: 0 };
  const rec = createActiveSessionReconciler(deps);
  await rec.reconcile();
  assert.equal(w.store[0].displayParentID ?? null, null);
  w.deps.findSessionReferences = async () => refs(hit("ses_drv", T0));
  deps.findSessionReferences = w.deps.findSessionReferences;
  await rec.reconcile();
  assert.equal(w.store[0].displayParentID, "ses_drv");
});

// ---- the driver query, against a real SQLite store with the V2 schema -------------------------------------

const SCHEMA = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'g', parent_id TEXT, directory TEXT DEFAULT '/', agent TEXT, title TEXT, time_created INTEGER DEFAULT 0, time_updated INTEGER);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id);
  CREATE INDEX session_message_time_created_idx ON session_message (time_created);
`;
function store() {
  const db = new sqlite.DatabaseSync(":memory:");
  db.exec(SCHEMA);
  let n = 0;
  const add = (sid, type, t, data) => db.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(`msg_${++n}`, sid, type, n, t, t, typeof data === "string" ? data : JSON.stringify(data));
  return { db, add };
}
const toolCall = (input) => ({ content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed", input: { command: input }, content: [{ type: "text", text: "ok" }] } }] });

test("sessionReferences: tool input, tool output, user and synthetic messages all count; the newest hit per (target, session) wins", { skip: !sqlite }, () => {
  const { db, add } = store();
  add("ses_a", "assistant", 100, toolCall("node send.mjs ses_t1 'go'"));
  add("ses_a", "assistant", 300, toolCall("node wait-idle.mjs ses_t1"));
  add("ses_a", "assistant", 200, { content: [{ type: "tool", id: "t", name: "bash", state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "found ses_t2 idle" }] } }] });
  add("ses_b", "user", 250, { text: "please look at ses_t1" });
  add("ses_b", "synthetic", 260, { text: "ses_t2 finished" });
  add("ses_c", "assistant", 270, toolCall("echo nothing relevant"));
  const r = TASKS.sessionReferences(db, { sessionIds: ["ses_a", "ses_b", "ses_c"], targets: ["ses_t1", "ses_t2"], sinceMs: 0, windowMessages: 2 });
  assert.equal(r.complete, true);
  const key = (h) => `${h.target}/${h.sessionId}`;
  const got = Object.fromEntries(r.hits.map((h) => [key(h), h.t]));
  assert.deepEqual(got, { "ses_t1/ses_a": 300, "ses_t2/ses_a": 200, "ses_t1/ses_b": 250, "ses_t2/ses_b": 260 });
  db.close();
});

test("sessionReferences: only messages inside the window (sinceMs) count; chunking and unknown sessions are harmless", { skip: !sqlite }, () => {
  const { db, add } = store();
  const now = 10 * DRIVER_WINDOW_MS;
  add("ses_a", "assistant", now - DRIVER_WINDOW_MS - 1, toolCall("send ses_old_ref"));
  add("ses_a", "assistant", now - DRIVER_WINDOW_MS + 1, toolCall("send ses_new_ref"));
  const r = TASKS.sessionReferences(db, { sessionIds: ["ses_a", "ses_nope"], targets: ["ses_old_ref", "ses_new_ref", "ses_x1", "ses_x2", "ses_x3"], sinceMs: now - DRIVER_WINDOW_MS, chunk: 2 });
  assert.deepEqual(r.hits.map((h) => [h.target, h.sessionId]), [["ses_new_ref", "ses_a"]]);
  assert.equal(TASKS.sessionReferences(db, { sessionIds: ["ses_a"], targets: [], sinceMs: 0 }).hits.length, 0);
  db.close();
});

test("sessionReferences: a spent budget is reported, not hidden", { skip: !sqlite }, () => {
  const { db, add } = store();
  add("ses_a", "assistant", 100, toolCall("send ses_t"));
  const r = TASKS.sessionReferences(db, { sessionIds: ["ses_a"], targets: ["ses_t"], sinceMs: 0, budgetMs: -1 });
  assert.equal(r.complete, false);
  db.close();
});

test("end to end: the real query feeds the resolver (driver wins when no ancestor / successor has a window)", { skip: !sqlite }, async () => {
  const { db, add } = store();
  add("ses_drv", "assistant", T0 - 500, toolCall(`node oc-session/send.mjs ${CHILD} "continue"`));
  add("ses_other", "assistant", T0 - 100, toolCall(`echo ${CHILD}`));
  const w = world({ sessions: { [CHILD]: "ses_old", ses_old: null }, windows: { [WS]: ["ses_drv"], elsewhere: ["ses_other"] } });
  w.deps.findSessionReferences = async (args) => runOnHandle(db, "sessionReferences", args);
  _setOffloadMode("inline");
  assert.deepEqual(await resolveDisplayParent(job(), w.deps), { displayParentID: "ses_drv", rule: 3 });
  db.close();
});
