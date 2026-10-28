// Tests for messageSearch.mjs pure logic — no database, no live opencode,
// no node:sqlite. Run via `npm run test:server` (node:test).
//
// searchMessages itself touches node:sqlite + the filesystem and is NOT
// covered here (as the issue specifies: "pure only"). Everything testable
// is in likePattern + buildHits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { likePattern, buildHits } from "./messageSearch.mjs";

// ---------------------------------------------------------------------------
// likePattern
// ---------------------------------------------------------------------------

test("likePattern escapes \\, % and _ and wraps in %…%", () => {
  assert.equal(likePattern("foo"), "%foo%");
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("a\\b"), "%a\\\\b%");
  assert.equal(likePattern("x%y_z\\q"), "%x\\%y\\_z\\\\q%");
});

test("likePattern escapes all special chars and keeps matches literal", () => {
  // A query containing % must not act as a SQLite wildcard after escaping.
  const pattern = likePattern("50%");
  assert.ok(pattern.includes("\\%"));
  assert.ok(!pattern.slice(1, -1).replace(/\\[%_]/, "").includes("%"));
});

// ---------------------------------------------------------------------------
// buildHits — row shape
// ---------------------------------------------------------------------------

function part(d, override = {}) {
  return JSON.stringify({ type: "text", text: d, ...override });
}
function msg(role = "user") {
  return JSON.stringify({ role });
}
// row is what buildHits receives: session_id, message_id, part_data (JSON
// string), msg_data (JSON string), time_created.
function row(sid, mid, partData, msgData, timeCreated) {
  return {
    session_id: sid,
    message_id: mid,
    part_data: partData,
    msg_data: msgData,
    time_created: timeCreated,
  };
}

const OPS = { sessionIds: ["a", "b"] };

// ---------------------------------------------------------------------------
// text-part filtering
// ---------------------------------------------------------------------------

test("buildHits skips non-text parts", () => {
  const rows = [
    row("a", "m1", JSON.stringify({ type: "tool", text: "hello world" }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips synthetic parts", () => {
  const rows = [
    row("a", "m1", part("hello world", { synthetic: true }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips ignored parts", () => {
  const rows = [
    row("a", "m1", part("hello world", { ignored: true }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips parts with non-string text", () => {
  const rows = [
    row("a", "m1", JSON.stringify({ type: "text", text: 42 }), msg(), 1),
  ];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips rows whose part_data is unparseable JSON", () => {
  const rows = [row("a", "m1", "{not json", msg(), 1)];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips rows whose msg_data is unparseable JSON without throwing", () => {
  const rows = [row("a", "m1", part("hello world"), "{bad", 1)];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

test("buildHits skips rows with empty query", () => {
  assert.deepEqual(buildHits([row("a", "m1", part("hello"), msg(), 1)], "", OPS), []);
});

// ---------------------------------------------------------------------------
// one-hit-per-message + case-insensitive matching
// ---------------------------------------------------------------------------

test("buildHits produces one hit per message, first match wins", () => {
  const rows = [
    row("a", "m1", part("first hello one"), msg(), 3),
    row("a", "m1", part("helloooo second"), msg(), 2),
    row("a", "m2", part("single hello"), msg(), 1),
  ];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ["m1", "m2"],
  );
});

test("buildHits matches case-insensitively but reports original casing", () => {
  const rows = [row("a", "m1", part("Say HELLO there"), msg(), 1)];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "HELLO");
});

test("buildHits skips rows without a case-insensitive match", () => {
  const rows = [row("a", "m1", part("nothing here"), msg(), 1)];
  assert.deepEqual(buildHits(rows, "hello", OPS), []);
});

// ---------------------------------------------------------------------------
// role normalization
// ---------------------------------------------------------------------------

test("buildHits normalizes role: user stays user, everything else is assistant", () => {
  const rows = [
    row("a", "m1", part("hello user"), msg("user"), 2),
    row("a", "m2", part("hello asst"), msg("assistant"), 1),
  ];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.find((h) => h.messageId === "m1").role, "user");
  assert.equal(hits.find((h) => h.messageId === "m2").role, "assistant");
});

// ---------------------------------------------------------------------------
// snippets
// ---------------------------------------------------------------------------

test("snippet pre is prefixed with … and truncated to 60 chars when the match sits deep", () => {
  const before = "x".repeat(120);
  const rows = [row("a", "m1", part(before + "hello"), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.ok(h.pre.startsWith("…"));
  assert.equal(h.pre.length, 1 + 60); // … + 60 chars before the match
  assert.equal(h.match, "hello");
  assert.equal(h.post, "");
});

test("snippet pre has no … when the match is within the first 60 chars", () => {
  const before = "y".repeat(20);
  const rows = [row("a", "m1", part(before + "hello"), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.ok(!h.pre.startsWith("…"));
  assert.equal(h.pre, before);
});

test("snippet post is truncated to 200 chars", () => {
  const after = "z".repeat(300);
  const rows = [row("a", "m1", part("hello" + after), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.equal(h.post.length, 200);
});

test("snippet pre/match/post collapse whitespace runs to a single space", () => {
  const rows = [row("a", "m1", part("a   b\n\n xhello\t world"), msg(), 1)];
  const [h] = buildHits(rows, "hello", OPS);
  assert.equal(h.pre, "a b x");
  assert.equal(h.match, "hello");
  assert.equal(h.post, " world");
});

// ---------------------------------------------------------------------------
// caps
// ---------------------------------------------------------------------------

test("maxPrimary caps the primary session independently of maxPerSession", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(row("a", `u${i}`, part(`hello slot${i}`), msg(), i));
  }
  const hits = buildHits(rows, "hello", {
    sessionIds: ["a", "b"],
    primarySessionId: "a",
    maxPrimary: 2,
    maxPerSession: 3,
  });
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => h.sessionId === "a"));
});

test("maxPerSession caps every non-primary session", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(row("b", `v${i}`, part(`hello slot${i}`), msg(), i));
  }
  const hits = buildHits(rows, "hello", {
    sessionIds: ["a", "b"],
    primarySessionId: "a",
    maxPerSession: 3,
  });
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.sessionId === "b"));
});

test("maxTotal caps hits overall", () => {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    rows.push(row("a", `u${i}`, part(`hello slot${i}`), msg(), i));
  }
  const hits = buildHits(rows, "hello", {
    sessionIds: ["a"],
    primarySessionId: "a",
    maxPrimary: 100,
    maxTotal: 4,
  });
  assert.equal(hits.length, 4);
});

// ---------------------------------------------------------------------------
// session ordering + time-descending within a session
// ---------------------------------------------------------------------------

test("buildHits orders by session index, then time_created descending within a session", () => {
  // Input order is time-descending globally, interleaved across sessions:
  // row a(5), row b(50), row b(40), row a(4), row b(30)
  const rows = [
    row("a", "a5", part("hello five"), msg(), 5),
    row("b", "b5", part("hello fifty"), msg(), 50),
    row("b", "b4", part("hello fourty"), msg(), 40),
    row("a", "a4", part("hello four"), msg(), 4),
    row("b", "b3", part("hello thirty"), msg(), 30),
  ];
  const hits = buildHits(rows, "hello", { sessionIds: ["b", "a"], primarySessionId: "b" });
  // sessionIds = ["b","a"] → all b hits first, then a; within each, newest first.
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ["b5", "b4", "b3", "a5", "a4"],
  );
});

test("buildHits primary (sessionIds[0]) sorts first", () => {
  const rows = [
    row("b", "b1", part("hello bee"), msg(), 2),
    row("a", "a1", part("hello ay"), msg(), 2),
    row("a", "a2", part("hello ay2"), msg(), 1),
  ];
  const hits = buildHits(rows, "hello", { sessionIds: ["a", "b"], primarySessionId: "a" });
  assert.deepEqual(
    hits.map((h) => h.sessionId),
    ["a", "a", "b"],
  );
});

test("timeCreated is carried through (null-safe)", () => {
  const rows = [
    row("a", "m1", part("hello world"), msg(), 1234),
    row("a", "m2", part("hello again"), msg(), null),
  ];
  const hits = buildHits(rows, "hello", OPS);
  assert.equal(hits.find((h) => h.messageId === "m1").timeCreated, 1234);
  assert.equal(hits.find((h) => h.messageId === "m2").timeCreated, null);
});

import { searchMessages } from "./messageSearch.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "./fixtures/opencodeV2DbFixture.mjs";

test("searchMessages: a spent time budget returns what it has with truncated:true; a normal one is not truncated", async (t) => {
  if (!(await sqliteAvailable())) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb({
    sessions: [{ id: "s1", directory: "/a", timeUpdated: 100 }],
    messages: [{ id: "m1", sessionId: "s1", timeCreated: 50, data: { role: "user" } }],
    parts: [{ id: "p1", messageId: "m1", sessionId: "s1", timeCreated: 50, data: { type: "text", text: "needle in a haystack" } }],
  });
  try {
    await withFixtureDb(fixture, async () => {
      const ok = await searchMessages({ query: "needle", sessionIds: ["s1"] });
      assert.equal(ok.hits.length, 1);
      assert.equal(ok.truncated, undefined);
      const starved = await searchMessages({ query: "needle", sessionIds: ["s1"], budgetMs: -1 });
      assert.equal(starved.supported, true);
      assert.equal(starved.truncated, true);
    });
  } finally {
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// Server-first (D23/D24, WS06): scope, groups, degraded — pure
// ---------------------------------------------------------------------------

import {
  resolveSearchScope,
  groupHits,
  projectsFromSyncState,
} from "./messageSearch.mjs";
import { createSyncState } from "./syncState.mjs";

const win = (name, sid, extra = {}) => ({ index: 0, name, opencodeSessionId: sid, ...extra });
const PROJECTS = [
  { tmuxSession: "manta", windows: [win("fix login", "s1"), win("terminal", null), win("docs", "s2")] },
  { tmuxSession: "ronda", windows: [win("job-1", "s3", { owner: "job" }), win("dup", "s1"), win("blank", "")] },
];

test("resolveSearchScope: primary first, then project/window order, deduped", () => {
  const { sessionIds } = resolveSearchScope(PROJECTS, "s2");
  assert.deepEqual(sessionIds, ["s2", "s1", "s3"]);
  assert.deepEqual(resolveSearchScope(PROJECTS, null).sessionIds, ["s1", "s2", "s3"]);
});

test("resolveSearchScope: skips null/empty session ids, includes job windows", () => {
  const { sessionIds } = resolveSearchScope(PROJECTS, undefined);
  assert.ok(sessionIds.includes("s3"));
  assert.ok(!sessionIds.includes(""));
  assert.ok(!sessionIds.includes(null));
  assert.equal(sessionIds.length, 3);
});

test("resolveSearchScope: a primary no window carries is still first, unlabelled", () => {
  const { sessionIds, labels } = resolveSearchScope(PROJECTS, "ghost");
  assert.equal(sessionIds[0], "ghost");
  assert.equal(labels.has("ghost"), false);
});

test("resolveSearchScope: labels map tmux session + window name (first carrier wins)", () => {
  const { labels } = resolveSearchScope(PROJECTS, null);
  assert.deepEqual(labels.get("s1"), { workspace: "manta", name: "fix login" });
  assert.deepEqual(labels.get("s3"), { workspace: "ronda", name: "job-1" });
});

test("resolveSearchScope: tolerates malformed topology", () => {
  assert.deepEqual(resolveSearchScope(null, "p").sessionIds, ["p"]);
  assert.deepEqual(resolveSearchScope([{ tmuxSession: "x" }, null], null).sessionIds, []);
});

const H = (sid, mid) => ({ sessionId: sid, messageId: mid, role: "user", pre: "", match: "m", post: "", timeCreated: 1 });

test("groupHits: first-appearance order; the current group first with isCurrent", () => {
  const hits = [H("a", "1"), H("b", "2"), H("a", "3"), H("c", "4")];
  const g = groupHits(hits, { primarySessionId: "c" });
  assert.deepEqual(g.map((x) => x.sessionId), ["c", "a", "b"]);
  assert.deepEqual(g.map((x) => x.isCurrent), [true, false, false]);
  assert.deepEqual(g[1].hits.map((h) => h.messageId), ["1", "3"]);
});

test("groupHits: no primary → no isCurrent; scope order preserved", () => {
  const g = groupHits([H("b", "1"), H("a", "2")], {});
  assert.deepEqual(g.map((x) => x.sessionId), ["b", "a"]);
  assert.ok(g.every((x) => x.isCurrent === false));
});

test("groupHits: label is 'ws › name' or the sessionId; unknown parts are null", () => {
  const labels = new Map([
    ["a", { workspace: "ws", name: "win" }],
    ["b", { workspace: null, name: "win" }],
    ["c", { workspace: "ws", name: "" }],
  ]);
  const g = groupHits([H("a", "1"), H("b", "2"), H("c", "3"), H("d", "4")], { labels });
  assert.equal(g[0].label, "ws › win");
  assert.deepEqual([g[0].workspace, g[0].name], ["ws", "win"]);
  assert.equal(g[1].label, "b");
  assert.deepEqual([g[1].workspace, g[1].name], [null, "win"]);
  assert.equal(g[2].label, "c");
  assert.equal(g[3].label, "d");
  assert.deepEqual([g[3].workspace, g[3].name], [null, null]);
});

test("searchMessages: empty / malformed queries answer with groups:[] and never throw", async () => {
  for (const input of [{}, null, { query: "  " }, { query: 7, sessionIds: ["a"] }, { query: "x", sessionIds: "a" }, { query: "x", sessionIds: [] }]) {
    assert.deepEqual(await searchMessages(input), { supported: true, hits: [], groups: [] });
  }
});

test("searchMessages: scope:all without a session-list source (or a throwing one) is degraded, with or without a primary", async () => {
  const spy = { calls: 0 };
  const runDbTask = async () => { spy.calls++; return { rows: [], complete: true }; };
  for (const primarySessionId of [undefined, "s1"]) {
    const none = await searchMessages({ query: "needle", scope: "all", primarySessionId }, { runDbTask });
    assert.deepEqual(none, { supported: true, hits: [], groups: [], degraded: true });
    const thrown = await searchMessages(
      { query: "needle", scope: "all", primarySessionId },
      { listProjects: async () => { throw new Error("boom"); }, runDbTask },
    );
    assert.deepEqual(thrown, { supported: true, hits: [], groups: [], degraded: true });
  }
  assert.equal(spy.calls, 0);
});

// ---------------------------------------------------------------------------
// Server-first — with the V2 fixture DB
// ---------------------------------------------------------------------------

async function withSeed(seedFn, fn) {
  const fixture = await createFixtureDb(seedFn());
  try {
    await withFixtureDb(fixture, fn);
  } finally {
    fixture.close();
  }
}

// n matching user messages in `sid`, ids `${sid}-m1..n`, times base+1..base+n.
function seedSession(sid, n, base = 0) {
  const messages = [];
  const parts = [];
  for (let i = 1; i <= n; i++) {
    const id = `${sid}-m${i}`;
    messages.push({ id, sessionId: sid, timeCreated: base + i, data: { role: "user" } });
    parts.push({ id: `${id}-p`, messageId: id, sessionId: sid, timeCreated: base + i, data: { type: "text", text: `needle number ${i} in ${sid}` } });
  }
  return { sessions: [{ id: sid, directory: "/a" }], messages, parts };
}
function mergeSeeds(...seeds) {
  return {
    sessions: seeds.flatMap((s) => s.sessions),
    messages: seeds.flatMap((s) => s.messages),
    parts: seeds.flatMap((s) => s.parts),
  };
}
const DB_TEST = (name, fn) =>
  test(name, async (t) => {
    if (!(await sqliteAvailable())) return t.skip("node:sqlite unavailable on this runtime");
    await fn(t);
  });
const countBy = (hits) => hits.reduce((m, h) => m.set(h.sessionId, (m.get(h.sessionId) ?? 0) + 1), new Map());

DB_TEST("searchMessages scope:all finds hits in every window (incl. job windows), groups labelled by the box", async () => {
  await withSeed(() => mergeSeeds(seedSession("s1", 1), seedSession("s2", 1), seedSession("s3", 1)), async () => {
    const res = await searchMessages(
      { query: "needle", scope: "all", primarySessionId: "s2" },
      { listProjects: async () => PROJECTS },
    );
    assert.equal(res.supported, true);
    assert.equal(res.degraded, undefined);
    assert.deepEqual(res.groups.map((g) => g.sessionId), ["s2", "s1", "s3"]);
    assert.deepEqual(res.groups.map((g) => g.isCurrent), [true, false, false]);
    assert.deepEqual(res.groups.map((g) => g.label), ["manta › docs", "manta › fix login", "ronda › job-1"]);
    assert.deepEqual(res.hits.map((h) => h.sessionId), ["s2", "s1", "s3"]);
  });
});

DB_TEST("searchMessages scope:all: no primary caps every session at 3; a primary gets up to 50", async () => {
  await withSeed(() => mergeSeeds(seedSession("s1", 5), seedSession("s2", 5), seedSession("s3", 5)), async () => {
    const list = async () => PROJECTS;
    const noPrimary = await searchMessages({ query: "needle", scope: "all" }, { listProjects: list });
    assert.deepEqual([...countBy(noPrimary.hits)], [["s1", 3], ["s2", 3], ["s3", 3]]);
    assert.ok(noPrimary.groups.every((g) => g.isCurrent === false));
    const withPrimary = await searchMessages({ query: "needle", scope: "all", primarySessionId: "s1" }, { listProjects: list });
    assert.deepEqual([...countBy(withPrimary.hits)], [["s1", 5], ["s2", 3], ["s3", 3]]);
    const explicit = await searchMessages({ query: "needle", scope: "all", maxPrimary: 1 }, { listProjects: list });
    assert.equal(countBy(explicit.hits).get("s1"), 1);
  });
});

DB_TEST("searchMessages legacy sessionIds: same hits as before, sessionIds[0] capped at 50, labels = session ids", async () => {
  await withSeed(() => mergeSeeds(seedSession("s1", 5), seedSession("s2", 5), seedSession("s3", 5)), async () => {
    const res = await searchMessages({ query: "needle", sessionIds: ["s1", "s2", "s3"] });
    assert.deepEqual([...countBy(res.hits)], [["s1", 5], ["s2", 3], ["s3", 3]]);
    assert.deepEqual(res.groups.map((g) => g.label), ["s1", "s2", "s3"]);
    assert.ok(res.groups.every((g) => g.isCurrent === false && g.workspace === null && g.name === null));
    assert.equal(res.degraded, undefined);
    // newest first within a session
    assert.deepEqual(res.hits.filter((h) => h.sessionId === "s2").map((h) => h.messageId), ["s2-m5", "s2-m4", "s2-m3"]);
    // ground truth: groups flatten back to hits
    assert.deepEqual(res.groups.flatMap((g) => g.hits), res.hits);
  });
});

DB_TEST("searchMessages legacy: a throwing listProjects keeps identical hits, labels fall back, no degraded", async () => {
  await withSeed(() => mergeSeeds(seedSession("s1", 5), seedSession("s2", 5), seedSession("s3", 5)), async () => {
    const base = await searchMessages({ query: "needle", sessionIds: ["s1", "s2", "s3"] });
    const res = await searchMessages(
      { query: "needle", sessionIds: ["s1", "s2", "s3"] },
      { listProjects: async () => { throw new Error("tmux down"); } },
    );
    assert.deepEqual(res.hits, base.hits);
    assert.deepEqual(res.groups.map((g) => g.label), ["s1", "s2", "s3"]);
    assert.equal(res.degraded, undefined);
  });
});

DB_TEST("searchMessages legacy: explicit maxPrimary/maxPerSession/maxTotal are honoured exactly as buildHits does", async () => {
  await withSeed(() => mergeSeeds(seedSession("s1", 5), seedSession("s2", 5), seedSession("s3", 5)), async () => {
    const res = await searchMessages({ query: "needle", sessionIds: ["s1", "s2", "s3"], maxPrimary: 2, maxPerSession: 1, maxTotal: 4 });
    assert.deepEqual([...countBy(res.hits)], [["s1", 2], ["s2", 1], ["s3", 1]]);
    const capped = await searchMessages({ query: "needle", sessionIds: ["s1", "s2", "s3"], maxPrimary: 2, maxPerSession: 1, maxTotal: 3 });
    assert.equal(capped.hits.length, 3);
  });
});

DB_TEST("searchMessages legacy: a working listProjects fills labels, hits identical", async () => {
  await withSeed(() => mergeSeeds(seedSession("s1", 5), seedSession("s2", 5), seedSession("s3", 5)), async () => {
    const base = await searchMessages({ query: "needle", sessionIds: ["s1", "s2", "s3"] });
    const res = await searchMessages({ query: "needle", sessionIds: ["s1", "s2", "s3"] }, { listProjects: async () => PROJECTS });
    assert.deepEqual(res.hits, base.hits);
    assert.deepEqual(res.groups.map((g) => g.label), ["manta › fix login", "manta › docs", "ronda › job-1"]);
  });
});

DB_TEST("searchMessages: a db task error is degraded; a no_db error is unsupported", async () => {
  await withSeed(() => seedSession("s1", 1), async () => {
    const plain = await searchMessages(
      { query: "needle", sessionIds: ["s1"] },
      { runDbTask: async () => { throw new Error("worker trouble"); } },
    );
    assert.deepEqual(plain, { supported: true, hits: [], groups: [], degraded: true });
    const noDb = await searchMessages(
      { query: "needle", sessionIds: ["s1"] },
      { runDbTask: async () => { throw Object.assign(new Error("none"), { code: "no_db" }); } },
    );
    assert.deepEqual(noDb, { supported: false, hits: [], groups: [] });
    assert.equal("degraded" in noDb, false);
  });
});

DB_TEST("searchMessages: a spent budget carries groups and truncated:true", async () => {
  await withSeed(() => seedSession("s1", 1), async () => {
    const res = await searchMessages(
      { query: "needle", sessionIds: ["s1"] },
      { runDbTask: async () => ({ rows: [], complete: false }) },
    );
    assert.deepEqual(res, { supported: true, hits: [], groups: [], truncated: true });
  });
});

// ---------------------------------------------------------------------------
// Topology adapter over a REAL createSyncState (the exact rpc wiring)
// ---------------------------------------------------------------------------

function realState(listProjects) {
  return createSyncState({ listProjects, publish: () => {} });
}

DB_TEST("projectsFromSyncState: a never-succeeded topology is degraded, and the DB task never runs", async () => {
  let dbCalls = 0;
  const state = realState(async () => { throw new Error("tmux down"); });
  const res = await searchMessages(
    { query: "needle", scope: "all", primarySessionId: "s1" },
    { listProjects: projectsFromSyncState(state), runDbTask: async () => { dbCalls++; return { rows: [], complete: true }; } },
  );
  assert.deepEqual(res, { supported: true, hits: [], groups: [], degraded: true });
  assert.equal(dbCalls, 0);
});

DB_TEST("projectsFromSyncState: a genuinely empty listing is not a failure (primary alone, or nothing)", async () => {
  await withSeed(() => seedSession("s1", 1), async () => {
    const scopes = [];
    const runDbTask = async (_n, args) => { scopes.push(args.scope); return { rows: [], complete: true }; };
    const state = realState(async () => []);
    const none = await searchMessages({ query: "needle", scope: "all" }, { listProjects: projectsFromSyncState(state), runDbTask });
    assert.deepEqual(none, { supported: true, hits: [], groups: [] });
    assert.deepEqual(scopes, []);
    const alone = await searchMessages({ query: "needle", scope: "all", primarySessionId: "s1" }, { listProjects: projectsFromSyncState(state), runDbTask });
    assert.equal(alone.degraded, undefined);
    assert.deepEqual(scopes, [["s1"]]);
  });
});

DB_TEST("projectsFromSyncState: a stale state keeps serving the last-known-good windows", async () => {
  await withSeed(() => seedSession("s1", 1), async () => {
    let fail = false;
    const state = realState(async () => {
      if (fail) throw new Error("tmux fault");
      return [{ tmuxSession: "manta", windows: [win("a", "s1"), win("b", "s2")] }];
    });
    await state.refreshNow();
    fail = true;
    await state.refreshNow();
    assert.equal(state.snapshot().stale, true);
    const scopes = [];
    const res = await searchMessages(
      { query: "needle", scope: "all" },
      { listProjects: projectsFromSyncState(state), runDbTask: async (_n, a) => { scopes.push(a.scope); return { rows: [], complete: true }; } },
    );
    assert.equal(res.degraded, undefined);
    assert.deepEqual(scopes, [["s1", "s2"]]);
  });
});

test("projectsFromSyncState: refreshNow runs at most once per search while never-succeeded", async () => {
  let refreshes = 0;
  const state = realState(async () => { refreshes++; throw new Error("down"); });
  await assert.rejects(projectsFromSyncState(state)(), (e) => e.code === "scope_unavailable");
  assert.equal(refreshes, 1);
  const ok = realState(async () => { refreshes++; return []; });
  const before = refreshes;
  const list = projectsFromSyncState(ok);
  await list();
  await list();
  assert.equal(refreshes - before, 1);
});
