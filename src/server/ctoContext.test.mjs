// ctoContext.test.mjs — P1a contract tests for the passive read-only
// historical-context service (unified-CTO spec §4.2 slice; contract-only —
// nothing is exposed through rpc/tools/UI yet, and these tests pin exactly
// that: zero prompt/window/job side effects on read).
//
// Covered acceptance (spec §14 IDs, contract-only):
//   U03 — a historical decision that lives only in a CLOSED CHILD session is
//         discovered and resolved to the exact source message/part IDs.
//   U04 — zero prompt sends / worker wakes observed on read: a throwing
//         `fetch` spy stays at zero calls across all three operations, source
//         row counts and the source schema (sqlite_master) are unchanged.
//   U05 — tool evidence is retrievable and distinct from prose (matchedField
//         names input vs output; the huge-output case is truncated with
//         omitted-size metadata, never silently).
//   U27 — absence is honest: `source_unavailable` (distinct from unsupported
//         runtime and from a legitimately empty source), and an empty source
//         answers `status:"ok"` WITH coverage — never a fabricated result.
// Plus: server-side limits independent of caller args, keyset cursors that
// cannot repeat rows, and observed-identity passthrough (`projectId` is the
// DB's project_id verbatim and is NEVER surfaced as a workspace id — the
// mapping stays explicitly `unmapped`).
//
// Every DB case degrades to skip without node:sqlite (spec §15.2); the file
// itself imports safely on Node 20 because node:sqlite is only ever imported
// dynamically. Runs under the suite's MANTA_STATE_HOME sandbox like every
// other server test; the fixture DB is always armed via MANTA_OPENCODE_DB
// (withFixture → the P0 withFixtureDb wrapper, never a bare env toggle).

import test from "node:test";
import assert from "node:assert/strict";
import { ctoListSessions, ctoSearch, ctoAround, CTO_CONTEXT_LIMITS } from "./ctoContext.mjs";
import { _resetDbHandle } from "./opencodeDb.mjs";
import { createFixtureDb, sqliteAvailable, withFixtureDb } from "./fixtures/opencodeDbFixture.mjs";

const hasSqlite = await sqliteAvailable();

// Create the synthetic source DB, arm `MANTA_OPENCODE_DB` through the P0
// wrapper (env armed + shared handle reset BEFORE any getDb, the no-live-
// fallback canary asserted while armed, the fixture-owned connection closed
// on every exit path), and always remove the temp dir.
async function withFixture(seed, fn) {
  const fixture = await createFixtureDb(seed);
  try {
    return await withFixtureDb(fixture, fn);
  } finally {
    fixture.close();
  }
}

// ---------------------------------------------------------------------------
// Deterministic corpus: two repositories, an archived (closed) child session
// holding a decision that exists nowhere else, tool evidence (small + huge),
// and filler sessions for pagination. All IDs/times are explicit.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000;
function bigOutput(n) {
  return "x".repeat(n);
}

function seedRows() {
  const sessions = [
    { id: "s_parent", projectId: "prj_a", workspaceId: "ws_a", directory: "/repo-a", title: "Feature work", timeCreated: T, timeUpdated: T + 900, timeArchived: null },
    { id: "s_child", parentId: "s_parent", projectId: "prj_a", workspaceId: "ws_a", directory: "/repo-a", title: "child worker", timeCreated: T + 100, timeUpdated: T + 950, timeArchived: T + 990 },
    { id: "s_b", projectId: "prj_b", workspaceId: "ws_b", directory: "/repo-b", title: "Other repo", timeCreated: T + 200, timeUpdated: T + 800, timeArchived: null },
    { id: "s_arch", projectId: "prj_a", workspaceId: "ws_a", directory: "/repo-a", title: "old archived", timeCreated: T, timeUpdated: T + 10, timeArchived: T + 20 },
    // Fillers for list pagination (newest first by timeUpdated).
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `s_f${i}`,
      projectId: "prj_a",
      directory: "/repo-a",
      title: `filler ${i}`,
      timeCreated: T + 300 + i,
      timeUpdated: T + 700 - i,
    })),
  ];
  const messages = [
    { id: "mc1", sessionId: "s_child", timeCreated: T + 400, data: { role: "assistant" } },
    { id: "mc2", sessionId: "s_child", timeCreated: T + 410, data: { role: "assistant" } },
    { id: "mc3", sessionId: "s_child", timeCreated: T + 420, data: { role: "assistant" } },
    // Five tool messages with big outputs — the global 24 KiB budget must cut
    // the tail of the around() window.
    ...Array.from({ length: 5 }, (_, i) => ({ id: `mbig${i}`, sessionId: "s_child", timeCreated: T + 500 + i, data: { role: "assistant" } })),
    { id: "m1", sessionId: "s_parent", timeCreated: T + 600, data: { role: "assistant" } },
    { id: "m_b", sessionId: "s_b", timeCreated: T + 610, data: { role: "user" } },
    // Seven needle messages for search cursor pagination (descending time).
    ...Array.from({ length: 7 }, (_, i) => ({ id: `mn${i}`, sessionId: "s_child", timeCreated: T + 700 - i, data: { role: "assistant" } })),
  ];
  const parts = [
    { id: "p_kick", messageId: "mc1", sessionId: "s_child", timeCreated: T + 400, data: { type: "text", text: "kickoff for the worker" } },
    { id: "p_decision", messageId: "mc2", sessionId: "s_child", timeCreated: T + 410, data: { type: "text", text: "decision: use lease-based locking for the store" } },
    { id: "p_tool", messageId: "mc3", sessionId: "s_child", timeCreated: T + 420, data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "42 passing" } } },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `p_bigid${i}`,
      messageId: `mbig${i}`,
      sessionId: "s_child",
      timeCreated: T + 500 + i,
      data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: `dump ${i}` }, output: bigOutput(7000) } },
    })),
    { id: "p_deploy", messageId: "m1", sessionId: "s_parent", timeCreated: T + 600, data: { type: "text", text: "deployed leasebot to staging" } },
    { id: "p_b", messageId: "m_b", sessionId: "s_b", timeCreated: T + 610, data: { type: "text", text: "question about repo b" } },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `p_needle${i}`, messageId: `mn${i}`, sessionId: "s_child", timeCreated: T + 700 - i, data: { type: "text", text: `needle ${i} in the closed child` } })),
  ];
  return { sessions, messages, parts };
}

// Read-only introspection helper (same connection pattern as the fixture's
// own rowCount).
async function tableNames(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(dbPath);
  try {
    return d.prepare("SELECT name FROM sqlite_master ORDER BY name").all().map((r) => r.name);
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------------------
// Session discovery (all historical, incl. closed + children)
// ---------------------------------------------------------------------------

test("listSessions: discovers ALL historical sessions including the archived child, with observed identity passthrough", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const res = await ctoListSessions({});
    assert.equal(res.supported, true);
    assert.equal(res.status, "ok");
    assert.equal(res.coverage.mode, "direct-source");
    assert.equal(res.coverage.indexed, false, "P1a has no FTS index — coverage says so");
    const byId = new Map(res.sessions.map((s) => [s.id, s]));
    assert.equal(res.sessions.length, 10);
    assert.ok(byId.has("s_child"), "the closed child session must be discovered");
    assert.ok(byId.has("s_arch"));
    const child = byId.get("s_child");
    assert.equal(child.parentSessionId, "s_parent", "parent/child link preserved");
    assert.equal(child.archived, true);
    assert.equal(child.timeArchived, T + 990);
    // Observed identity: projectId carries the DB project_id verbatim and is
    // NEVER rebranded as a workspace id; workspaceId is the observed
    // workspace value, distinct; the mapping is explicitly unmapped.
    assert.equal(child.projectId, "prj_a");
    assert.equal(child.workspaceId, "ws_a");
    assert.equal(child.projectMapping, "unmapped");
    assert.equal(child.title, "child worker");
    assert.equal(child.directory, "/repo-a");
    for (const s of res.sessions) assert.equal(s.projectMapping, "unmapped");
  });
});

test("listSessions: filters by observed projectId/directory, includeArchived excludes closed, forbidden workspace key rejected", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const bOnly = await ctoListSessions({ projectId: "prj_b" });
    assert.deepEqual(bOnly.sessions.map((s) => s.id), ["s_b"]);
    const dirB = await ctoListSessions({ directory: "/repo-b" });
    assert.deepEqual(dirB.sessions.map((s) => s.id), ["s_b"]);
    const live = await ctoListSessions({ includeArchived: false });
    assert.ok(!live.sessions.some((s) => s.archived), "includeArchived:false must exclude closed sessions");
    const forbidden = await ctoListSessions({ workspaceId: "prj_a" });
    assert.equal(forbidden.status, "invalid_input", "a Manta workspace key must be rejected, never reinterpreted");
  });
});

test("listSessions: server-side limit clamp + keyset cursor pagination with zero duplication and full coverage", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const extra = Array.from({ length: 51 }, (_, i) => ({
    id: `s_p${String(i).padStart(2, "0")}`,
    projectId: "prj_a",
    directory: "/repo-a",
    timeCreated: T + i,
    timeUpdated: T + 2000 - i,
  }));
  await withFixture({ sessions: [...seedRows().sessions, ...extra], messages: [], parts: [] }, async () => {
    // 10 + 51 = 61 seeded sessions.
    const forced = await ctoListSessions({ limit: 100000 });
    assert.ok(forced.sessions.length <= CTO_CONTEXT_LIMITS.sessionsMax, "caller limit must be clamped server-side");
    assert.equal(forced.truncated, true, "more rows existed than the cap allowed");

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const res = await ctoListSessions({ limit: 5, cursor });
      for (const s of res.sessions) seen.push(s.id);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    assert.equal(new Set(seen).size, seen.length, "keyset cursor pages must never repeat a session");
    assert.equal(seen.length, 61, "pagination must cover every historical session exactly once");
  });
});

// ---------------------------------------------------------------------------
// Search: closed-child hit (U03), tool evidence (U05), filters, limits,
// cursors, budget
// ---------------------------------------------------------------------------

test("search: the decision that exists only in the CLOSED child session is found with stable source IDs (U03)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const res = await ctoSearch({ query: "lease-based locking" });
    assert.equal(res.status, "ok");
    assert.equal(res.hits.length, 1);
    const hit = res.hits[0];
    assert.equal(hit.sessionId, "s_child");
    assert.equal(hit.messageId, "mc2");
    assert.equal(hit.partId, "p_decision");
    assert.equal(hit.kind, "text");
    assert.equal(hit.role, "assistant");
    assert.match(hit.snippet.match, /lease-based locking/);
    assert.equal(hit.projectMapping, "unmapped");
    // Searching the project must NOT exclude its historical child.
    const scoped = await ctoSearch({ query: "lease-based locking", projectId: "prj_a" });
    assert.equal(scoped.hits.length, 1);
    assert.equal(scoped.hits[0].sessionId, "s_child");
    const other = await ctoSearch({ query: "lease-based locking", projectId: "prj_b" });
    assert.deepEqual(other.hits, []);
  });
});

test("search: tool evidence is retrievable and its field identified (U05), with tool name/status", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const byOutput = await ctoSearch({ query: "42 passing" });
    assert.equal(byOutput.hits.length, 1);
    assert.equal(byOutput.hits[0].kind, "tool");
    assert.equal(byOutput.hits[0].sessionId, "s_child");
    assert.equal(byOutput.hits[0].messageId, "mc3");
    assert.equal(byOutput.hits[0].partId, "p_tool");
    assert.equal(byOutput.hits[0].tool.name, "bash");
    assert.equal(byOutput.hits[0].tool.status, "completed");
    assert.equal(byOutput.hits[0].tool.matchedField, "output");
    const byInput = await ctoSearch({ query: "npm test" });
    assert.equal(byInput.hits.length, 1);
    assert.equal(byInput.hits[0].tool.matchedField, "input");
  });
});

test("search: the 24 KiB returned-text budget is enforced server-side with omitted-size metadata, never silently (U05/U27)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const encoder = new TextEncoder();
  // (a) A long query makes a single snippet window exceed the remaining
  // budget — the guard must cut it and name the full field size.
  await withFixture(seedRows(), async () => {
    // A 6900-char query matches the 7000-char output runs and makes each
    // snippet span its whole field — cumulative snippets overflow the 24 KiB
    // call budget, so the tail hits must be cut and reported.
    const res = await ctoSearch({ query: "xxx".repeat(2300), limit: CTO_CONTEXT_LIMITS.searchHitsMax });
    assert.equal(res.status, "ok");
    const cut = res.hits.find((h) => h.snippetTruncated === true);
    assert.ok(cut, "a snippet that does not fit the call budget must be cut and reported");
    assert.equal(cut.tool.matchedField, "output");
    assert.equal(cut.sourceBytes, 7000, "omitted-size metadata names the FULL matched field");
    const totalText = res.hits.reduce((n, h) => n + encoder.encode(h.snippet.pre + h.snippet.match + h.snippet.post).length, 0);
    assert.ok(totalText <= CTO_CONTEXT_LIMITS.textBudgetBytes, "returned text must stay within the 24 KiB call budget");
  });
  // (b) Many big-output candidates: the hit cap cuts the page and the result
  // says so (truncated + omittedCount), with every emitted snippet bounded.
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `mb${i}`, sessionId: "s_child", timeCreated: T + 900 + i, data: { role: "assistant" } }));
  const manyParts = many.map((m, i) => ({
    id: `pb${i}`,
    messageId: m.id,
    sessionId: "s_child",
    timeCreated: T + 900 + i,
    data: { type: "tool", tool: "bash", state: { status: "completed", output: `xxx-${i}-${bigOutput(6 * 1024)}` } },
  }));
  await withFixture({ sessions: seedRows().sessions, messages: [...seedRows().messages, ...many], parts: [...seedRows().parts, ...manyParts] }, async () => {
    const res = await ctoSearch({ query: "xxx", limit: CTO_CONTEXT_LIMITS.searchHitsMax });
    assert.equal(res.status, "ok");
    assert.equal(res.truncated, true, "the hit cap cut candidate rows — reported, not silent");
    assert.equal(res.hits.length, CTO_CONTEXT_LIMITS.searchHitsMax);
    assert.equal(res.omittedCount, 15, "65 candidates (60 new + 5 seeded big parts) − 50 emitted");
    for (const h of res.hits) {
      assert.equal(h.kind, "tool");
      assert.ok(h.snippet.pre.length + h.snippet.match.length + h.snippet.post.length < 400, "every emitted snippet stays bounded");
    }
  });
});

test("search: hit limit clamp + keyset cursor pagination over a needle series with zero duplication", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const forced = await ctoSearch({ query: "needle", limit: 99999 });
    assert.ok(forced.hits.length <= CTO_CONTEXT_LIMITS.searchHitsMax, "caller limit must be clamped server-side");

    const seen = [];
    let cursor = null;
    let pages = 0;
    for (let page = 0; page < 10; page++) {
      const res = await ctoSearch({ query: "needle", sessionId: "s_child", limit: 3, cursor });
      pages++;
      for (const h of res.hits) seen.push(h.partId);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    // 3+3+1 hits, then one terminal EMPTY page (nextCursor stays set while
    // hits were emitted; the empty page ends the walk).
    assert.equal(pages, 4);
    assert.equal(new Set(seen).size, seen.length, "keyset cursor pages must never repeat a hit");
    assert.deepEqual(
      seen.slice().sort(),
      Array.from({ length: 7 }, (_, i) => `p_needle${i}`).sort(),
      "pagination must cover every matching part exactly once",
    );
    const bad = await ctoSearch({ query: "needle", cursor: "%%%not-a-cursor%%%" });
    assert.equal(bad.status, "invalid_input");
  });
});

// ---------------------------------------------------------------------------
// around: exact neighborhood, stable IDs, per-part + global budget
// ---------------------------------------------------------------------------

test("around: returns the exact chronological neighborhood with stable IDs, anchor flagged, tool evidence bounded per part", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const res = await ctoAround({ sessionId: "s_child", messageId: "mc2", before: 1, after: 1 });
    assert.equal(res.status, "ok");
    assert.equal(res.session.projectId, "prj_a");
    assert.equal(res.session.projectMapping, "unmapped");
    assert.equal(res.session.anchorMessageId, "mc2");
    assert.deepEqual(res.messages.map((m) => m.id), ["mc1", "mc2", "mc3"], "exact before/anchor/after neighborhood");
    assert.equal(res.truncated, false);
    const anchorMsg = res.messages[1];
    assert.equal(anchorMsg.anchor, true);
    assert.equal(anchorMsg.parts[0].partId, "p_decision");
    assert.match(anchorMsg.parts[0].text, /lease-based locking/);
    const toolMsg = res.messages[2];
    assert.equal(toolMsg.parts[0].kind, "tool");
    assert.equal(toolMsg.parts[0].tool.name, "bash");
    assert.match(toolMsg.parts[0].text, /42 passing/, "the tool RESULT is the primary evidence (U05)");
    assert.equal(res.messages[0].anchor, false);

    const clamped = await ctoAround({ sessionId: "s_child", messageId: "mc2", before: 9999, after: 9999 });
    assert.ok(clamped.messages.length <= CTO_CONTEXT_LIMITS.aroundMessagesMax + 1, "before+after clamped server-side (anchor additional)");
  });
});

test("around: a huge tool output is cut per part with omitted-size metadata, and the global budget drops the tail honestly", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const encoder = new TextEncoder();
  await withFixture(seedRows(), async () => {
    const res = await ctoAround({ sessionId: "s_child", messageId: "mc2", before: 0, after: 8 });
    assert.equal(res.status, "ok");
    assert.equal(res.truncated, true, "five 7 KiB outputs exceed the 24 KiB call budget — the tail must be reported");
    assert.ok(res.omittedCount >= 1, "messages whose evidence was dropped for budget are counted");
    // Every message keeps its stable ID even when its evidence was dropped;
    // the anchor's own evidence survives (budget priority).
    assert.ok(res.messages.every((m) => Array.isArray(m.parts)));
    const anchorMsg = res.messages.find((m) => m.anchor === true);
    assert.match(anchorMsg.parts[0].text, /lease-based locking/);
    const cutPart = res.messages.flatMap((m) => m.parts).find((p) => p.truncated === true);
    assert.ok(cutPart, "the part that did not fit was cut with omitted-size metadata");
    assert.equal(cutPart.sourceBytes, 7000);
    const total = res.messages.reduce((n, m) => n + m.parts.reduce((k, p) => k + encoder.encode(p.text).length, 0), 0);
    assert.ok(total <= CTO_CONTEXT_LIMITS.textBudgetBytes);
  });
});

test("around: unknown session and unknown message return distinct reference_expired reasons, never a fake result", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const noSession = await ctoAround({ sessionId: "ses_nope", messageId: "mc2" });
    assert.equal(noSession.supported, true);
    assert.equal(noSession.status, "reference_expired");
    assert.match(noSession.detail, /session ses_nope not found/);
    assert.deepEqual(noSession.messages, []);
    const noMessage = await ctoAround({ sessionId: "s_child", messageId: "msg_nope" });
    assert.equal(noMessage.status, "reference_expired");
    assert.match(noMessage.detail, /message msg_nope not found/);
    const bad = await ctoAround({ sessionId: "", messageId: "mc2" });
    assert.equal(bad.status, "invalid_input");
  });
});

// ---------------------------------------------------------------------------
// Honest degradation + zero side effects
// ---------------------------------------------------------------------------

test("degradation (all runtimes): a missing source answers supported:false honestly and never throws", async () => {
  const prevDb = process.env.MANTA_OPENCODE_DB;
  _resetDbHandle();
  try {
    process.env.MANTA_OPENCODE_DB = "/nonexistent/cto-p1a/opencode.db";
    _resetDbHandle();
    const res = await ctoListSessions({});
    assert.equal(res.supported, false);
    assert.ok(
      res.status === "source_unavailable" || res.status === "unsupported",
      `honest degradation status, got ${res.status}`,
    );
    assert.deepEqual(res.sessions, []);
    const search = await ctoSearch({ query: "x" });
    assert.equal(search.supported, false);
    const around = await ctoAround({ sessionId: "s", messageId: "m" });
    assert.equal(around.supported, false);
  } finally {
    if (prevDb === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prevDb;
    _resetDbHandle();
  }
});

test("U27: an empty source answers status ok WITH coverage — no fabricated activity claim", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture({}, async () => {
    const res = await ctoListSessions({});
    assert.equal(res.status, "ok");
    assert.deepEqual(res.sessions, []);
    assert.equal(res.coverage.mode, "direct-source");
    assert.equal(res.truncated, false);
    assert.equal(res.nextCursor, null);
    const search = await ctoSearch({ query: "anything" });
    assert.equal(search.status, "ok");
    assert.deepEqual(search.hits, []);
  });
});

test("U04: passive reads observe ZERO side effects — no fetch/prompt dispatch, row counts and source schema unchanged", async (t) => {
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
      assert.equal((await ctoListSessions({})).status, "ok");
      assert.equal((await ctoSearch({ query: "lease" })).status, "ok");
      assert.equal((await ctoAround({ sessionId: "s_child", messageId: "mc2" })).status, "ok");
      const afterRows = fixture.rowCount("session") + fixture.rowCount("message") + fixture.rowCount("part");
      assert.equal(afterRows, beforeRows, "a passive read must leave source row counts unchanged");
      assert.deepEqual(await tableNames(fixture.dbPath), beforeTables, "no table/index may be created in the source DB (no index modification)");
      assert.equal(fetchCalls, 0, "the fetch seam observed zero calls — no prompt dispatch, window or job creation on read");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
