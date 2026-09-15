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
// Plus (Astra PR1508 review): the scan-cap cursor advances past CONSUMED
// candidates so a discarded-only page can never falsely end the walk;
// JSON-escaped candidate selection keeps decoded quotes/backslashes/newlines
// searchable; linear UTF-8 truncation; bounded part reads with early stop;
// before/after zero valid and the 40-message cap INCLUDING the anchor; the
// 24 KiB budget measured on the ACTUAL serialized response; and strict
// independent `unsupported` vs `source_unavailable` degradation.
//
// Every DB case degrades to skip without node:sqlite (spec §15.2); the file
// itself imports safely on Node 20 because node:sqlite is only ever imported
// dynamically. Runs under the suite's MANTA_STATE_HOME sandbox like every
// other server test; the fixture DB is always armed via MANTA_OPENCODE_DB
// (withFixture → the P0 withFixtureDb wrapper, never a bare env toggle).

import test from "node:test";
import assert from "node:assert/strict";
import { ctoListSessions, ctoSearch, ctoAround, CTO_CONTEXT_LIMITS } from "./ctoContext.mjs";
import { _resetDbHandle, _setSqliteModuleOverride } from "./opencodeDb.mjs";
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

// The serialized contract: the WHOLE response — every returned text field
// (snippets, titles, directories, tool names), not just the fields the
// implementation happens to charge — must stay within the 24 KiB call budget.
function serializedBytes(res) {
  return new TextEncoder().encode(JSON.stringify(res)).length;
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
    { id: "p_decision", messageId: "mc2", sessionId: "s_child", timeCreated: T + 410, data: { type: "text", text: 'decision: use lease-based locking; path C:\\store\\db; she said "lease it"' } },
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
    // workspace value, distinct; the mapping is explicitly unmapped and no
    // checkout/repo semantics are inferred (revised P0 map: id derivation
    // UNVERIFIED).
    assert.equal(child.projectId, "prj_a");
    assert.equal(child.workspaceId, "ws_a");
    assert.equal(child.projectMapping, "unmapped");
    assert.equal(child.title, "child worker");
    assert.equal(child.directory, "/repo-a");
    for (const s of res.sessions) assert.equal(s.projectMapping, "unmapped");
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "serialized response stays within the 24 KiB budget");
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

test("listSessions: huge titles/directories are bounded on the SERIALIZED response — cuts flagged, IDs intact", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const huge = Array.from({ length: 30 }, (_, i) => ({
    id: `s_huge${i}`,
    projectId: "prj_a",
    directory: `/repo-a/very/long/path/${i}`,
    title: `huge title ${i} ${"t".repeat(3000)}`,
    timeCreated: T + i,
    timeUpdated: T + 3000 - i,
  }));
  await withFixture({ sessions: huge, messages: [], parts: [] }, async () => {
    const res = await ctoListSessions({ limit: CTO_CONTEXT_LIMITS.sessionsMax });
    assert.equal(res.status, "ok");
    assert.equal(res.truncated, true, "budget bounds must set the aggregate truncation flag");
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
    for (const s of res.sessions) {
      assert.ok(s.id, "emitted sessions always keep their stable id");
      if (s.titleTruncated) {
        assert.ok(s.titleSourceBytes > 3000, "omitted-size metadata names the full title");
      }
    }
    assert.ok(res.sessions.some((s) => s.titleTruncated), "oversized titles are bounded, not silently passed through");
  });
});

test("listSessions: an escape-heavy 30000-newline FIRST title is bounded (or skipped with a continuing cursor) — older sessions stay reachable", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // The first (newest) session's title is escape-heavy: JSON stringify
  // expands every newline to \n, so a naive raw-byte trim cannot make the
  // serialized response fit. The old parallel accounting failed to trim it,
  // broke the walk with an empty page + null cursor and hid everything older.
  const huge = { id: "s_nl", projectId: "prj_a", directory: "/repo-a", title: "\n".repeat(30000), timeCreated: T + 100, timeUpdated: T + 100 };
  const older = Array.from({ length: 5 }, (_, i) => ({
    id: `s_old${i}`,
    projectId: "prj_a",
    directory: "/repo-a",
    title: `older session ${i}`,
    timeCreated: T + i,
    timeUpdated: T + 90 - i,
  }));
  await withFixture({ sessions: [huge, ...older], messages: [], parts: [] }, async () => {
    const page1 = await ctoListSessions({ limit: CTO_CONTEXT_LIMITS.sessionsMax });
    assert.equal(page1.status, "ok");
    assert.ok(serializedBytes(page1) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
    assert.equal(page1.truncated, true, "bounding the escape-heavy title is reported");
    const bounded = page1.sessions.find((s) => s.id === "s_nl");
    assert.ok(bounded, "the oversized first item is RETURNED bounded, not dropped");
    assert.equal(bounded.titleTruncated, true, "the escape-heavy title is bounded with omitted-size metadata");
    assert.ok(bounded.titleSourceBytes >= 30000, "omitted-size metadata names the full title");
    // Guaranteed reachability: whatever the page kept or skipped, a cursor
    // walk must surface ALL older sessions (here they fit beside the bounded
    // item; if they had not, the cursor would continue the walk).
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const res = await ctoListSessions({ limit: CTO_CONTEXT_LIMITS.sessionsMax, cursor });
      for (const s of res.sessions) seen.add(s.id);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    for (let i = 0; i < 5; i++) assert.ok(seen.has(`s_old${i}`), "all older sessions are reachable past the oversized item");
  });
});

test("around: 40 normal 1000-char messages stay within the serialized budget — markers and record overhead counted", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const messages = Array.from({ length: 45 }, (_, i) => ({ id: `mk${i}`, sessionId: "s_k", timeCreated: T + i, data: { role: "assistant" } }));
  const parts = messages.map((m) => ({ id: `pk_${m.id}`, messageId: m.id, sessionId: "s_k", timeCreated: m.timeCreated, data: { type: "text", text: `evidence ${m.id} ${"e".repeat(1000)}` } }));
  await withFixture(
    { sessions: [{ id: "s_k", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }], messages, parts },
    async () => {
      const res = await ctoAround({ sessionId: "s_k", messageId: "mk20", before: 9999, after: 9999 });
      assert.equal(res.status, "ok");
      assert.equal(res.messages.length, CTO_CONTEXT_LIMITS.aroundMessagesMax, "the 40-message cap includes the anchor");
      assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response (all markers + record overhead) must stay within 24 KiB");
      assert.equal(res.truncated, true, "bounding to fit the budget is reported");
      const anchorMsg = res.messages.find((m) => m.anchor === true);
      assert.equal(anchorMsg.id, "mk20");
      assert.ok(anchorMsg.parts.length >= 1, "the anchor keeps its evidence");
    },
  );
});

test("search: serializer-independent decoded matching — raw JSON \\u00e9, escaped solidus and surrogate pairs are reachable", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // Seed rows whose stored data is NOT what JSON.stringify would produce:
  // a different serializer may emit \uXXXX escapes, escaped solidi or
  // surrogate pairs. The old raw/dual LIKE missed all of them.
  const fixture = await createFixtureDb({
    sessions: [{ id: "s_raw", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
    messages: [
      { id: "m_e", sessionId: "s_raw", timeCreated: T, data: { role: "assistant" } },
      { id: "m_s", sessionId: "s_raw", timeCreated: T + 1, data: { role: "assistant" } },
      { id: "m_u", sessionId: "s_raw", timeCreated: T + 2, data: { role: "assistant" } },
    ],
    parts: [],
  });
  try {
    // Direct raw inserts (verbatim stored bytes — bypass the fixture's
    // JSON.stringify so the escape forms differ from it).
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_cafe", "m_e", "s_raw", T, T, '{"type":"text","text":"caf\\u00e9 finding"}',
      );
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_slash", "m_s", "s_raw", T + 1, T + 1, '{"type":"text","text":"path a\\/b piece"}',
      );
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_surr", "m_u", "s_raw", T + 2, T + 2, '{"type":"tool","tool":"bash","state":{"status":"completed","output":"logo \\ud83d\\ude00 done"}}',
      );
    } finally {
      raw.close();
    }
    const { withFixtureDb } = await import("./fixtures/opencodeDbFixture.mjs");
    await withFixtureDb(fixture, async () => {
      const cafe = await ctoSearch({ query: "café" });
      assert.equal(cafe.hits.length, 1, "a \\u00e9-escaped store must match the decoded query");
      assert.equal(cafe.hits[0].partId, "p_cafe");
      const slash = await ctoSearch({ query: "a/b" });
      assert.equal(slash.hits.length, 1, "an escaped-solidus store must match the decoded query");
      assert.equal(slash.hits[0].partId, "p_slash");
      const surr = await ctoSearch({ query: "\u{1F600} done" });
      assert.equal(surr.hits.length, 1, "a surrogate-pair-escaped store must match the decoded query");
      assert.equal(surr.hits[0].partId, "p_surr");
      assert.equal(surr.hits[0].tool.matchedField, "output");
    });
  } finally {
    fixture.close();
  }
});

test("around: a partId anchor reaches evidence beyond the first bounded part read — the search-hit contract", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // 60 parts; the DECISIVE 51st is a tool result. The bounded first read
  // (50) must not make that hit's evidence unreachable via around.
  const messages = [{ id: "m_deep", sessionId: "s_deep", timeCreated: T, data: { role: "assistant" } }];
  const parts = Array.from({ length: 60 }, (_, i) => ({
    id: `p_deep${String(i).padStart(2, "0")}`,
    messageId: "m_deep",
    sessionId: "s_deep",
    timeCreated: T + i,
    data: i === 50
      ? { type: "tool", tool: "bash", state: { status: "completed", input: { command: "verify" }, output: "decisive result 51" } }
      : { type: "text", text: `filler part ${i}` },
  }));
  await withFixture(
    { sessions: [{ id: "s_deep", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }], messages, parts },
    async () => {
      // The search hit exists and names the part beyond the first read.
      const hit = await ctoSearch({ query: "decisive result 51", sessionId: "s_deep" });
      assert.equal(hit.hits.length, 1);
      assert.equal(hit.hits[0].partId, "p_deep50");

      // WITHOUT the partId anchor: the first bounded read caps at 50 and
      // reports the omission (the gap this contract closes).
      const plain = await ctoAround({ sessionId: "s_deep", messageId: "m_deep", before: 0, after: 0 });
      assert.equal(plain.messages[0].partsOmitted, true);
      assert.ok(!plain.messages[0].parts.some((p) => p.partId === "p_deep50"), "the 51st part is genuinely beyond the plain bounded read");

      // WITH the partId anchor: the decisive tool result is retrievable,
      // centered, without loading all 60 parts.
      const anchored = await ctoAround({ sessionId: "s_deep", messageId: "m_deep", partId: "p_deep50", before: 0, after: 0 });
      assert.equal(anchored.status, "ok");
      assert.equal(anchored.session.anchorPartId, "p_deep50");
      const decisive = anchored.messages[0].parts.find((p) => p.partId === "p_deep50");
      assert.ok(decisive, "the hit's evidence is fetchable across the part boundary");
      assert.match(decisive.text, /decisive result 51/);
      assert.equal(decisive.tool.name, "bash");
      assert.ok(anchored.messages[0].parts.length <= CTO_CONTEXT_LIMITS.partsPerMessageMax);

      // Unknown part reference is honest.
      const missing = await ctoAround({ sessionId: "s_deep", messageId: "m_deep", partId: "p_nope" });
      assert.equal(missing.status, "reference_expired");
      assert.match(missing.detail, /part p_nope not found/);
    },
  );
});

// ---------------------------------------------------------------------------
// Search: closed-child hit (U03), tool evidence (U05), decoded-evidence
// matching, limits, cursors, budget
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

test("search: decoded evidence with quotes/backslashes/newlines stays reachable — the raw-JSON-only LIKE must not exclude it", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // opencode stores JSON; a Windows path is raw-stored as C:\\Users\\... and
  // a quote as \". The raw-only LIKE pattern (real backslash/quote) missed
  // those — candidate selection must also try the JSON-escaped query form.
  await withFixture(seedRows(), async () => {
    const winPath = await ctoSearch({ query: "C:\\store\\db" });
    assert.equal(winPath.status, "ok");
    assert.equal(winPath.hits.length, 1, "the Windows path literal must match its JSON-escaped storage");
    assert.equal(winPath.hits[0].partId, "p_decision");
    const quoted = await ctoSearch({ query: 'she said "lease it"' });
    assert.equal(quoted.hits.length, 1, "a quoted phrase must match its JSON-escaped storage");
    assert.equal(quoted.hits[0].partId, "p_decision");
  });
  const nlSeed = {
    sessions: [{ id: "s_nl", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
    messages: [{ id: "m_nl", sessionId: "s_nl", timeCreated: T, data: { role: "assistant" } }],
    parts: [{ id: "p_nl", messageId: "m_nl", sessionId: "s_nl", timeCreated: T, data: { type: "text", text: "line1\nline2 secret" } }],
  };
  await withFixture(nlSeed, async () => {
    const res = await ctoSearch({ query: "line1\nline2" });
    assert.equal(res.hits.length, 1, "a query containing a real newline must match its JSON-escaped storage");
    assert.equal(res.hits[0].partId, "p_nl");
  });
});

test("search: a scan window FULL of discarded candidates advances the cursor and never hides older matches", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // 800 synthetic parts LIKE-match the raw JSON but are dropped by the
  // decoded-candidate filter (synthetic) — the OLD code returned
  // {hits:[], truncated:false, nextCursor:null} and the real older match
  // below the scan cap was unreachable forever.
  const synthMessages = Array.from({ length: 800 }, (_, i) => ({ id: `msyn${i}`, sessionId: "s_child", timeCreated: T + 10000 - i, data: { role: "assistant" } }));
  const synthParts = synthMessages.map((m, i) => ({
    id: `psyn${i}`,
    messageId: m.id,
    sessionId: "s_child",
    timeCreated: T + 10000 - i,
    data: { type: "text", synthetic: true, text: `synthetic needle ${i}` },
  }));
  const realMessage = { id: "m_real", sessionId: "s_child", timeCreated: T, data: { role: "assistant" } };
  const realPart = { id: "p_real", messageId: "m_real", sessionId: "s_child", timeCreated: T, data: { type: "text", text: "the real older needle match" } };
  await withFixture(
    {
      sessions: [{ id: "s_child", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
      messages: [...synthMessages, realMessage],
      parts: [...synthParts, realPart],
    },
    async () => {
      const page1 = await ctoSearch({ query: "needle", sessionId: "s_child" });
      assert.equal(page1.status, "ok");
      assert.deepEqual(page1.hits, [], "all 800 scanned candidates are discarded by the decoded filter");
      assert.equal(page1.truncated, true, "a full scan window must be reported as cut, never a false clean end");
      assert.ok(page1.nextCursor, "the cursor must advance past the last CONSUMED candidate");
      const page2 = await ctoSearch({ query: "needle", sessionId: "s_child", cursor: page1.nextCursor });
      assert.equal(page2.hits.length, 1, "the older real match becomes reachable");
      assert.equal(page2.hits[0].partId, "p_real");
      assert.equal(page2.nextCursor, null, "the source is exhausted after it");
    },
  );
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
    const cut = res.hits.find((h) => h.matchTruncated === true);
    assert.ok(cut, "a snippet that does not fit the call budget must be cut and reported");
    assert.equal(cut.tool.matchedField, "output");
    assert.equal(cut.matchSourceBytes, 7000, "omitted-size metadata names the FULL matched field");
    assert.ok(cut.sessionId && cut.messageId && cut.partId, "cut hits keep their stable IDs");
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
    assert.equal(res.truncated, true, "a cut sets the aggregate truncation flag");
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
      assert.ok(serializedBytes(h) < 600, "every emitted hit stays bounded (window + fields)");
      assert.ok(h.sessionId && h.messageId && h.partId, "stable IDs intact");
    }
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
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
    // 3+3+1 hits — the third page scans fewer rows than the window cap, so
    // the source is provably exhausted and the walk ends without an extra
    // terminal empty page.
    assert.equal(pages, 3);
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
// around: exact neighborhood, stable IDs, per-part + global budget, bounded
// part reads, zero-valid before/after, 40-message cap INCLUDING the anchor
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
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes);
  });
});

test("around: before/after ZERO is valid (anchor only) and the 40-message cap INCLUDES the anchor", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withFixture(seedRows(), async () => {
    const zero = await ctoAround({ sessionId: "s_child", messageId: "mc2", before: 0, after: 0 });
    assert.equal(zero.status, "ok");
    assert.deepEqual(zero.messages.map((m) => m.id), ["mc2"], "zero neighbors = exactly the anchor, not the default 5");
    assert.equal(zero.truncated, false);

    const oneSide = await ctoAround({ sessionId: "s_child", messageId: "mc2", before: 0, after: 2 });
    assert.deepEqual(oneSide.messages.map((m) => m.id), ["mc2", "mc3", "mbig0"], "after:0-adjacent asymmetry honored");

    // A session with 50 messages: over-asking must fill exactly 40
    // (39 neighbors + the anchor — the cap INCLUDES the anchor).
    const wideMessages = Array.from({ length: 50 }, (_, i) => ({ id: `mw${i}`, sessionId: "s_wide", timeCreated: T + i, data: { role: "assistant" } }));
    const wideParts = wideMessages.map((m) => ({ id: `pw_${m.id}`, messageId: m.id, sessionId: "s_wide", timeCreated: m.timeCreated, data: { type: "text", text: `msg ${m.id}` } }));
    await withFixture(
      { sessions: [{ id: "s_wide", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }], messages: wideMessages, parts: wideParts },
      async () => {
        const clamped = await ctoAround({ sessionId: "s_wide", messageId: "mw25", before: 9999, after: 9999 });
        assert.ok(clamped.messages.length <= CTO_CONTEXT_LIMITS.aroundMessagesMax, "the 40-message cap includes the anchor");
        assert.equal(clamped.messages.length, CTO_CONTEXT_LIMITS.aroundMessagesMax, "over-asking fills exactly 40 (39 neighbors + anchor)");
        assert.equal(clamped.messages.filter((m) => m.anchor).length, 1, "the anchor is one of the 40");
        assert.equal(clamped.messages.map((m) => m.id)[0], "mw0", "neighbors reach back to the session start");
        const beforeCount = clamped.messages.filter((m) => Number(m.id.slice(2)) < 25).length;
        const afterCount = clamped.messages.filter((m) => Number(m.id.slice(2)) > 25).length;
        assert.equal(beforeCount, 25, "all available before-neighbors used");
        assert.equal(afterCount, 14, "after absorbs the slack up to the 40 total");
      },
    );
  });
});

test("around: a MB tool output is cut per part with omitted-size metadata, part reads are bounded, and the global budget drops the tail honestly", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const encoder = new TextEncoder();
  // (a) The seeded 7 KiB outputs exceed the global 24 KiB budget — the tail
  // of the neighborhood is dropped and counted, the anchor survives.
  await withFixture(seedRows(), async () => {
    const res = await ctoAround({ sessionId: "s_child", messageId: "mc2", before: 0, after: 8 });
    assert.equal(res.status, "ok");
    assert.equal(res.truncated, true, "huge outputs exceed the 24 KiB call budget — bounding is reported");
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes);
    assert.ok(res.messages.every((m) => Array.isArray(m.parts)), "every message keeps its stable id and a parts array");
    // Every message keeps its stable ID even when its evidence was dropped;
    // the anchor's own evidence survives (budget priority).
    assert.ok(res.messages.every((m) => Array.isArray(m.parts)));
    const anchorMsg = res.messages.find((m) => m.anchor === true);
    assert.match(anchorMsg.parts[0].text, /lease-based locking/);
    const bigCut = res.messages.flatMap((m) => m.parts).find((p) => p.textTruncated === true && p.textSourceBytes === 7000);
    assert.ok(bigCut, "the big outputs were bounded with omitted-size metadata naming the full field");
    assert.match(anchorMsg.parts[0].text, /lease-based locking/, "the anchor keeps its evidence (budget priority)");
    assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
  });
  // (b) A MB tool output (per-part cap) and a 60-part message (bounded part
  // read) in a dedicated session, so the budget cannot exhaust first.
  const mbPart = { id: "p_mb", messageId: "m_mb", sessionId: "s_mb", timeCreated: T, data: { type: "tool", tool: "bash", state: { status: "completed", output: bigOutput(1_000_000) } } };
  const manyParts = Array.from({ length: 60 }, (_, i) => ({ id: `p_many${i}`, messageId: "m_many", sessionId: "s_mb", timeCreated: T + 10, data: { type: "text", text: `part ${i} of many` } }));
  await withFixture(
    {
      sessions: [{ id: "s_mb", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
      messages: [
        { id: "m_mb", sessionId: "s_mb", timeCreated: T, data: { role: "assistant" } },
        { id: "m_many", sessionId: "s_mb", timeCreated: T + 10, data: { role: "assistant" } },
      ],
      parts: [mbPart, ...manyParts],
    },
    async () => {
      const res = await ctoAround({ sessionId: "s_mb", messageId: "m_mb", before: 0, after: 1 });
      assert.equal(res.status, "ok");
      // MB output: per-part cap with honest omitted-size metadata.
      const mbItem = res.messages[0].parts[0];
      assert.equal(mbItem.partId, "p_mb");
      assert.equal(mbItem.textTruncated, true);
      assert.equal(mbItem.textSourceBytes, 1_000_000);
      assert.ok(encoder.encode(mbItem.text).length <= CTO_CONTEXT_LIMITS.partEvidenceMaxBytes);
      // Many parts: the per-message part read is bounded and reported.
      const manyMsg = res.messages[1];
      assert.equal(manyMsg.id, "m_many");
      assert.equal(manyMsg.partsOmitted, true, "a part read past the bound is reported, not silently dropped");
      assert.ok(manyMsg.parts.length <= CTO_CONTEXT_LIMITS.partsPerMessageMax);
      assert.equal(res.truncated, true);
      assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
    },
  );
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

test("around: compaction removes the INTENDED records — the requested anchor message AND part survive (8x50 repro)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // 8 messages x 50 tool parts each; the request anchors the LAST message's
  // LAST part. The old pop-by-position callbacks removed the anchor message
  // while compacting an earlier one (only m0-m3 came back, no anchor).
  const messages = Array.from({ length: 8 }, (_, i) => ({ id: `mr${i}`, sessionId: "s_r", timeCreated: T + i, data: { role: "assistant" } }));
  const parts = messages.flatMap((m) =>
    Array.from({ length: 50 }, (_, j) => ({
      id: `pr_${m.id}_${String(j).padStart(2, "0")}`,
      messageId: m.id,
      sessionId: "s_r",
      timeCreated: m.timeCreated * 1000 + j,
      data: { type: "tool", tool: "bash", state: { status: "completed", output: `tool ${m.id}.${j} ` + "o".repeat(100) } },
    })),
  );
  await withFixture(
    { sessions: [{ id: "s_r", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }], messages, parts },
    async () => {
      const requestedPart = "pr_mr7_49";
      const res = await ctoAround({ sessionId: "s_r", messageId: "mr7", partId: requestedPart });
      assert.equal(res.status, "ok");
      assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
      assert.equal(res.truncated, true, "compaction happened and is reported");
      const anchorMsg = res.messages.find((m) => m.id === "mr7");
      assert.ok(anchorMsg, "the ANCHOR message must survive compaction");
      assert.equal(anchorMsg.anchor, true);
      const requested = anchorMsg.parts.find((p) => p.partId === requestedPart);
      assert.ok(requested, "the REQUESTED part evidence must never be omitted");
      assert.match(requested.text, /tool mr7\.49/);
      for (const m of res.messages) {
        assert.ok(m.id, "every returned message keeps a stable id");
        const ids = new Set(res.messages.map((x) => x.id));
        assert.equal(ids.size, res.messages.length, "no duplicated messages");
      }
    },
  );
});

test("search: object-shaped state.input with alternate stored serializer escapes is reachable — nested cafe and Windows path", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // state.input is an OBJECT; the stored bytes use escape forms
  // JSON.stringify never emits. json_extract on '$.state.input' returned the
  // object's JSON text (escapes intact) and missed these; json_tree walks
  // the DECODED scalar atoms instead, and the JS candidates align.
  const fixture = await createFixtureDb({
    sessions: [{ id: "s_obj", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
    messages: [
      { id: "m_cafe", sessionId: "s_obj", timeCreated: T, data: { role: "assistant" } },
      { id: "m_path", sessionId: "s_obj", timeCreated: T + 1, data: { role: "assistant" } },
    ],
    parts: [],
  });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_objcafe", "m_cafe", "s_obj", T, T,
        '{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"deploy caf\\u00e9 now"}}}',
      );
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_objpath", "m_path", "s_obj", T + 1, T + 1,
        '{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"robocopy C:\\\\Users\\\\dev"}}}',
      );
    } finally {
      raw.close();
    }
    const { withFixtureDb } = await import("./fixtures/opencodeDbFixture.mjs");
    await withFixtureDb(fixture, async () => {
      const cafe = await ctoSearch({ query: "café" });
      assert.equal(cafe.hits.length, 1, "a nested \u00e9-escaped object input must match the decoded query");
      assert.equal(cafe.hits[0].partId, "p_objcafe");
      assert.equal(cafe.hits[0].tool.matchedField, "input");
      assert.match(cafe.hits[0].snippet.match, /café/);
      const path = await ctoSearch({ query: "C:\\Users\\dev" });
      assert.equal(path.hits.length, 1, "a nested Windows path in an object input must match the decoded query");
      assert.equal(path.hits[0].partId, "p_objpath");
      assert.equal(path.hits[0].tool.matchedField, "input");
    });
  } finally {
    fixture.close();
  }
});

test("around: a single MB output propagates its per-part cut to the aggregate truncated flag", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const f = await (async () => {
    const fixture = await createFixtureDb({
      sessions: [{ id: "s_one", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
      messages: [{ id: "m_one", sessionId: "s_one", timeCreated: T, data: { role: "assistant" } }],
      parts: [{ id: "p_one", messageId: "m_one", sessionId: "s_one", timeCreated: T, data: { type: "tool", tool: "bash", state: { status: "completed", output: bigOutput(1_000_000) } } }],
    });
    return fixture;
  })();
  try {
    const { withFixtureDb } = await import("./fixtures/opencodeDbFixture.mjs");
    await withFixtureDb(f, async () => {
      const res = await ctoAround({ sessionId: "s_one", messageId: "m_one", before: 0, after: 0 });
      assert.equal(res.status, "ok");
      const item = res.messages[0].parts[0];
      assert.equal(item.textTruncated, true, "the per-part cap flagged the item");
      assert.equal(item.textSourceBytes, 1_000_000);
      assert.equal(res.truncated, true, "the item-level cut MUST propagate to the aggregate flag — no early return may hide it");
      assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes);
    });
  } finally {
    f.close();
  }
});

test("search: the matched atom comes from SQL json_tree — hits beyond every JS traversal cap and at depth stay reachable", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // state.input = object with 32 filler scalars and the DECISIVE 33rd: the
  // old capped JS traversal (32 scalars / 64 nodes / depth 4) dropped the
  // row after the SQL selected it — cursor advanced, walk exhausted, no hit.
  const input = {};
  for (let i = 0; i < 32; i++) input[`filler${i}`] = `filler ${i}`;
  input.decisive = "the decisive thirty third scalar";
  // A second part with the match 6 levels deep (beyond the old depth cap).
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: "deeply nested decisive token" } } } } } };
  const messages = [
    { id: "m_cap", sessionId: "s_cap", timeCreated: T, data: { role: "assistant" } },
    { id: "m_deep", sessionId: "s_cap", timeCreated: T + 1, data: { role: "assistant" } },
  ];
  const parts = [
    { id: "p_cap", messageId: "m_cap", sessionId: "s_cap", timeCreated: T, data: { type: "tool", tool: "bash", state: { status: "completed", input } } },
    { id: "p_deep", messageId: "m_deep", sessionId: "s_cap", timeCreated: T + 1, data: { type: "tool", tool: "bash", state: { status: "completed", input: deep } } },
  ];
  await withFixture(
    { sessions: [{ id: "s_cap", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }], messages, parts },
    async () => {
      const res = await ctoSearch({ query: "the decisive thirty third scalar" });
      assert.equal(res.status, "ok");
      assert.equal(res.hits.length, 1, "the true hit beyond every cap is found on this page — no cursor-then-exhaustion");
      assert.equal(res.hits[0].partId, "p_cap");
      assert.equal(res.hits[0].tool.matchedField, "input", "the candidate evidence stays tied to its part+field");
      assert.match(res.hits[0].snippet.match, /thirty third/);
      const deepRes = await ctoSearch({ query: "deeply nested decisive token" });
      assert.equal(deepRes.hits.length, 1, "a match beyond the old depth cap is reachable");
      assert.equal(deepRes.hits[0].partId, "p_deep");
      assert.equal(deepRes.hits[0].tool.matchedField, "input");
    },
  );
});

test("around: protected anchor text is trimmed only AFTER neighbors are relieved — the exact decisive tail survives", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // Anchor part = 5988 bytes ending in an exact decisive tail; 25 neighbor
  // messages with 650-byte parts each. The old largest-field-first pass cut
  // the PROTECTED anchor while every neighbor stayed whole. Now: protected
  // fields are excluded from every non-final pass, so a neighbor shrink
  // satisfying the budget leaves the anchor's exact tail untouched.
  const tail = "DECISIVE-TAIL-MARKER";
  const anchorText = "A".repeat(5988 - tail.length) + tail;
  const messages = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: `mn${i}`, sessionId: "s_tail", timeCreated: T + i, data: { role: "assistant" } })),
    { id: "m_anchor", sessionId: "s_tail", timeCreated: T + 100, data: { role: "assistant" } },
  ];
  const parts = [
    ...messages.filter((m) => m.id !== "m_anchor").map((m) => ({ id: `pn_${m.id}`, messageId: m.id, sessionId: "s_tail", timeCreated: m.timeCreated, data: { type: "text", text: `neighbor ${m.id} ` + "n".repeat(636) } })),
    { id: "p_anchor", messageId: "m_anchor", sessionId: "s_tail", timeCreated: T + 100, data: { type: "text", text: anchorText } },
  ];
  await withFixture(
    { sessions: [{ id: "s_tail", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }], messages, parts },
    async () => {
      const res = await ctoAround({ sessionId: "s_tail", messageId: "m_anchor", partId: "p_anchor", before: 25, after: 0 });
      assert.equal(res.status, "ok");
      assert.ok(serializedBytes(res) <= CTO_CONTEXT_LIMITS.textBudgetBytes, "the ACTUAL serialized response must stay within 24 KiB");
      const anchorMsg = res.messages.find((m) => m.id === "m_anchor");
      assert.ok(anchorMsg, "the anchor message survives");
      const anchorPart = anchorMsg.parts.find((p) => p.partId === "p_anchor");
      assert.ok(anchorPart, "the requested part evidence is never omitted");
      assert.equal(anchorPart.text.length, 5988, "the anchor text is untouched — neighbor shrink satisfied the budget");
      assert.ok(anchorPart.text.endsWith(tail), "the exact decisive tail is preserved");
      assert.equal(res.truncated, true, "the neighbor bounding is reported");
      const relieved = res.messages.flatMap((m) => m.parts).some((p) => p.textTruncated === true && p.partId !== "p_anchor");
      assert.ok(relieved, "neighbors were relieved (bounded) instead of the anchor");
    },
  );
});

test("search: eligibility restricts atoms BEFORE first-pick — metadata, reasoning, inputSummary never shadow the real evidence", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const fixture = await createFixtureDb({
    sessions: [{ id: "s_elig", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
    messages: [
      { id: "m_txtmeta", sessionId: "s_elig", timeCreated: T, data: { role: "assistant" } },
      { id: "m_reason", sessionId: "s_elig", timeCreated: T + 1, data: { role: "assistant" } },
      { id: "m_shadow", sessionId: "s_elig", timeCreated: T + 2, data: { role: "assistant" } },
      { id: "m_summary", sessionId: "s_elig", timeCreated: T + 3, data: { role: "assistant" } },
    ],
    parts: [],
  });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      // Text part: the query ONLY in a metadata field — not eligible.
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_txtmeta", "m_txtmeta", "s_elig", T, T,
        '{"type":"text","text":"nothing relevant here","metadata":{"notes":"metadatum-only token"}}',
      );
      // Reasoning part: its text is not an eligible atom class.
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_reason", "m_reason", "s_elig", T + 1, T + 1,
        '{"type":"reasoning","text":"reasoner muses about reasoning-only token"}',
      );
      // Tool part: state.metadata.output (a streaming transient) sits BEFORE
      // state.output in document order and shares a term with it — the pick
      // must be the REAL output atom, never the metadata shadow.
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_shadow", "m_shadow", "s_elig", T + 2, T + 2,
        '{"type":"tool","tool":"bash","state":{"status":"completed","metadata":{"output":"claims shadowed done"},"output":"the real output done"}}',
      );
      // Tool part: state.inputSummary is NOT a descendant of state.input.
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_summary", "m_summary", "s_elig", T + 3, T + 3,
        '{"type":"tool","tool":"bash","state":{"status":"completed","inputSummary":"summary-only token","input":{"command":"npm test"}}}',
      );
    } finally {
      raw.close();
    }
    const { withFixtureDb } = await import("./fixtures/opencodeDbFixture.mjs");
    await withFixtureDb(fixture, async () => {
      const txtmeta = await ctoSearch({ query: "metadatum-only token" });
      assert.deepEqual(txtmeta.hits, [], "text-part metadata atoms are not eligible — no hit");
      const reason = await ctoSearch({ query: "reasoning-only token" });
      assert.deepEqual(reason.hits, [], "reasoning parts are not eligible — no hit");
      const shared = await ctoSearch({ query: "done" });
      assert.equal(shared.hits.length, 1, "the tool part is found via its REAL output");
      assert.equal(shared.hits[0].partId, "p_shadow");
      assert.equal(shared.hits[0].tool.matchedField, "output", "the metadata atom never shadows the legitimate output");
      assert.match(shared.hits[0].snippet.match, /done/);
      assert.match(shared.hits[0].snippet.pre + shared.hits[0].snippet.match, /real output/, "the snippet comes from state.output, not the metadata");
      const shadowOnly = await ctoSearch({ query: "shadowed" });
      assert.deepEqual(shadowOnly.hits, [], "a term only in state.metadata.output is not searchable — declared non-eligible");
      const summary = await ctoSearch({ query: "summary-only token" });
      assert.deepEqual(summary.hits, [], "inputSummary is not a descendant of state.input — no hit");
      const legit = await ctoSearch({ query: "npm test", sessionId: "s_elig" });
      assert.equal(legit.hits.length, 1, "the legitimate input remains reachable");
      assert.equal(legit.hits[0].partId, "p_summary");
      assert.equal(legit.hits[0].tool.matchedField, "input");
    });
  } finally {
    fixture.close();
  }
});

test("search: descendant eligibility needs the exact prefix AND the boundary — a same-offset decoy never shadows the real output", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // $.metadata.xy.note has '.' at the SAME offset where $.state.input's
  // boundary would sit — a boundary-only check accepts it as an "input"
  // descendant. The decoy sits BEFORE the real output in document order, so
  // it would shadow it; alone, it would fabricate a hit.
  const fixture = await createFixtureDb({
    sessions: [{ id: "s_decoy", projectId: "prj_a", directory: "/repo-a", timeUpdated: T }],
    messages: [
      { id: "m_decoy", sessionId: "s_decoy", timeCreated: T, data: { role: "assistant" } },
      { id: "m_real", sessionId: "s_decoy", timeCreated: T + 1, data: { role: "assistant" } },
    ],
    parts: [],
  });
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_decoy", "m_decoy", "s_decoy", T, T,
        '{"type":"tool","tool":"bash","state":{"status":"completed","metadata":{"xy":{"note":"decoy-only token"}},"output":"nothing relevant"}}',
      );
      raw.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "p_real", "m_real", "s_decoy", T + 1, T + 1,
        '{"type":"tool","tool":"bash","state":{"status":"completed","metadata":{"xy":{"note":"shared done decoy"}},"output":"the real output done"}}',
      );
    } finally {
      raw.close();
    }
    const { withFixtureDb } = await import("./fixtures/opencodeDbFixture.mjs");
    await withFixtureDb(fixture, async () => {
      const alone = await ctoSearch({ query: "decoy-only token" });
      assert.deepEqual(alone.hits, [], "the same-offset decoy is not an eligible input descendant — no hit");
      const shared = await ctoSearch({ query: "done" });
      assert.equal(shared.hits.length, 1, "the part is found via its REAL output");
      assert.equal(shared.hits[0].partId, "p_real");
      assert.equal(shared.hits[0].tool.matchedField, "output", "the decoy atom never shadows the legitimate output");
      assert.match(shared.hits[0].snippet.pre + shared.hits[0].snippet.match, /real output/, "the snippet comes from state.output, not the decoy");
    });
  } finally {
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// Honest degradation + zero side effects
// ---------------------------------------------------------------------------

test("degradation: a missing source answers exactly source_unavailable on a sqlite runtime, never throws", async (t) => {
  if (!hasSqlite) return t.skip("meaningful only when node:sqlite exists (otherwise the same call is genuinely unsupported)");
  const prevDb = process.env.MANTA_OPENCODE_DB;
  _resetDbHandle();
  try {
    process.env.MANTA_OPENCODE_DB = "/nonexistent/cto-p1a/opencode.db";
    _resetDbHandle();
    const res = await ctoListSessions({});
    assert.equal(res.supported, false);
    assert.equal(res.status, "source_unavailable", "a missing DB file is source_unavailable, distinct from unsupported");
    assert.deepEqual(res.sessions, []);
    const search = await ctoSearch({ query: "x" });
    assert.equal(search.status, "source_unavailable");
    const around = await ctoAround({ sessionId: "s", messageId: "m" });
    assert.equal(around.status, "source_unavailable");
  } finally {
    if (prevDb === undefined) delete process.env.MANTA_OPENCODE_DB;
    else process.env.MANTA_OPENCODE_DB = prevDb;
    _resetDbHandle();
  }
});

test("degradation: a runtime without node:sqlite answers exactly unsupported — never collapsed into source_unavailable", async (t) => {
  // Simulated via the accessor's test seam (__importError): deterministic on
  // a runtime that HAS node:sqlite, and identical to the real Node 20 path.
  const prevDb = process.env.MANTA_OPENCODE_DB;
  _resetDbHandle();
  _setSqliteModuleOverride({ __importError: new Error("Cannot find module 'node:sqlite' (simulated Node 20)") });
  try {
    process.env.MANTA_OPENCODE_DB = "/nonexistent/cto-p1a/opencode.db";
    _resetDbHandle();
    const res = await ctoListSessions({});
    assert.equal(res.supported, false);
    assert.equal(res.status, "unsupported", "no node:sqlite is unsupported even when the DB path is also missing");
    assert.match(res.detail, /node:sqlite/);
    const search = await ctoSearch({ query: "x" });
    assert.equal(search.status, "unsupported");
    const around = await ctoAround({ sessionId: "s", messageId: "m" });
    assert.equal(around.status, "unsupported");
  } finally {
    _setSqliteModuleOverride(null);
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
