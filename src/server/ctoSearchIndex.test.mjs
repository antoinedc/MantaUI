// ctoSearchIndex.test.mjs — P1b1 acceptance tests for the passive FTS5 search
// index (unified-CTO spec §4.1/§4.3, contract-only; no tool/UI/poller wiring
// is asserted to exist).
//
// Pinned behaviors:
//   1. sync indexes eligible evidence (text + tool name/input/output) from
//      the READ-ONLY source; closed (archived) and child sessions are kept;
//      reasoning/synthetic/metadata are never evidence; hits are ranked
//      (bm25) and enriched with role/provenance.
//   2. An edited part row (moving source time_updated) is RE-indexed: the
//      stale term is gone, the new term is found, no duplicate rows.
//   3. Deletion reconciles boundedly (bounded sample per sync; no full scan).
//   4. A failed batch (fault inside the transaction) leaves the persisted
//      cursor AND the index untouched; the next sync completes.
//   5. A "restart" (handle closed, cursor re-read from disk) resumes the
//      incremental walk instead of reindexing from zero.
//   6. Internal-ephemeral exclusion comes from the injected provenance seam
//      (established registry IDs, never titles); excluded by default,
//      includable explicitly; a failing registry fails the batch CLOSED.
//   7. A corrupt index file is detected and REBUILT (disposable); the source
//      is never mutated by indexing, searching, or recovery; no fetch calls
//      are observed on the sync/search paths.
//   8. Query policy: literal terms (see ftsQuery.mjs) — FTS5 metacharacters
//      and `*` never act as operators; unicode/punctuation queries are
//      honest (no hits, never syntax errors); empty input is invalid_input.
//   9. Limits are enforced server-side (sync ≤ 500/stream, search ≤ 50) and
//      pagination over the ranked keyset covers every hit exactly once.
//  10. Evidence caps are BYTES (per-field, per-part): oversized tail text is
//      not indexed — honestly not searchable, never fetched whole.
//  11. Unsupported runtimes (no node:sqlite) degrade to a distinct status.
//  12. Message-data edits re-index through their own stream (role refresh).
//  13. Identity filters (sessionId/projectId/directory) constrain hits.
//
// Runs under the suite's `MANTA_STATE_HOME` sandbox (scripts/testSandbox.mjs)
// — the index lands in the throwaway state dir, never the live box — and
// every source is a synthetic fixture armed via `MANTA_OPENCODE_DB`
// (fixtures/opencodeDbFixture.mjs §14 canary).

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import {
  CTO_SEARCH_INDEX_LIMITS,
  ctoSearchIndexSearch,
  ctoSearchIndexStatus,
  ctoSearchIndexSync,
  _closeSearchIndexHandle,
  _searchIndexPath,
  _setSqliteModuleOverride,
  _setSyncFault,
} from "./ctoSearchIndex.mjs";
import {
  createFixtureDb,
  sqliteAvailable,
  withFixtureDb,
} from "./fixtures/opencodeDbFixture.mjs";

const hasSqlite = await sqliteAvailable();

const NOW = 1_700_000_000_000;
const NO_FILTER = async () => [];

// Writable handle on the TEST-OWNED fixture (never the shared read-only
// accessor): used to simulate source edits/deletions between syncs.
function editSource(fixture) {
  return new DatabaseSync(fixture.dbPath);
}

function resetIndexFiles() {
  _closeSearchIndexHandle();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(_searchIndexPath() + suffix, { force: true });
  }
}

// Arms a fresh synthetic source + a fresh index, runs `fn`, cleans up both.
async function withIndexSource(seed, fn) {
  const fixture = await createFixtureDb(seed);
  resetIndexFiles();
  try {
    return await withFixtureDb(fixture, () => fn(fixture));
  } finally {
    resetIndexFiles();
  }
}

// Throwing fetch spy at the process boundary (U04-shaped, mirrors the P0
// fixture test): proves sync/search touch NO live endpoints.
async function withFetchSpy(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("unexpected fetch during index sync/search");
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// Deterministic corpus: pText repeats "leasebot" so bm25 ranks it first; the
// tool part contributes name/input/output scalars; the archived (closed)
// session carries its own evidence; a synthetic text part and a reasoning
// part prove the eligibility rule (never evidence).
const BASE_SEED = {
  sessions: [
    { id: "s1", parentId: null, agent: "build", directory: "/repo-a", projectId: "proj-a", title: "worker one", timeCreated: NOW - 4000, timeUpdated: NOW - 4000 },
    { id: "s2", parentId: "s1", agent: "general", directory: "/repo-a", projectId: "proj-a", title: "child worker", timeCreated: NOW - 3000, timeUpdated: NOW - 3000 },
    { id: "sArch", parentId: null, agent: "build", directory: "/repo-b", projectId: "proj-b", title: "old closed chat", timeCreated: NOW - 9000, timeUpdated: NOW - 2000, timeArchived: NOW - 1000 },
  ],
  messages: [
    { id: "m1", sessionId: "s1", timeCreated: NOW - 4000, timeUpdated: NOW - 4000, data: { role: "assistant" } },
    { id: "m2", sessionId: "s2", timeCreated: NOW - 3000, timeUpdated: NOW - 3000, data: { role: "user" } },
    { id: "mArch", sessionId: "sArch", timeCreated: NOW - 9000, timeUpdated: NOW - 9000, data: { role: "assistant" } },
  ],
  parts: [
    {
      id: "pText", messageId: "m1", sessionId: "s1", timeCreated: NOW - 4000, timeUpdated: NOW - 4000,
      data: { type: "text", text: "leasebot leasebot leasebot leasebot leasebot leasebot leasebot leasebot deployed to staging verified v3" },
    },
    {
      id: "pTool", messageId: "m2", sessionId: "s2", timeCreated: NOW - 3000, timeUpdated: NOW - 3000,
      data: { type: "tool", tool: "bash", state: { status: "completed", input: { command: "npm test --filter leasebot" }, output: "all green" } },
    },
    {
      id: "pRetro", messageId: "mArch", sessionId: "sArch", timeCreated: NOW - 9000, timeUpdated: NOW - 9000,
      data: { type: "text", text: "archived leasebot retro notes from the closed session" },
    },
    {
      id: "pSynth", messageId: "mArch", sessionId: "sArch", timeCreated: NOW - 8900, timeUpdated: NOW - 8900,
      data: { type: "text", text: "synthetic staging filler", synthetic: true },
    },
    {
      id: "pReasoning", messageId: "mArch", sessionId: "sArch", timeCreated: NOW - 8800, timeUpdated: NOW - 8800,
      data: { type: "reasoning", text: "secret internal deliberation about staging" },
    },
  ],
};
const BASE_INDEXABLE = 3; // pText, pTool, pRetro

test("sync indexes eligible evidence; search ranks, enriches, keeps closed/child sessions, leaves the source untouched, and never fetches", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture) => {
    const before = { session: fixture.rowCount("session"), message: fixture.rowCount("message"), part: fixture.rowCount("part") };
    await withFetchSpy(async (calls) => {
      const sync = await ctoSearchIndexSync({ limit: 500, provenanceFilter: NO_FILTER });
      assert.equal(sync.status, "ok");
      assert.equal(sync.coverage.indexedParts, BASE_INDEXABLE, "reasoning/synthetic parts carry no eligible evidence");

      // "staging" exists in pText (indexed), pSynth (synthetic → excluded)
      // and pReasoning (never evidence) — exactly one hit proves the rule.
      const staging = await ctoSearchIndexSearch({ query: "staging", provenanceFilter: NO_FILTER });
      assert.equal(staging.status, "ok");
      assert.equal(staging.hits.length, 1, "only the eligible text part matches");
      const hit = staging.hits[0];
      assert.equal(hit.partId, "pText");
      assert.equal(hit.sessionId, "s1");
      assert.equal(hit.role, "assistant");
      assert.equal(hit.kind, "text");
      assert.equal(hit.provenance, "unclassified");
      assert.ok(hit.timeUpdated > 0, "hit carries the source update timestamp");
      assert.ok(typeof hit.snippet === "string" && hit.snippet.length > 0);

      const leasebot = await ctoSearchIndexSearch({ query: "leasebot", provenanceFilter: NO_FILTER });
      assert.equal(leasebot.status, "ok");
      assert.equal(leasebot.hits[0].partId, "pText", "bm25 puts the higher-term-frequency part first");
      assert.ok(leasebot.hits.some((h) => h.partId === "pTool"), "tool input scalars are searchable");
      assert.equal(leasebot.hits.find((h) => h.partId === "pTool").role, "user");
      assert.equal(calls.length, 0, "no fetch calls on sync or search");

      const tool = await ctoSearchIndexSearch({ query: "npm", provenanceFilter: NO_FILTER });
      assert.equal(tool.hits.length, 1);
      assert.equal(tool.hits[0].partId, "pTool");
      assert.equal(tool.hits[0].kind, "tool");
      assert.ok(tool.hits[0].field === "input" || tool.hits[0].field === "tool_name");
    });

    // Closed (archived) session evidence stays searchable; child sessions too.
    const retro = await ctoSearchIndexSearch({ query: "retro", provenanceFilter: NO_FILTER });
    assert.equal(retro.hits.length, 1);
    assert.equal(retro.hits[0].sessionId, "sArch", "archived/closed sessions are kept");

    const status = await ctoSearchIndexStatus();
    assert.equal(status.status, "ok");
    assert.equal(status.counts.parts, BASE_INDEXABLE);

    // Source untouched.
    assert.equal(fixture.rowCount("session"), before.session);
    assert.equal(fixture.rowCount("message"), before.message);
    assert.equal(fixture.rowCount("part"), before.part);
  });
});

test("edited part re-indexes: stale term gone, new term found, no duplicate rows", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture) => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");

    const db = editSource(fixture);
    try {
      db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?").run(
        JSON.stringify({ type: "text", text: "renamed widget renamed to gadget" }), NOW - 1000, "pText",
      );
    } finally {
      db.close();
    }

    const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.equal(sync.scanned.parts.scanned, 1, "the keyset catches exactly the edited row");

    const stale = await ctoSearchIndexSearch({ query: "leasebot", provenanceFilter: NO_FILTER });
    assert.equal(stale.hits.filter((h) => h.partId === "pText").length, 0, "stale term is gone");

    const fresh = await ctoSearchIndexSearch({ query: "gadget", provenanceFilter: NO_FILTER });
    assert.equal(fresh.hits.filter((h) => h.partId === "pText").length, 1, "new term found exactly once (replace, not duplicate)");
  });
});

test("deletion reconciles boundedly: a removed source part disappears from the index", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture) => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");

    const db = editSource(fixture);
    try {
      db.prepare("DELETE FROM part WHERE id = ?").run("pText");
    } finally {
      db.close();
    }

    const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.ok(sync.scanned.parts.removed >= 1, "the bounded reconcile removed the orphan");
    assert.ok(sync.scanned.verifiedParts <= CTO_SEARCH_INDEX_LIMITS.deleteReconcileMax, "reconcile is bounded");

    const gone = await ctoSearchIndexSearch({ query: "leasebot", provenanceFilter: NO_FILTER });
    assert.equal(gone.hits.filter((h) => h.partId === "pText").length, 0);
  });
});

test("failed batch: cursor and index unchanged, next sync completes (atomicity)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture) => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");
    const settled = await ctoSearchIndexStatus();
    assert.equal(settled.status, "ok");
    assert.equal(settled.counts.parts, BASE_INDEXABLE);

    // A NEW source part enters the scan window; the fault fires on it.
    const db = editSource(fixture);
    try {
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)").run(
        "pLater", "m1", "s1", NOW + 100, NOW + 100, JSON.stringify({ type: "text", text: "later addition" }),
      );
    } finally {
      db.close();
    }
    _setSyncFault(({ row }) => {
      if (row.id === "pLater") throw new Error("injected fault");
    });

    const failing = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(failing.status, "index_error", "the injected fault surfaces as an explicit status");

    const after = await ctoSearchIndexStatus();
    assert.equal(JSON.stringify(after.cursor), JSON.stringify(settled.cursor), "cursor did NOT advance");
    assert.equal(after.counts.parts, settled.counts.parts, "index rows did NOT change");

    _setSyncFault(null);
    const recovered = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.scanned.parts.scanned, 1, "the batch retries the same window");
    assert.equal((await ctoSearchIndexStatus()).counts.parts, BASE_INDEXABLE + 1);
  });
});

test("restart resumes: cursor persists on disk, second sync indexes the remainder", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // Only indexable parts (no synthetic/reasoning rows that would consume a
  // limit-1 batch without producing an indexed part).
  const seed = {
    sessions: BASE_SEED.sessions.slice(0, 2),
    messages: BASE_SEED.messages.slice(0, 2),
    parts: [
      { id: "pA", messageId: "m1", sessionId: "s1", timeCreated: NOW - 3000, timeUpdated: NOW - 3000, data: { type: "text", text: "alpha resume" } },
      { id: "pB", messageId: "m2", sessionId: "s2", timeCreated: NOW - 2000, timeUpdated: NOW - 2000, data: { type: "text", text: "bravo resume" } },
      { id: "pC", messageId: "m1", sessionId: "s1", timeCreated: NOW - 1000, timeUpdated: NOW - 1000, data: { type: "text", text: "charlie resume" } },
    ],
  };
  await withIndexSource(seed, async () => {
    const first = await ctoSearchIndexSync({ limit: 1, provenanceFilter: NO_FILTER });
    assert.equal(first.status, "ok");
    assert.equal(first.scanned.parts.scanned, 1);
    assert.equal((await ctoSearchIndexStatus()).counts.parts, 1);

    // Simulate a process restart: drop the cached handle; the cursor must
    // come back from disk and the walk continue — NOT restart from zero.
    _closeSearchIndexHandle();
    const second = await ctoSearchIndexSync({ limit: 1, provenanceFilter: NO_FILTER });
    assert.equal(second.status, "ok");
    assert.equal(second.scanned.parts.scanned, 1, "resumes after the persisted cursor");
    assert.equal((await ctoSearchIndexStatus()).counts.parts, 2, "exactly one new part indexed");

    _closeSearchIndexHandle();
    const third = await ctoSearchIndexSync({ limit: 1, provenanceFilter: NO_FILTER });
    assert.equal(third.status, "ok");
    assert.equal((await ctoSearchIndexStatus()).counts.parts, 3);
  });
});

test("internal sessions are excluded by default (provenance seam), includable on request; registry failure fails closed", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const seed = structuredClone(BASE_SEED);
  seed.sessions.push({ id: "sEphem", parentId: null, agent: "cto", directory: "/repo-a", projectId: "proj-a", title: "self-analysis", timeCreated: NOW - 500, timeUpdated: NOW - 500 });
  seed.messages.push({ id: "mEphem", sessionId: "sEphem", timeCreated: NOW - 500, timeUpdated: NOW - 500, data: { role: "assistant" } });
  seed.parts.push({ id: "pEphem", messageId: "mEphem", sessionId: "sEphem", timeCreated: NOW - 500, timeUpdated: NOW - 500, data: { type: "text", text: "ephemeral self analysis about leasebot" } });
  await withIndexSource(seed, async () => {
    const filter = async () => ["sEphem"]; // the established registry returns IDs, never titles
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: filter })).status, "ok");

    const excluded = await ctoSearchIndexSearch({ query: "leasebot", provenanceFilter: filter });
    assert.equal(excluded.hits.filter((h) => h.partId === "pEphem").length, 0, "internal excluded by default");
    assert.ok(excluded.hits.length >= 2, "ordinary evidence still searchable");

    const included = await ctoSearchIndexSearch({ query: "leasebot", includeInternal: true, provenanceFilter: filter });
    const ephem = included.hits.filter((h) => h.partId === "pEphem");
    assert.equal(ephem.length, 1, "internal searchable when explicitly requested");
    assert.equal(ephem[0].provenance, "internal", "provenance recorded from the registry, not guessed");

    // Registry failure fails the batch CLOSED and does not advance anything.
    const settled = await ctoSearchIndexStatus();
    const failing = await ctoSearchIndexSync({ provenanceFilter: async () => { throw new Error("registry down"); } });
    assert.equal(failing.status, "provenance_unavailable");
    const after = await ctoSearchIndexStatus();
    assert.equal(JSON.stringify(after.cursor), JSON.stringify(settled.cursor), "cursor unchanged on provenance failure");
  });
});

test("corrupt index is rebuilt (disposable); source stays untouched; rebuild flag is honest", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture) => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");
    const before = { session: fixture.rowCount("session"), message: fixture.rowCount("message"), part: fixture.rowCount("part") };

    _closeSearchIndexHandle();
    writeFileSync(_searchIndexPath(), Buffer.from("garbage that is not a database ".repeat(40)));

    const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.equal(sync.rebuilt, true, "the rebuild is reported, not hidden");
    assert.equal(sync.coverage.indexedParts, BASE_INDEXABLE, "full reindex from a reset cursor");

    const search = await ctoSearchIndexSearch({ query: "staging", provenanceFilter: NO_FILTER });
    assert.equal(search.status, "ok");
    assert.equal(search.hits.length, 1);

    assert.equal(fixture.rowCount("session"), before.session, "recovery never touches the source");
    assert.equal(fixture.rowCount("message"), before.message);
    assert.equal(fixture.rowCount("part"), before.part);
  });
});

test("query policy is literal: metacharacters never act as operators, unicode/punctuation are honest no-hits, empty input is invalid", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async () => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");

    const star = await ctoSearchIndexSearch({ query: "stagi*", provenanceFilter: NO_FILTER });
    assert.equal(star.status, "ok");
    assert.equal(star.hits.length, 0, "quoted * is literal, not a prefix operator");

    const paren = await ctoSearchIndexSearch({ query: "(staging)", provenanceFilter: NO_FILTER });
    assert.equal(paren.status, "ok");
    assert.equal(paren.hits.length, 1, "parens are literal; the token still matches");

    const unicode = await ctoSearchIndexSearch({ query: "café", provenanceFilter: NO_FILTER });
    assert.equal(unicode.status, "ok", "unicode query never a syntax error");
    assert.equal(unicode.hits.length, 0);

    const punct = await ctoSearchIndexSearch({ query: "...", provenanceFilter: NO_FILTER });
    assert.equal(punct.status, "ok", "punctuation-only query is a no-hit, never an error");
    assert.equal(punct.hits.length, 0);

    const multi = await ctoSearchIndexSearch({ query: "leasebot verified", provenanceFilter: NO_FILTER });
    assert.equal(multi.status, "ok");
    assert.ok(multi.hits.some((h) => h.partId === "pText"), "whitespace terms AND together");

    const bad = await ctoSearchIndexSearch({ query: "   " });
    assert.equal(bad.status, "invalid_input");
    const nonString = await ctoSearchIndexSearch({ query: 42 });
    assert.equal(nonString.status, "invalid_input");
  });
});

test("limits clamp server-side and ranked pagination covers every hit exactly once", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const parts = [];
  for (let i = 0; i < 60; i++) {
    parts.push({
      id: `p${i}`, messageId: "m1", sessionId: "s1", timeCreated: NOW - i, timeUpdated: NOW - i,
      data: { type: "text", text: `pageword item ${i} ${"x".repeat(20)}` },
    });
  }
  const seed = { sessions: BASE_SEED.sessions.slice(0, 1), messages: BASE_SEED.messages.slice(0, 1), parts };
  await withIndexSource(seed, async () => {
    assert.equal((await ctoSearchIndexSync({ limit: 500, provenanceFilter: NO_FILTER })).coverage.indexedParts, 60);

    const overLimit = await ctoSearchIndexSearch({ query: "pageword", limit: 9999, provenanceFilter: NO_FILTER });
    assert.equal(overLimit.hits.length, CTO_SEARCH_INDEX_LIMITS.searchHitsMax, "search limit clamps to 50");
    assert.equal(overLimit.truncated, true);
    assert.ok(overLimit.nextCursor, "more pages exist");

    // Sync limit clamps too: a sync({limit:9999}) never processes >500/stream.
    const bigSync = await ctoSearchIndexSync({ limit: 9999, provenanceFilter: NO_FILTER });
    assert.equal(bigSync.status, "ok");
    assert.ok(bigSync.scanned.parts.scanned <= CTO_SEARCH_INDEX_LIMITS.syncBatchMax);

    // Page through ALL hits; nothing repeats; the walk terminates.
    const seen = new Set();
    let cursor = undefined;
    let pages = 0;
    while (pages < 20) {
      const page = await ctoSearchIndexSearch({ query: "pageword", limit: 20, cursor, provenanceFilter: NO_FILTER });
      assert.equal(page.status, "ok");
      for (const hit of page.hits) {
        assert.ok(!seen.has(hit.partId), `no repeats across pages (${hit.partId})`);
        seen.add(hit.partId);
      }
      pages++;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.size, 60, "pagination covers every hit exactly once");
    assert.ok(pages >= 3);

    const badCursor = await ctoSearchIndexSearch({ query: "other", cursor: overLimit.nextCursor, provenanceFilter: NO_FILTER });
    assert.equal(badCursor.status, "invalid_input", "a cursor is bound to its query");
    const garbage = await ctoSearchIndexSearch({ query: "pageword", cursor: "not-a-cursor", provenanceFilter: NO_FILTER });
    assert.equal(garbage.status, "invalid_input");
  });
});

test("evidence caps are bytes: oversized tail is not indexed (honest, never fetched whole)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  const big = "headword " + "y".repeat(40_000) + " tailword";
  const seed = {
    sessions: BASE_SEED.sessions.slice(0, 1),
    messages: BASE_SEED.messages.slice(0, 1),
    parts: [{ id: "pBig", messageId: "m1", sessionId: "s1", timeCreated: NOW, timeUpdated: NOW, data: { type: "tool", tool: "bash", state: { status: "completed", output: big } } }],
  };
  await withIndexSource(seed, async () => {
    const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");

    const head = await ctoSearchIndexSearch({ query: "headword", provenanceFilter: NO_FILTER });
    assert.equal(head.hits.length, 1, "the capped prefix is indexed");

    const tail = await ctoSearchIndexSearch({ query: "tailword", provenanceFilter: NO_FILTER });
    assert.equal(tail.hits.length, 0, "the byte-capped tail is honestly not searchable");
  });
});

test("unsupported runtime degrades to a distinct status (lazy import, no static node:sqlite)", async (t) => {
  if (!hasSqlite) {
    // On a runtime without node:sqlite the module API must still answer.
    const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.supported, false);
    assert.equal(sync.status, "unsupported");
    const search = await ctoSearchIndexSearch({ query: "x" });
    assert.equal(search.supported, false);
    assert.equal(search.status, "unsupported");
    return;
  }
  await withIndexSource(BASE_SEED, async () => {
    _setSqliteModuleOverride({ __importError: new Error("no sqlite on node 20") });
    try {
      const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
      assert.equal(sync.supported, false);
      assert.equal(sync.status, "unsupported");
      const search = await ctoSearchIndexSearch({ query: "staging" });
      assert.equal(search.supported, false);
      assert.equal(search.status, "unsupported");
    } finally {
      _setSqliteModuleOverride(null);
    }
    _closeSearchIndexHandle();
    const recovered = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(recovered.status, "ok", "restores after the override is cleared");
  });
});

test("message-data edits re-index through their own stream (role refresh)", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async (fixture) => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");

    const db = editSource(fixture);
    try {
      db.prepare("UPDATE message SET data = ?, time_updated = ? WHERE id = ?").run(
        JSON.stringify({ role: "user" }), NOW - 500, "m1",
      );
    } finally {
      db.close();
    }

    const sync = await ctoSearchIndexSync({ provenanceFilter: NO_FILTER });
    assert.equal(sync.status, "ok");
    assert.equal(sync.scanned.messages.scanned, 1, "message edits are caught by their own stream");

    const hits = await ctoSearchIndexSearch({ query: "staging", provenanceFilter: NO_FILTER });
    assert.equal(hits.hits.find((h) => h.partId === "pText").role, "user", "role enrichment follows the message edit");
  });
});

test("response budget is bytes: overflow drops tail hits honestly and paging continues", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  // 30 hits × ~1.5 KiB snippets ≈ 45 KiB serialized — over the 24 KiB budget.
  const parts = [];
  for (let i = 0; i < 30; i++) {
    parts.push({
      id: `p${i}`, messageId: "m1", sessionId: "s1", timeCreated: NOW - i, timeUpdated: NOW - i,
      data: { type: "text", text: `bigword item ${i} ${"z".repeat(1500)}` },
    });
  }
  const seed = { sessions: BASE_SEED.sessions.slice(0, 1), messages: BASE_SEED.messages.slice(0, 1), parts };
  await withIndexSource(seed, async () => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).coverage.indexedParts, 30);

    const page = await ctoSearchIndexSearch({ query: "bigword", limit: 50, provenanceFilter: NO_FILTER });
    assert.equal(page.status, "ok");
    assert.ok(page.hits.length < 30, "budget dropped tail hits before the cap");
    assert.ok(page.hits.length >= 1, "some hits still fit");
    assert.equal(page.truncated, true);
    assert.equal(page.omittedCount, 30 - page.hits.length, "omissions are counted, not hidden");
    assert.ok(page.nextCursor, "the dropped tail stays reachable");
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CTO_SEARCH_INDEX_LIMITS.responseBudgetBytes, "the serialized response honors the budget");
  });
});

test("identity filters constrain hits; unknown identities never match", async (t) => {
  if (!hasSqlite) return t.skip("node:sqlite unavailable on this runtime");
  await withIndexSource(BASE_SEED, async () => {
    assert.equal((await ctoSearchIndexSync({ provenanceFilter: NO_FILTER })).status, "ok");

    const bySession = await ctoSearchIndexSearch({ query: "leasebot", sessionId: "s2", provenanceFilter: NO_FILTER });
    assert.ok(bySession.hits.length >= 1);
    assert.ok(bySession.hits.every((h) => h.sessionId === "s2"));

    const byProject = await ctoSearchIndexSearch({ query: "leasebot", projectId: "proj-a", provenanceFilter: NO_FILTER });
    assert.ok(byProject.hits.length >= 2);
    assert.ok(byProject.hits.every((h) => h.sessionId === "s1" || h.sessionId === "s2"));

    const otherProject = await ctoSearchIndexSearch({ query: "leasebot", projectId: "proj-zzz", provenanceFilter: NO_FILTER });
    assert.equal(otherProject.hits.length, 0, "an unknown project never matches");

    const byDirectory = await ctoSearchIndexSearch({ query: "retro", directory: "/repo-b", provenanceFilter: NO_FILTER });
    assert.equal(byDirectory.hits.length, 1);
    assert.equal(byDirectory.hits[0].sessionId, "sArch");
  });
});
