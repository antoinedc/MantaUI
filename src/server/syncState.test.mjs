import { test } from "node:test";
import assert from "node:assert/strict";
import { createSyncState } from "./syncState.mjs";

const P1 = [{ tmuxSession: "alpha", windows: [], attached: false, mantaOwned: true }];
const P2 = [
  ...P1,
  { tmuxSession: "beta", windows: [], attached: false, mantaOwned: false },
];

function makeFixture() {
  const published = [];
  let nextProjects = P1;
  let listCalls = 0;
  let failList = false;
  const state = createSyncState({
    listProjects: async () => {
      listCalls += 1;
      if (failList) throw new Error("tmux fault");
      return nextProjects;
    },
    publish: (e) => published.push(e),
    genId: () => "aabbccdd",
  });
  return { state, published, setProjects: (p) => (nextProjects = p), setFail: (f) => (failList = f), getCalls: () => listCalls };
}

test("seq starts at 1; applying identical projects twice bumps seq once", async () => {
  const { state, published } = makeFixture();
  assert.equal(state.snapshot().seq, 1);
  state.applyConfig({ foo: 1 });
  assert.equal(state.snapshot().seq, 2);
  state.applyConfig({ foo: 1 }); // identical — no bump
  assert.equal(state.snapshot().seq, 2);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].changed, { config: { foo: 1 } });
});

test("applyConfig publishes only on change", () => {
  const { state, published } = makeFixture();
  state.applyConfig({ a: 1 });
  state.applyConfig({ a: 1 });
  state.applyConfig({ a: 2 });
  assert.equal(published.length, 2);
  assert.deepEqual(published.map((p) => p.changed), [{ config: { a: 1 } }, { config: { a: 2 } }]);
});

test("refreshNow success applies projects change + a fresh tick is a no-op", async () => {
  const { state, published, setProjects } = makeFixture();
  await state.refreshNow();
  await state.refreshNow(); // identical — no change
  assert.equal(state.snapshot().projects, P1);
  assert.equal(state.snapshot().stale, false);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].changed, { projects: P1 });

  setProjects(P2);
  await state.refreshNow();
  assert.equal(published.length, 2);
  assert.deepEqual(published[1].changed, { projects: P2 });
});

test("refreshNow failure → stale=true, last-known-good kept, publish changed.stale", async () => {
  const { state, published, setFail } = makeFixture();
  await state.refreshNow(); // success: projects = P1
  const before = state.snapshot().seq;
  setFail(true);
  await state.refreshNow(); // failure
  const snap = state.snapshot();
  assert.equal(snap.stale, true);
  assert.equal(snap.projects, P1); // last-known-good untouched
  assert.ok(snap.seq > before);
  const last = published[published.length - 1];
  assert.deepEqual(last.changed, { stale: true });
});

test("refreshNow success after failure → stale=false published", async () => {
  const { state, published, setFail } = makeFixture();
  setFail(true);
  await state.refreshNow(); // stale=true (no prior good)
  assert.equal(state.snapshot().stale, true);
  setFail(false);
  await state.refreshNow(); // recovery
  assert.equal(state.snapshot().stale, false);
  const last = published[published.length - 1];
  assert.deepEqual(last.changed, { stale: false });
});

test("payloadSince(null) includes all fields", async () => {
  const { state } = makeFixture();
  await state.refreshNow();
  const { gen, seq } = state.snapshot();
  const out = state.payloadSince(null, gen);
  assert.equal(out.gen, gen);
  assert.equal(out.seq, seq);
  assert.ok("projects" in out.changed);
  assert.ok("config" in out.changed);
  assert.ok("stale" in out.changed);
});

test("payloadSince with current seq returns empty changed", async () => {
  const { state } = makeFixture();
  await state.refreshNow();
  const { gen, seq } = state.snapshot();
  const out = state.payloadSince(seq, gen);
  assert.deepEqual(out.changed, {});
});

test("payloadSince with older seq returns only fields changed since", async () => {
  const { state, setProjects } = makeFixture();
  await state.refreshNow(); // projects set at seq N
  const before = state.snapshot().seq;
  setProjects(P2);
  await state.refreshNow(); // projects changed
  const { gen, seq } = state.snapshot();
  const out = state.payloadSince(before, gen);
  assert.equal(out.seq, seq);
  assert.deepEqual(Object.keys(out.changed), ["projects"]);
  assert.deepEqual(out.changed.projects, P2);
});

test("payloadSince with mismatched gen returns all fields", async () => {
  const { state } = makeFixture();
  await state.refreshNow();
  const { seq } = state.snapshot();
  const out = state.payloadSince(seq, "deadbeef"); // different process gen
  assert.ok("projects" in out.changed);
  assert.ok("config" in out.changed);
  assert.ok("stale" in out.changed);
});

test("payloadSince with sinceSeq > seq returns all fields", async () => {
  const { state } = makeFixture();
  await state.refreshNow();
  const { gen, seq } = state.snapshot();
  const out = state.payloadSince(seq + 100, gen);
  assert.ok("projects" in out.changed);
  assert.ok("config" in out.changed);
  assert.ok("stale" in out.changed);
});

test("concurrent refreshNow calls dedupe (listProjects called once)", async () => {
  const { state, getCalls } = makeFixture();
  await Promise.all([state.refreshNow(), state.refreshNow(), state.refreshNow()]);
  assert.equal(getCalls(), 1);
});

test("everSucceeded reflects whether a tick ever succeeded", async () => {
  const { state, setFail } = makeFixture();
  setFail(true);
  await state.refreshNow();
  assert.equal(state.everSucceeded(), false);
  setFail(false);
  await state.refreshNow();
  assert.equal(state.everSucceeded(), true);
});

test("publish envelope shape is pinned {kind, gen, seq, changed}", async () => {
  const { state, published } = makeFixture();
  await state.refreshNow();
  const env = published[0];
  assert.equal(env.kind, "sync");
  assert.equal(env.gen, "aabbccdd");
  assert.equal(typeof env.seq, "number");
  assert.deepEqual(Object.keys(env), ["kind", "gen", "seq", "changed"]);
  assert.ok("projects" in env.changed);
  assert.equal(env.seq, state.snapshot().seq);
});
