import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyChildId, createSessionMap, normalizeSessionEvent, sessionExclusion } from "./sessionMap.mjs";
import { memState } from "./testHelpers.mjs";

// A registry fake: directory → project by a lookup table.
function fakes({ sessions = {}, dirs = {}, cto = new Set(), pages = [] } = {}) {
  const identified = [];
  const registry = {
    async identify(dir) {
      identified.push(dir);
      const d = dirs[dir];
      return d ? { slug: d.slug, canonicalId: d.id, displayName: d.slug } : null;
    },
    async get(slug) {
      const d = Object.values(dirs).find((x) => x.slug === slug);
      return d ? { slug, canonicalId: d.id } : null;
    },
  };
  let t = 1_000_000;
  const map = (state) =>
    createSessionMap({
      state,
      registry,
      getSession: async (id) => sessions[id] ?? null,
      isCtoSession: async (id) => cto.has(id),
      listSessionsPage: async ({ afterId, limit }) => pages.filter((p) => p.id > afterId).slice(0, limit),
      now: () => t,
      log: () => {},
    });
  const advance = () => (t += 120_000); // past the re-pin throttle
  return { registry, identified, map, advance };
}

// opencode-minted (task child) and Manta-minted (background job) session ids
const TASK_ID = "ses_a1b2c3d4e5f6AbCdEfGhIjKlMn";
const JOB_ID = `ses_${"0123456789abcdef".repeat(2)}`;

const A = { slug: "alpha-0000000001", id: "github.com/o/alpha" };
const B = { slug: "beta-0000000002", id: "github.com/o/beta" };

test("a session with no mapping is unmapped (fail closed)", async () => {
  const state = await memState();
  const { map } = fakes();
  assert.equal(map(state).get("ses_x"), null);
});

test("pinned at the first prompt from the directory at that moment", async () => {
  const state = await memState();
  const f = fakes({ sessions: { ses_1: { directory: "/repo/a" } }, dirs: { "/repo/a": A } });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  const got = m.get("ses_1");
  assert.equal(got.slug, A.slug);
  assert.equal(got.directory, "/repo/a");
  assert.equal(got.source, "prompt");
});

test("lifecycle events work too (session.status busy)", async () => {
  const state = await memState();
  const f = fakes({ sessions: { ses_1: { directory: "/repo/a" } }, dirs: { "/repo/a": A } });
  const m = f.map(state);
  await m.observeEvent({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
  assert.equal(m.get("ses_1").slug, A.slug);
  await m.observeEvent({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "idle" } } });
  assert.equal(m.get("ses_2"), null);
});

test("a move before anything is captured re-pins; after a capture it is never recomputed", async () => {
  const state = await memState();
  const sessions = { ses_1: { directory: "/parent" } };
  const f = fakes({ sessions, dirs: { "/parent": B, "/worktree/a": A } });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  assert.equal(m.get("ses_1").slug, B.slug);
  sessions.ses_1 = { directory: "/worktree/a" }; // the job was moved into its worktree
  f.advance();
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  assert.equal(m.get("ses_1").slug, A.slug);
  assert.equal(m.get("ses_1").source, "move");
  m.markCaptured("ses_1");
  sessions.ses_1 = { directory: "/parent" };
  f.advance();
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  assert.equal(m.get("ses_1").slug, A.slug);
});

test("a task subagent child inherits its parent's mapping on session.created{parentID}", async () => {
  const state = await memState();
  const f = fakes({ sessions: { ses_p: { directory: "/repo/a" } }, dirs: { "/repo/a": A } });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  await m.observe({ type: "session.created", data: { sessionID: TASK_ID, parentID: "ses_p" } });
  assert.equal(m.get(TASK_ID).slug, A.slug);
  assert.equal(m.get(TASK_ID).source, "parent");
  await m.observe({ type: "session.created", data: { sessionID: "ses_f26f6b37affeORgXJ6eZKkLUjL", parentID: "ses_unmapped" } });
  assert.equal(m.get("ses_f26f6b37affeORgXJ6eZKkLUjL"), null);
});

test("sessions Manta created for itself are never mapped (internal, CTO conversation, routine, curator)", async () => {
  const state = await memState();
  const f = fakes({
    sessions: {
      i: { directory: "/repo/a", metadata: { manta: { internal: true } } },
      t: { directory: "/repo/a", agent: "title" },
      r: { directory: "/repo/a", metadata: { manta: { routineId: "abcd1234" } } },
      k: { directory: "/repo/a", metadata: { manta: { knowledgeTrial: "x" } } },
      c: { directory: "/repo/a" },
      ok: { directory: "/repo/a" },
    },
    dirs: { "/repo/a": A },
    cto: new Set(["c"]),
  });
  const m = f.map(state);
  for (const id of ["i", "t", "r", "k", "c", "ok"]) await m.observe({ type: "session.execution.started", data: { sessionID: id } });
  for (const id of ["i", "t", "r", "k", "c"]) assert.equal(m.get(id), null, id);
  assert.equal(m.get("ok").slug, A.slug);
});

test("sessionExclusion reasons; normalizeSessionEvent shapes", () => {
  assert.equal(sessionExclusion({ metadata: { manta: { internal: true } } }), "internal");
  assert.equal(sessionExclusion({}, { isCto: true }), "cto-conversation");
  assert.equal(sessionExclusion({ metadata: { manta: { routineId: "x" } } }), "routine");
  assert.equal(sessionExclusion({ metadata: { manta: { knowledgeCurator: true } } }), "curator");
  assert.equal(sessionExclusion({ directory: "/x" }), null);
  assert.deepEqual(normalizeSessionEvent({ type: "session.created", data: { sessionID: "s", parentID: "p" } }), { type: "session.created", sessionID: "s", parentID: "p", directory: null });
  assert.equal(normalizeSessionEvent({ type: "x" }), null);
});

test("an unresolvable directory leaves the session unmapped (and does not throw)", async () => {
  const state = await memState();
  const f = fakes({ sessions: { s: { directory: "/gone" } }, dirs: {} });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "s" } });
  assert.equal(m.get("s"), null);
});

test("directoriesFor / sessionsFor / counts follow the map", async () => {
  const state = await memState();
  const f = fakes({ sessions: { s1: { directory: "/repo/a" }, s2: { directory: "/repo/a2" }, s3: { directory: "/repo/b" } }, dirs: { "/repo/a": A, "/repo/a2": A, "/repo/b": B } });
  const m = f.map(state);
  for (const id of ["s1", "s2", "s3"]) await m.pin({ sessionID: id });
  assert.deepEqual(m.directoriesFor([A.slug]).sort(), ["/repo/a", "/repo/a2"]);
  assert.deepEqual(m.sessionsFor(B.slug), ["s3"]);
  assert.deepEqual(m.counts(), { [A.slug]: 2, [B.slug]: 1 });
});

test("backfill: directory first, then opencode project_id joined to a resolved sibling; resumable; the rest stay unmapped", async () => {
  const state = await memState();
  const pages = [
    { id: "s01", directory: "/repo/a", projectId: "P1", parentId: null, agent: "build" },
    { id: "s02", directory: "/gone/worktree", projectId: "P1", parentId: null, agent: "build" }, // dir gone → via P1
    { id: "s03", directory: "/gone/else", projectId: "P9", parentId: null, agent: "build" }, // P9 has no resolved sibling
    { id: "s04", directory: "/repo/b", projectId: "P2", parentId: null, agent: "build" },
    { id: "s05", directory: "/repo/a", projectId: "P1", parentId: null, agent: "title" }, // housekeeping → skipped
    { id: "s06", directory: null, projectId: null, parentId: null, agent: "build" },
  ];
  const f = fakes({ dirs: { "/repo/a": A, "/repo/b": B }, pages });
  const m = f.map(state);
  const r1 = await m.backfillStep({ pageSize: 2, budgetMs: 0 }); // budget 0 → no work, nothing marked done
  assert.equal(r1.done, false);
  let guard = 0;
  while (!m.backfillDone() && guard++ < 20) await m.backfillStep({ pageSize: 2, budgetMs: 50 });
  assert.equal(m.get("s01").slug, A.slug);
  assert.equal(m.get("s01").source, "backfill");
  assert.equal(m.get("s02").slug, A.slug);
  assert.equal(m.get("s02").source, "backfill-project");
  assert.equal(m.get("s03"), null);
  assert.equal(m.get("s04").slug, B.slug);
  assert.equal(m.get("s05"), null);
  assert.equal(m.get("s06"), null);
  assert.equal(m.backfillDone(), true);
});

test("backfill resumes from its persisted cursor after a restart", async () => {
  const state = await memState();
  const pages = Array.from({ length: 6 }, (_, i) => ({ id: `s${i + 1}`, directory: "/repo/a", projectId: "P1", parentId: null, agent: "build" }));
  const f = fakes({ dirs: { "/repo/a": A }, pages });
  const m1 = f.map(state);
  await m1.backfillStep({ pageSize: 2, budgetMs: 1000, maxPages: 1 }); // one page, then the process "dies"
  const mid = state.kvGet("backfill.cursor");
  assert.ok(mid && mid < "s6");
  const m2 = f.map(state); // a "restarted" process over the same state
  let guard = 0;
  while (!m2.backfillDone() && guard++ < 20) await m2.backfillStep({ pageSize: 2, budgetMs: 50 });
  for (const p of pages) assert.equal(m2.get(p.id).slug, A.slug);
});

test("backfill never overwrites a live mapping", async () => {
  const state = await memState();
  const pages = [{ id: "s1", directory: "/repo/b", projectId: "P2", parentId: null, agent: "build" }];
  const f = fakes({ sessions: { s1: { directory: "/repo/a" } }, dirs: { "/repo/a": A, "/repo/b": B }, pages });
  const m = f.map(state);
  await m.pin({ sessionID: "s1" });
  while (!m.backfillDone()) await m.backfillStep({ budgetMs: 50 });
  assert.equal(m.get("s1").slug, A.slug);
});

test("only opencode `task` children inherit; Manta-minted job sessions and unclassifiable ids never do", async () => {
  const state = await memState();
  const f = fakes({ sessions: { ses_p: { directory: "/repo/a" } }, dirs: { "/repo/a": A } });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  for (const id of [JOB_ID, "ses_short", "weird"]) {
    await m.observe({ type: "session.created", data: { sessionID: id, parentID: "ses_p" } });
    assert.equal(m.get(id), null, id);
  }
  assert.deepEqual([JOB_ID, TASK_ID, "x"].map(classifyChildId), ["managed", "task", "unknown"]);
  // an injected delegate lookup can veto an opencode-looking id
  const m2 = createSessionMap({ state: await memState(), registry: f.registry, getSession: async () => ({ directory: "/repo/a" }), isManagedSession: async (id) => id === TASK_ID, now: () => 1, log: () => {} });
  await m2.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  await m2.observe({ type: "session.created", data: { sessionID: TASK_ID, parentID: "ses_p" } });
  assert.equal(m2.get(TASK_ID), null);
});

test("with the isManagedSession hook, Manta's job records decide (the id format is only the fallback)", async () => {
  const f = fakes({ sessions: { ses_p: { directory: "/repo/a" } }, dirs: { "/repo/a": A } });
  const mk = async (isManagedSession) => {
    const m = createSessionMap({ state: await memState(), registry: f.registry, getSession: async () => ({ directory: "/repo/a" }), isManagedSession, now: () => 1, log: () => {} });
    await m.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
    return m;
  };
  const child = async (m, id) => {
    await m.observe({ type: "session.created", data: { sessionID: id, parentID: "ses_p" } });
    return m.get(id);
  };
  const jobs = await mk(async (id) => id === "ses_a1b2c3d4e5f6AbCdEfGhIjKlM1");
  assert.equal(await child(jobs, "ses_a1b2c3d4e5f6AbCdEfGhIjKlM1"), null); // an opencode-looking id that IS a Manta job: not inherited
  assert.equal((await child(jobs, TASK_ID)).slug, A.slug); // not a job: a task child inherits
  assert.equal((await child(jobs, JOB_ID)).slug, A.slug); // the hook is the authority, not the id format
  const failing = await mk(async () => {
    throw new Error("store unreadable");
  });
  assert.equal(await child(failing, TASK_ID), null); // can't tell → fail closed
});

test("job lifecycle race: create → move execution with the OLD dir → dir change → first prompt <1 s → the worktree's project", async () => {
  const state = await memState();
  const sessions = { ses_p: { directory: "/cto" }, [JOB_ID]: { directory: "/cto" } };
  const f = fakes({ sessions, dirs: { "/cto": B, "/worktree/a": A } });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  assert.equal(m.get("ses_p").slug, B.slug);
  await m.observe({ type: "session.created", data: { sessionID: JOB_ID, parentID: "ses_p" } });
  assert.equal(m.get(JOB_ID), null); // not inherited
  // the move's own execution reports the OLD directory
  await m.observe({ type: "session.execution.started", data: { sessionID: JOB_ID, location: { directory: "/cto" } } });
  assert.equal(m.get(JOB_ID).slug, B.slug);
  // < 1 s later (inside the 60 s throttle) the chokepoint pins with the worktree and force
  const got = await m.pin({ sessionID: JOB_ID, directory: "/worktree/a", force: true });
  assert.equal(got.slug, A.slug);
  assert.equal(got.source, "first-prompt");
  // a late event still carrying the old dir cannot undo it
  await m.pin({ sessionID: JOB_ID, directory: "/cto", source: "prompt" });
  assert.equal(m.get(JOB_ID).slug, A.slug);
  // …but a forced pin with another directory still can, while nothing is captured
  assert.equal((await m.pin({ sessionID: JOB_ID, directory: "/cto", force: true })).slug, B.slug);
  m.markCaptured(JOB_ID);
  assert.equal((await m.pin({ sessionID: JOB_ID, directory: "/worktree/a", force: true })).slug, B.slug);
});

test("a forced pin overrides a parent-inherited mapping; the throttle does not block a changed directory", async () => {
  const state = await memState();
  const f = fakes({ sessions: { ses_p: { directory: "/repo/b" }, [TASK_ID]: { directory: "/repo/b" } }, dirs: { "/repo/b": B, "/repo/a": A } });
  const m = f.map(state);
  await m.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  await m.observe({ type: "session.created", data: { sessionID: TASK_ID, parentID: "ses_p" } });
  assert.equal(m.get(TASK_ID).source, "parent");
  assert.equal((await m.pin({ sessionID: TASK_ID, directory: "/repo/a", force: true })).slug, A.slug);
  // same directory forced: confirms an inherited mapping without re-identifying
  const g = fakes({ sessions: { ses_p: { directory: "/repo/b" } }, dirs: { "/repo/b": B } });
  const m3 = g.map(await memState());
  await m3.observe({ type: "session.execution.started", data: { sessionID: "ses_p" } });
  await m3.observe({ type: "session.created", data: { sessionID: TASK_ID, parentID: "ses_p" } });
  await m3.pin({ sessionID: TASK_ID, directory: "/repo/b", force: true });
  assert.equal(m3.get(TASK_ID).source, "first-prompt");
  // throttle: an unforced pin with the same dir is skipped, with a new dir it runs
  const h = fakes({ sessions: { s1: { directory: "/repo/b" } }, dirs: { "/repo/b": B, "/repo/a": A } });
  const m4 = h.map(await memState());
  await m4.pin({ sessionID: "s1" });
  assert.equal((await m4.pin({ sessionID: "s1", directory: "/repo/a" })).slug, A.slug);
});

test("backfill: skips sessions created at/after the first-start boundary, internal ids, and metadata/title exclusions", async () => {
  const state = await memState();
  const pages = [
    { id: "s01", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 100, metadata: null },
    { id: "s02", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 100, metadata: { manta: { internal: true } } },
    { id: "s03", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 100, metadata: { manta: { routineId: "r" } } },
    { id: "s04", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 100, metadata: { manta: { knowledgeTrial: "t" } } },
    { id: "s05", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 100, title: "knowledge:curator-notes" },
    { id: "s06", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 100, internal: true },
    { id: "s07", directory: "/repo/a", projectId: "P1", agent: "build", createdAt: 2_000_000 }, // after the boundary
  ];
  const f = fakes({ dirs: { "/repo/a": A }, pages });
  const seen = [];
  const m = createSessionMap({ state, registry: f.registry, getSession: async () => null, isCtoSession: async () => false, listSessionsPage: async (a) => (seen.push(a.createdBefore), pages.filter((p) => p.id > a.afterId).slice(0, a.limit)), now: () => 1_000_000, log: () => {} });
  while (!m.backfillDone()) await m.backfillStep({ budgetMs: 50 });
  assert.equal(m.get("s01").slug, A.slug);
  for (const id of ["s02", "s03", "s04", "s05", "s06", "s07"]) assert.equal(m.get(id), null, id);
  assert.equal(state.kvGet("backfill.boundary"), "1000000");
  assert.ok(seen.every((b) => b === 1_000_000));
});
