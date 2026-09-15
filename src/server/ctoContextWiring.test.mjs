// ctoContextWiring.test.mjs — P1c wiring tests: the passive project-context
// read verbs (context_projects / context_search / context_around, spec §4.2)
// exposed through the CTO read engine's dispatch seam (src/server/cto.mjs),
// backed by the REAL ctoContext source-read service (P1a) over the P0 fixture
// DB.
//
// The composition under test is the production shape: createCtoEngine's
// DEFAULT context deps ARE the ctoContext functions, so no fake context
// service sits in the middle — the synthetic read source is the fixture DB,
// armed via MANTA_OPENCODE_DB (P0 wrapper) BEFORE any handle opens. The live
// tmux/opencode read seams are injected as THROWING spies to prove the context
// verbs never touch them.
//
// Covered (all contract-only; P1b index NOT wired — coverage.indexed stays
// false):
//   • registry: the three verbs exist, auto mode, documented params.
//   • happy paths through engine.dispatch with observed-identity passthrough
//     (projectId kept verbatim + projectMapping:"unmapped", never a Manta
//     workspace id).
//   • historical/closed-child discovery via search + around (U03 seam).
//   • typed-argument validation FROM the existing service methods: empty
//     query, garbage cursor, forbidden workspaceId key, missing around refs,
//     over-ask limit clamped server-side.
//   • truncation/cursor metadata propagation: nextCursor paging with zero
//     duplication, omitted-size markers, aggregate truncated flags.
//   • distinct degradation: source_unavailable vs unsupported, never throws.
//   • U04 at the engine composition boundary: ZERO fetch calls (no prompt
//     dispatch / window / job creation), source rows + schema unchanged, no
//     secrets in any envelope.

import "./ctoTestGuard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createCtoEngine } from "./cto.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "./fixtures/opencodeDbFixture.mjs";
import { _resetDbHandle, _setSqliteModuleOverride } from "./opencodeDb.mjs";

const hasSqlite = await sqliteAvailable();

// The REAL engine, production shape: context deps stay defaulted to the
// ctoContext service; every OTHER seam is a throwing spy so any accidental
// live-tmux/opencode call fails loudly.
function makeEngine() {
  return createCtoEngine({
    listProjects: () => {
      throw new Error("context verbs must not touch live tmux");
    },
    listSessions: () => {
      throw new Error("context verbs must not touch live opencode sessions");
    },
    listMessages: () => {
      throw new Error("context verbs must not touch live opencode messages");
    },
  });
}

// Arm the P0 fixture DB through the wrapper (env + handle reset BEFORE any
// getDb; fixture-owned connection closed on every exit path).
async function withFixture(seed, fn) {
  const fixture = await createFixtureDb(seed);
  try {
    return await withFixtureDb(fixture, fn);
  } finally {
    fixture.close();
  }
}

// ---------------------------------------------------------------------------
// Deterministic corpus — mirrors the P0 fixture shape: two projects, an
// ARCHIVED (closed) child session holding a decision that exists nowhere
// else, tool evidence (small + huge) and a needle series for cursor paging.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000;
function bigOutput(n) {
  return "x".repeat(n);
}

function seedRows() {
  const sessions = [
    { id: "s_parent", projectId: "prj_a", workspaceId: "ws_a", directory: "/repo-a", title: "Feature work", timeCreated: T, timeUpdated: T + 900 },
    { id: "s_child", parentId: "s_parent", projectId: "prj_a", workspaceId: "ws_a", directory: "/repo-a", title: "child worker", timeCreated: T + 100, timeUpdated: T + 950, timeArchived: T + 990 },
    { id: "s_b", projectId: "prj_b", workspaceId: "ws_b", directory: "/repo-b", title: "Other repo", timeCreated: T + 200, timeUpdated: T + 800 },
  ];
  const messages = [
    { id: "mc2", sessionId: "s_child", timeCreated: T + 410, data: { role: "assistant" } },
    { id: "m1", sessionId: "s_parent", timeCreated: T + 600, data: { role: "user" } },
    { id: "m_b", sessionId: "s_b", timeCreated: T + 610, data: { role: "assistant" } },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `mn${i}`, sessionId: "s_child", timeCreated: T + 700 - i, data: { role: "assistant" } })),
  ];
  const parts = [
    { id: "p_decision", messageId: "mc2", sessionId: "s_child", timeCreated: T + 410, data: { type: "text", text: "decision: use lease-based locking" } },
    { id: "p_tool", messageId: "mc2", sessionId: "s_child", timeCreated: T + 411, data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "42 passing" } } },
    { id: "p_deploy", messageId: "m1", sessionId: "s_parent", timeCreated: T + 600, data: { type: "text", text: "deployed leasebot to staging" } },
    { id: "p_b", messageId: "m_b", sessionId: "s_b", timeCreated: T + 610, data: { type: "text", text: `unrelated note about repo b` } },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `p_needle${i}`, messageId: `mn${i}`, sessionId: "s_child", timeCreated: T + 700 - i, data: { type: "text", text: `needle ${i} in the closed child` } })),
    { id: "p_bigid", messageId: "m1", sessionId: "s_parent", timeCreated: T + 601, data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "dump" }, output: bigOutput(9000) } } },
  ];
  return { sessions, messages, parts };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry exposes the three passive context verbs as auto-mode reads with documented params", () => {
  const engine = makeEngine();
  const CONTEXT_VERBS = new Set(["context_projects", "context_search", "context_around"]);
  const tools = engine.listTools().filter((t) => CONTEXT_VERBS.has(t.name));
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["context_around", "context_projects", "context_search"],
  );
  for (const t of tools) {
    assert.equal(t.mode, "auto", "passive context reads never confirm");
    assert.ok(t.description.includes("Read-only"));
    assert.ok(t.params && typeof t.params === "object");
    assert.equal(typeof t.run, "function");
  }
  assert.ok(tools.find((t) => t.name === "context_projects").params.projectId, "projectId param documented");
  assert.ok(tools.find((t) => t.name === "context_search").params.cursor, "cursor param documented");
  assert.ok(tools.find((t) => t.name === "context_around").params.partId, "partId param documented");
});

// ---------------------------------------------------------------------------
// Happy paths through the real engine dispatch over the fixture DB
// ---------------------------------------------------------------------------

test("context_projects through engine.dispatch discovers ALL historical sessions incl. the archived child, observed identity passthrough", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    const res = await engine.dispatch("context_projects", {});
    assert.equal(res.ok, true);
    const d = res.data;
    assert.equal(d.status, "ok");
    assert.equal(d.supported, true);
    assert.equal(d.coverage.mode, "direct-source");
    assert.equal(d.coverage.indexed, false, "P1b index is NOT wired in this PR");
    assert.ok(typeof d.observedAt === "string" && !Number.isNaN(Date.parse(d.observedAt)));

    const child = d.sessions.find((s) => s.id === "s_child");
    assert.ok(child, "the closed child session must be discovered");
    assert.equal(child.archived, true);
    assert.equal(child.projectId, "prj_a", "observed project_id carried verbatim");
    assert.equal(child.projectMapping, "unmapped", "project mapping is explicitly unmapped, never a Manta workspace id");
    assert.equal(child.parentSessionId, "s_parent", "parent/child links preserved");
    assert.equal(child.workspaceId, "ws_a", "observed workspace value kept SEPARATE from projectId");
  });
});

test("context_search finds the decision that exists only in the CLOSED child session, with stable source ids (U03 seam)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    const res = await engine.dispatch("context_search", { query: "decision" });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, "ok");
    const hit = res.data.hits.find((h) => h.partId === "p_decision");
    assert.ok(hit, "the closed-child decision must be reachable");
    assert.equal(hit.sessionId, "s_child");
    assert.equal(hit.messageId, "mc2");
    assert.equal(hit.projectMapping, "unmapped");
    assert.match(hit.snippet.match, /decision/i);
  });
});

test("context_around returns the anchored neighborhood with stable ids and tool evidence", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    const res = await engine.dispatch("context_around", { sessionId: "s_child", messageId: "mc2" });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, "ok");
    assert.equal(res.data.session.sessionId, "s_child");
    assert.equal(res.data.session.projectMapping, "unmapped");
    const anchor = res.data.messages.find((m) => m.anchor);
    assert.ok(anchor, "the anchor message is flagged");
    assert.equal(anchor.id, "mc2");
    const partIds = anchor.parts.map((p) => p.partId);
    assert.ok(partIds.includes("p_decision"), "anchor text evidence present");
    assert.ok(partIds.includes("p_tool"), "anchor tool evidence present");
    const toolPart = anchor.parts.find((p) => p.partId === "p_tool");
    assert.equal(toolPart.tool.name, "bash");
  });
});

// ---------------------------------------------------------------------------
// Typed-argument validation comes FROM the existing service methods
// ---------------------------------------------------------------------------

test("invalid arguments surface the service's structured invalid_input status, never a throw", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    // Empty query.
    const emptyQuery = await engine.dispatch("context_search", { query: "   " });
    assert.equal(emptyQuery.ok, true);
    assert.equal(emptyQuery.data.status, "invalid_input");
    // Garbage cursor.
    const badCursor = await engine.dispatch("context_search", { query: "needle", cursor: "not-a-cursor" });
    assert.equal(badCursor.data.status, "invalid_input");
    // The forbidden Manta workspace key — rejected explicitly, never
    // reinterpreted (the discovered project id is NOT a Manta workspace id).
    for (const verb of ["context_projects", "context_search"]) {
      const ws = await engine.dispatch(verb, { workspaceId: "ws_a" });
      assert.equal(ws.ok, true);
      assert.equal(ws.data.status, "invalid_input");
      assert.match(ws.data.detail, /workspace/i);
    }
    // Missing around references.
    const noRefs = await engine.dispatch("context_around", {});
    assert.equal(noRefs.data.status, "invalid_input");
    const noMsg = await engine.dispatch("context_around", { sessionId: "s_child" });
    assert.equal(noMsg.data.status, "invalid_input");
  });
});

test("an over-ask limit is clamped server-side and the cursor pages the remainder without duplication", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    // 7 needles seeded; ask for 999 — the server clamps to its own cap.
    const page1 = await engine.dispatch("context_search", { query: "needle", limit: 999 });
    assert.equal(page1.data.status, "ok");
    assert.equal(page1.data.hits.length, 7, "all hits fit under the server cap");
    assert.equal(page1.data.nextCursor, null, "a partial scan window means the source is exhausted");
    assert.equal(page1.data.truncated, false);

    // Now page with a small limit: keyset cursor, zero duplication.
    const p1 = await engine.dispatch("context_search", { query: "needle", limit: 3 });
    assert.equal(p1.data.hits.length, 3);
    assert.ok(p1.data.nextCursor, "a full page leaves a cursor");
    const p2 = await engine.dispatch("context_search", { query: "needle", limit: 3, cursor: p1.data.nextCursor });
    assert.equal(p2.data.hits.length, 3);
    const seen = new Set([...p1.data.hits, ...p2.data.hits].map((h) => h.partId));
    assert.equal(seen.size, 6, "pages never repeat a hit");
    const p3 = await engine.dispatch("context_search", { query: "needle", limit: 3, cursor: p2.data.nextCursor });
    assert.equal(p3.data.hits.length, 1);
    assert.equal(p3.data.nextCursor, null);
  });
});

test("truncation metadata propagates: the huge tool output is bounded per part with omitted-size markers on the aggregate envelope", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    const res = await engine.dispatch("context_around", { sessionId: "s_parent", messageId: "m1", before: 0, after: 0 });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, "ok");
    assert.equal(res.data.truncated, true, "the 9000-byte output exceeds the per-part evidence cap");
    const big = res.data.messages.flatMap((m) => m.parts).find((p) => p.partId === "p_bigid");
    assert.ok(big);
    assert.equal(big.textTruncated, true);
    assert.equal(big.textSourceBytes, 9000);
    assert.ok(big.textReturnedBytes < 9000);
    assert.ok(JSON.stringify(res.data).length <= 24 * 1024, "the serialized response respects the §4.2 budget");
  });
});

// ---------------------------------------------------------------------------
// Degradation — distinct statuses, never a throw
// ---------------------------------------------------------------------------

test("a missing source answers source_unavailable and a runtime without node:sqlite answers unsupported, distinctly", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const prevDb = process.env.MANTA_OPENCODE_DB;
  _resetDbHandle();
  process.env.MANTA_OPENCODE_DB = "/nonexistent/cto-p1c/opencode.db";
  try {
    const engine = makeEngine();
    const res = await engine.dispatch("context_projects", {});
    assert.equal(res.ok, true);
    assert.equal(res.data.status, "source_unavailable");
    assert.equal(res.data.supported, false);

    // The deterministic unsupported path on a runtime that HAS node:sqlite.
    _resetDbHandle();
    _setSqliteModuleOverride({ __importError: new Error("no sqlite in this test") });
    try {
      const res2 = await engine.dispatch("context_projects", {});
      assert.equal(res2.data.status, "unsupported");
      assert.equal(res2.data.supported, false);
    } finally {
      _setSqliteModuleOverride(null);
    }
  } finally {
    if (prevDb === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prevDb;
    _resetDbHandle();
  }
});

test("a stale/unknown reference answers reference_expired with a reason, never a fake result", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const engine = makeEngine();
    const res = await engine.dispatch("context_around", { sessionId: "s_gone", messageId: "mc2" });
    assert.equal(res.ok, true);
    assert.equal(res.data.status, "reference_expired");
    assert.deepEqual(res.data.messages, []);
    assert.match(res.data.detail, /s_gone/);
  });
});

// ---------------------------------------------------------------------------
// U04 at the engine composition boundary — passive reads observe ZERO side
// effects: no fetch (prompt dispatch / window / job creation), live read
// seams untouched, source rows + schema unchanged, no secrets in envelopes.
// ---------------------------------------------------------------------------

async function tableNames(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return d.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all().map((r) => r.name);
  } finally {
    d.close();
  }
}

test("U04: context verbs observe zero side effects through the engine seam — fetch spy at zero, rows/schema unchanged, no secrets", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("prompt dispatch attempted from the passive context read path");
  };
  try {
    await withFixture(seedRows(), async (fixture) => {
      const beforeTables = await tableNames(fixture.dbPath);
      const beforeRows = fixture.rowCount("session") + fixture.rowCount("message") + fixture.rowCount("part");
      const engine = makeEngine();
      const r1 = await engine.dispatch("context_projects", {});
      const r2 = await engine.dispatch("context_search", { query: "lease" });
      const r3 = await engine.dispatch("context_around", { sessionId: "s_child", messageId: "mc2" });
      assert.equal(r1.data.status, "ok");
      assert.equal(r2.data.status, "ok");
      assert.equal(r3.data.status, "ok");
      const afterRows = fixture.rowCount("session") + fixture.rowCount("message") + fixture.rowCount("part");
      assert.equal(afterRows, beforeRows, "a passive read must leave source row counts unchanged");
      assert.deepEqual(await tableNames(fixture.dbPath), beforeTables, "no table/index may be created in the source DB");
      assert.equal(fetchCalls, 0, "the fetch seam observed zero calls — no prompt dispatch, window or job creation on read");
      for (const r of [r1, r2, r3]) {
        const json = JSON.stringify(r.data);
        assert.ok(!/"(apiKey|boxToken|groqApiKey|secret|token)"/i.test(json), "no secret-shaped keys in the envelope");
      }
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
