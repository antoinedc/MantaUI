import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionLinks, createSessionLinkActions } from "./sessionLinks.mjs";
import { createSessionStatus } from "./sessionStatus.mjs";

test("link store: atomic concurrent writes persist, newest wins, unlink suppresses, prune removes either missing endpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-links-"));
  try {
    const path = join(dir, "links.json");
    let changed = 0;
    const store = createSessionLinks({ path, changed: () => changed++ });
    await Promise.all([store.link({ child: "a", parent: "p", by: "p" }), store.link({ child: "b", parent: "q", by: "q" }), store.link({ child: "a", parent: "r", by: "r" })]);
    assert.equal(store.linkOf("a").parent, "r");
    assert.equal(JSON.parse(await readFile(path)).b.parent, "q");
    await store.unlink({ child: "a", by: "r" });
    assert.equal(store.linkOf("a").parent, null);
    assert.equal(createSessionLinks({ path }).linkOf("a").parent, null, "suppression survives restart");
    await store.prune(async (sid) => sid !== "q");
    assert.equal(store.linkOf("b"), undefined, "missing parent");
    await store.prune(async (sid) => sid !== "a");
    assert.deepEqual(store.endpoints(), []);
    assert.equal(changed, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("link store: the whole read-modify-write is serial and a failed save publishes nothing", async () => {
  let saves = 0, inFlight = 0, published = 0;
  const store = createSessionLinks({ load: () => ({}), save: async () => {
    assert.equal(inFlight++, 0);
    await new Promise((r) => setImmediate(r));
    inFlight--;
    if (++saves === 2) throw new Error("disk full");
  }, changed: () => published++ });
  const out = await Promise.allSettled([store.link({ child: "a", parent: "p", by: "p" }), store.link({ child: "b", parent: "p", by: "p" }), store.unlink({ child: "a", by: "p" })]);
  assert.deepEqual(out.map((x) => x.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(published, 2);
  assert.equal(store.linkOf("b"), undefined);
  assert.equal(store.linkOf("a").parent, null);
});

function graphWorld({ chains = {}, successors = {} } = {}) {
  const sessions = { a: {}, b: {}, c: {}, pred: {}, succ: {}, native: { parentID: "a" }, job: {} };
  let changed = 0;
  const projects = [{ tmuxSession: "p", defaultCwd: "/repo", windows: [{ index: 0, opencodeSessionId: "a", paneCurrentPath: "/repo", owner: "user" }] }];
  const readSession = async (sid) => sessions[sid] ? { state: "found", session: { directory: "/repo", ...sessions[sid] } } : { state: "missing" };
  let status;
  const store = createSessionLinks({ load: () => ({}), save: async () => {}, changed: () => { changed++; status.linksChanged(); } });
  status = createSessionStatus({ publish: () => {}, windowedSessionIds: () => ["a"], loadJobs: async () => [{ id: "j", childSessionID: "job", parentSessionID: "a", completionOwner: "manta", status: "running" }], listActiveSessionIds: async () => ["b", "c", "native", "job"], readSession, getSessionParent: async () => ({ status: "ok", parentID: null }), linkOf: store.linkOf, linkEndpoints: store.endpoints, chainOf: (sid) => chains[sid] ?? [sid], successorOf: (sid) => successors[sid] ?? null, schedule: () => {}, setTimer: () => {}, onJobsChanged: () => status.annotateProjects(projects) });
  const action = createSessionLinkActions({ store, readSession, sessionStatus: status });
  return { store, status, action, projects, sessions, changed: () => changed };
}

test("link actions: read unknowns, refuse self/native/job parents and cycles; writes invalidate the actual tree", async () => {
  const w = graphWorld();
  await w.status.hydrate();
  w.status.annotateProjects(w.projects);
  for (const [target, pattern] of [["absent", /Unknown/], ["a", /itself/], ["native", /authoritative/], ["job", /authoritative/]]) {
    assert.match((await w.action({ action: "link", sessionID: "a", target })).error, pattern);
  }
  assert.deepEqual(await w.action({ action: "link", sessionID: "a", target: "b" }), { ok: true });
  assert.match((await w.action({ action: "link", sessionID: "b", target: "a" })).error, /cycle/);
  assert.equal(w.changed(), 1);
  assert.deepEqual(await w.action({ action: "unlink", sessionID: "a", target: "b" }), { ok: true });
  assert.deepEqual(w.status.ancestorsOf("b"), []);
  assert.deepEqual(await w.action({ action: "link", sessionID: "c", target: "b" }), { ok: true });
  assert.deepEqual(w.status.ancestorsOf("b"), ["c"]);
});

test("opposite concurrent link actions cannot introduce a cycle", async () => {
  const w = graphWorld();
  await w.status.hydrate();
  const out = await Promise.all([w.action({ action: "link", sessionID: "b", target: "c" }), w.action({ action: "link", sessionID: "c", target: "b" })]);
  assert.deepEqual(out.map((r) => r.ok), [true, false]);
});

test("links canonicalise both endpoints; a later unlink on a successor suppresses its predecessor's older edge", async () => {
  const w = graphWorld({ chains: { pred: ["pred", "succ"], succ: ["pred", "succ"] }, successors: { pred: "succ" } });
  await w.status.hydrate();
  await w.store.link({ child: "pred", parent: "a", by: "a" });
  assert.deepEqual(w.status.ancestorsOf("succ"), ["a"]);
  await w.action({ action: "unlink", sessionID: "b", target: "pred" });
  assert.equal(w.store.linkOf("succ").parent, null);
  assert.deepEqual(w.status.ancestorsOf("pred"), []);
  await w.action({ action: "link", sessionID: "pred", target: "c" });
  assert.equal(w.store.linkOf("c").parent, "succ");
  await w.action({ action: "link", sessionID: "b", target: "pred" });
  assert.equal(w.store.linkOf("succ").parent, "b");
  assert.deepEqual(w.status.ancestorsOf("pred"), ["b"]);
});

test("cold link validation reads ancestry reached through a persisted explicit edge, not just the caller's natural parents", async () => {
  const w = graphWorld();
  w.sessions.b.parentID = "c";
  await w.store.link({ child: "a", parent: "b", by: "b" });
  assert.equal(w.status._state.hydratedOnce, false);
  const out = await w.action({ action: "link", sessionID: "a", target: "c" });
  assert.equal(out.ok, false);
  assert.match(out.error, /cycle/);
  assert.equal(w.store.linkOf("c"), undefined);
});
