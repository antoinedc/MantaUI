import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionMap, normalizeSessionEvent, sessionExclusion } from "./sessionMap.mjs";
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
  await m.observe({ type: "session.created", data: { sessionID: "ses_c", parentID: "ses_p" } });
  assert.equal(m.get("ses_c").slug, A.slug);
  assert.equal(m.get("ses_c").source, "parent");
  await m.observe({ type: "session.created", data: { sessionID: "ses_orphan", parentID: "ses_unmapped" } });
  assert.equal(m.get("ses_orphan"), null);
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
