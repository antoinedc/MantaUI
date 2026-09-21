// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolPart,
  cliTokens,
  extractUrlHosts,
  extractFromToolPart,
  extractFromDbRows,
  collectDbRows,
  extractMcpEvidence,
  extractForgeEvidence,
  extractWebhookEvidence,
  extractGitRemoteEvidence,
  extractScheduleEvidence,
  collectConfigEvidence,
  SURFACES_READER_CODES,
  settleSurface,
  firstSurfacesCode,
} from "./ctoToolScan.mjs";

const TS = 1_700_000_000_000;

function partData(tool, input) {
  return JSON.stringify({ type: "tool", tool, callID: "c1", state: { status: "completed", input } });
}

// ---------------------------------------------------------------------------
// parseToolPart / cliTokens / extractUrlHosts
// ---------------------------------------------------------------------------

test("parseToolPart reads a tool-call part and rejects other shapes", () => {
  const p = parseToolPart(partData("bash", { command: "ls" }));
  assert.equal(p.tool, "bash");
  assert.deepEqual(p.input, { command: "ls" });
  assert.equal(parseToolPart(JSON.stringify({ type: "text", text: "hi" })), null);
  assert.equal(parseToolPart("not json"), null);
  assert.equal(parseToolPart(null), null);
});

test("cliTokens takes the first token of every command segment", () => {
  assert.deepEqual(cliTokens("git status"), ["git"]);
  assert.deepEqual(cliTokens("cd /x && gh pr view 12 ; npm test | head"), ["cd", "gh", "npm", "head"]);
  assert.deepEqual(cliTokens("echo one\necho two"), ["echo", "echo"]);
  assert.deepEqual(cliTokens(""), []);
});

test("extractUrlHosts pulls https hosts, deduped, trimmed", () => {
  assert.deepEqual(extractUrlHosts("curl https://api.github.com/repos and https://api.github.com/x"), [
    "api.github.com",
  ]);
  assert.deepEqual(extractUrlHosts("see https://Example.COM./a"), ["example.com"]);
  assert.deepEqual(extractUrlHosts("no urls"), []);
});

// ---------------------------------------------------------------------------
// extractFromToolPart — the §7.1-2 transcript extractors
// ---------------------------------------------------------------------------

test("bash tool part → catalog CLI evidence, locals skipped, unknowns raw", () => {
  const rows = extractFromToolPart({
    data: partData("bash", { command: "git status && gh pr list && weird-cli deploy" }),
    ts: TS,
    sessionID: "s1",
    project: "proj",
  });
  const cli = rows.filter((r) => r.detail.startsWith("cli:"));
  // git → local (skipped); gh → catalog github; weird-cli → raw.
  assert.deepEqual(
    cli.map((r) => [r.identity, r.detail, r.source]),
    [
      ["github", "cli:gh", "catalog"],
      [null, "cli:weird-cli", "raw"],
    ],
  );
  assert.equal(cli[0].channel, "transcript");
  assert.equal(cli[0].ts, TS);
  assert.equal(cli[0].sessionID, "s1");
  assert.equal(cli[0].project, "proj");
});

test("bash curl command → domain evidence; own-box and private hosts dropped", () => {
  const rows = extractFromToolPart({
    data: partData("bash", {
      command: "curl -s https://api.github.com/x > /dev/null && curl https://internal.thing.io/y && curl http://169.254.1.1/z",
    }),
    ts: TS,
  });
  const domains = rows.filter((r) => r.detail.startsWith("domain:"));
  assert.deepEqual(
    domains.map((r) => [r.identity, r.detail]),
    [["github", "domain:api.github.com"], [null, "domain:internal.thing.io"]],
  );
  // The bare-IP curl is https-less → no row; private hosts never match.
  assert.equal(domains.some((r) => r.detail.includes("169.254")), false);
});

test("issue-key evidence from branch names + commit subjects is raw", () => {
  const rows = extractFromToolPart({
    data: partData("bash", { command: "git checkout -b multica/BET-1395-x && git commit -m 'BET-42: fix'" }),
    ts: TS,
  });
  const keys = rows.filter((r) => r.detail.startsWith("key:"));
  assert.deepEqual(
    keys.map((r) => r.detail),
    ["key:BET-1395", "key:BET-42"],
  );
  for (const k of keys) {
    assert.equal(k.identity, null);
    assert.equal(k.source, "raw");
  }
});

test("webfetch tool part → domain evidence from input.url", () => {
  const rows = extractFromToolPart({ data: partData("webfetch", { url: "https://linear.app/issue" }), ts: TS });
  assert.deepEqual(rows.map((r) => [r.identity, r.detail]), [["linear", "domain:linear.app"]]);
});

test("non-tool parts and non-command tools produce no rows", () => {
  assert.deepEqual(extractFromToolPart({ data: JSON.stringify({ type: "text", text: "x" }), ts: TS }), []);
  assert.deepEqual(extractFromToolPart({ data: partData("read", { path: "/x" }), ts: TS }), []);
});

// ---------------------------------------------------------------------------
// db batch
// ---------------------------------------------------------------------------

test("extractFromDbRows maps part rows → evidence, skipping malformed rows", () => {
  const rows = extractFromDbRows([
    { session_id: "s1", data: partData("bash", { command: "gh pr list" }), time_created: TS },
    { session_id: "s2", data: "garbage{", time_created: TS + 1 },
    { session_id: "s3", data: partData("bash", { command: "aws s3 ls" }), time_created: TS + 2 },
    { session_id: "s4", data: partData("bash", { command: "vercel deploy" }), time_created: Number.NaN },
    { session_id: "s5", data: null, time_created: TS + 3 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.identity, r.detail, r.sessionID]),
    [
      ["github", "cli:gh", "s1"],
      ["aws", "cli:aws", "s3"],
    ],
  );
});

test("extractFromDbRows role-aware: conversation ASSISTANT content is never ordinary evidence; generic internal excluded; legacy internal flag still works", () => {
  const rows = extractFromDbRows([
    { session_id: "ordinary", data: partData("bash", { command: "gh pr list" }), time_created: TS },
    // Legacy shape (pre-provenance callers): the boolean still excludes.
    { session_id: "legacy-internal", internal: true, data: partData("bash", { command: "aws s3 ls" }), time_created: TS + 1 },
    // Generic internal provenance.
    { session_id: "internal", provenance: "cto_internal", data: partData("bash", { command: "vercel deploy" }), time_created: TS + 2 },
    // The durable conversation: assistant tool call EXCLUDED from ordinary evidence.
    { session_id: "convo", provenance: "cto_conversation", role: "assistant", data: partData("bash", { command: "gh api repos" }), time_created: TS + 3 },
    // Unknown role on a conversation row: conservatively excluded.
    { session_id: "convo", provenance: "cto_conversation", role: null, data: partData("bash", { command: "gh api x" }), time_created: TS + 4 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.identity, r.sessionID]),
    [["github", "ordinary"]],
  );
});

// A memory-backed SQLite fixture (node:sqlite). Returns { db, close } or null
// when node:sqlite is unavailable (degrade the db tests to skip) — same
// pattern as ctoBackfill.test.mjs. CI's Node 20 lacks node:sqlite.
async function openFixture() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  }
  const db = new DatabaseSync(":memory:");
  return { db, sqlite: { DatabaseSync }, close: () => db.close() };
}

test("collectDbRows queries the part table in the half-open window", async () => {
  const fx = await openFixture();
  if (!fx) {
    test.skip("node:sqlite unavailable on this runtime");
    return;
  }
  const { db } = fx;
  db.exec("CREATE TABLE session (id TEXT, title TEXT); INSERT INTO session VALUES ('s1','work'),('s2','work'),('s3','work')");
  db.exec(
    "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  const ins = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
  );
  ins.run("p1", "m1", "s1", 100, 100, partData("bash", { command: "gh pr list" }));
  ins.run("p2", "m2", "s2", 200, 200, partData("bash", { command: "aws s3 ls" }));
  ins.run("p3", "m3", "s3", 300, 300, partData("bash", { command: "vercel deploy" }));

  const rows = await collectDbRows(db, { sinceTs: 100, untilTs: 299 });
  assert.equal(rows.length, 1); // (100, 299] — p2 only
  assert.equal(JSON.parse(rows[0].data).state.input.command, "aws s3 ls");

  const all = await collectDbRows(db, { sinceTs: 0, untilTs: 1000 });
  assert.equal(all.length, 3);

  // Unavailable data must not be mistaken for an exhausted page — and each
  // distinct throw site (W10) carries its own code, not a catch-all.
  await assert.rejects(collectDbRows(null, { sinceTs: 0, untilTs: 10 }), (e) => e.code === "db-handle-invalid");
  const bad = { prepare() { throw new Error("boom"); } };
  await assert.rejects(collectDbRows(bad, { sinceTs: 0, untilTs: 10 }), (e) => e.code === "db-query-failed");
});

test("collectDbRows: a valid handle with a throwing statement reports db-query-failed", async () => {
  const fx = await openFixture();
  if (!fx) {
    test.skip("node:sqlite unavailable on this runtime");
    return;
  }
  const { DatabaseSync } = fx.sqlite;
  // Real sqlite handle, but no part table — prepare/execute throws.
  const db = new DatabaseSync(":memory:");
  await assert.rejects(collectDbRows(db, { sinceTs: 0, untilTs: 10 }), (e) => e.code === "db-query-failed");
});

// ---------------------------------------------------------------------------
// channel 3 — config surfaces
// ---------------------------------------------------------------------------

test("MCP config → catalog-matched remote + raw local evidence", () => {
  const rows = extractMcpEvidence(
    { mcp: { linear: { url: "https://mcp.linear.app/sse" }, files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } } },
    { ts: TS },
  );
  assert.deepEqual(
    rows.map((r) => [r.identity, r.detail, r.source]),
    [["linear", "mcp:linear:mcp.linear.app", "catalog"], [null, "mcp:files", "raw"]],
  );
  assert.equal(rows[0].channel, "config");
});

test("forge rules / webhooks / git remotes / schedules → config evidence", () => {
  const forge = extractForgeEvidence(["github.com/antoinedc/MantaUI"], { ts: TS });
  assert.deepEqual(forge.map((r) => [r.identity, r.detail]), [["github", "forge:github.com/antoinedc/MantaUI"]]);

  const hooks = extractWebhookEvidence([{ label: "multica BET-1395 done" }, { label: "" }], { ts: TS });
  assert.deepEqual(hooks.map((r) => [r.identity, r.detail]), [[null, "webhook:multica BET-1395 done"]]);

  const remotes = extractGitRemoteEvidence(
    [{ project: "manta", url: "git@github.com:antoinedc/MantaUI.git" }, { project: "other", url: "https://gitlab.com/x/y.git" }],
    { ts: TS },
  );
  assert.deepEqual(
    remotes.map((r) => [r.identity, r.detail, r.project]),
    [["github", "git:github.com", "manta"], ["gitlab", "git:gitlab.com", "other"]],
  );

  const scheds = extractScheduleEvidence([{ label: "deploy check" }], { ts: TS });
  assert.deepEqual(scheds.map((r) => [r.identity, r.detail]), [[null, "schedule:deploy check"]]);
});

test("collectConfigEvidence gathers all surfaces and never throws", () => {
  const rows = collectConfigEvidence(
    {
      config: { mcp: { linear: { url: "https://mcp.linear.app/sse" } } },
      forgeRepos: ["github.com/o/r"],
      webhooks: [{ label: "ci" }],
      gitRemotes: [{ project: "p", url: "https://github.com/o/p.git" }],
      schedules: [{ label: "nightly" }],
    },
    { ts: TS },
  );
  assert.equal(rows.length, 5);
  assert.deepEqual(collectConfigEvidence(undefined, { ts: TS }), []);
  assert.deepEqual(collectConfigEvidence({ config: null }, { ts: TS }), []);
});

// ---------------------------------------------------------------------------
// W10/BET-1542 — per-reader failure codes resolved through the surfaces seam
// ---------------------------------------------------------------------------

test("settleSurface passes a resolved read through and degrades a failed one to fallback + code", async () => {
  const ok = await settleSurface(async () => ({ mcp: {} }), SURFACES_READER_CODES.config, {});
  assert.deepEqual(ok, { value: { mcp: {} } });
  assert.equal("code" in ok, false);

  const failed = await settleSurface(
    async () => {
      throw new Error("SECRET read failed pg_dsn=hunter2");
    },
    SURFACES_READER_CODES.forge,
    [],
  );
  assert.deepEqual(failed, { value: [], code: "surfaces-forge-unavailable" });
  assert.equal(JSON.stringify(failed).includes("hunter2"), false);
});

test("firstSurfacesCode names the failing reader in seam order, or null when all succeeded", () => {
  assert.equal(firstSurfacesCode({}), null);
  assert.equal(firstSurfacesCode(undefined), null);
  assert.equal(firstSurfacesCode({ config: { mcp: {} }, gitRemotes: [] }), null);
  // Two readers failed → the code is deterministic (seam's reader order),
  // never whichever key happens to sort first on the object.
  assert.equal(
    firstSurfacesCode({ gitRemotesCode: SURFACES_READER_CODES.gitRemotes, configCode: SURFACES_READER_CODES.config }),
    "surfaces-config-unavailable",
  );
  assert.equal(
    firstSurfacesCode({ schedulesCode: SURFACES_READER_CODES.schedules }),
    "surfaces-schedules-unavailable",
  );
  // The five reader codes are distinct — one label per reader is the point.
  assert.equal(new Set(Object.values(SURFACES_READER_CODES)).size, Object.keys(SURFACES_READER_CODES).length);
});

// ---------------------------------------------------------------------------
// P3a1 review round 2, blocker 4 — role-aware DB pipeline integration: the
// REAL sqlite fixture through collectDbRows + extractFromDbRows, with the
// sandbox provenance stores (generic tombstones + the binding record — never
// the conversation in the tombstones). Not just the event path.
// ---------------------------------------------------------------------------

test("DB pipeline integration: distinct provenance tags rows; the conversation's assistant tool calls are not indexed ordinary; CEO user rows stay tagged consumable", async () => {
  const fx = await openFixture();
  if (!fx) {
    test.skip("node:sqlite unavailable on this runtime");
    return;
  }
  const { db } = fx;
  // Seed a message table WITH role-bearing data (like the real opencode db).
  db.exec(
    "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);" +
      "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  const insMsg = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)");
  const insPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)");
  insMsg.run("m1", "ordinary", 1, 1, JSON.stringify({ role: "assistant" }));
  insMsg.run("m2", "ephemeral", 1, 1, JSON.stringify({ role: "assistant" }));
  insMsg.run("m3", "convo", 1, 1, JSON.stringify({ role: "assistant" }));
  insMsg.run("m4", "convo", 1, 1, JSON.stringify({ role: "user" }));
  insPart.run("p1", "m1", "ordinary", 10, 10, partData("bash", { command: "gh pr list" }));
  insPart.run("p2", "m2", "ephemeral", 20, 20, partData("bash", { command: "aws s3 ls" }));
  insPart.run("p3", "m3", "convo", 30, 30, partData("bash", { command: "vercel deploy" }));
  // A CEO instruction text part in the conversation (user message row).
  insPart.run("p4", "m4", "convo", 40, 40, JSON.stringify({ type: "text", text: "ship the release" }));

  // Sandbox provenance: the ephemeral session in the generic tombstones; the
  // durable conversation ONLY in the binding record (never the tombstones).
  const { bindingStore, internalSessionsStore } = await import("./ctoStores.mjs");
  const { CONVERSATION_ROLE, markerFor } = await import("./ctoBinding.mjs");
  const priorTombstones = await internalSessionsStore.load();
  const priorBinding = await bindingStore.load();
  const op = { operation: "op-int", generation: 1, directory: "/x", startedAt: 1 };
  try {
    await internalSessionsStore.save({ v: 1, ids: ["ephemeral"] });
    await bindingStore.save({
      v: 1,
      generation: 1,
      currentSessionId: "convo",
      currentOperation: op.operation,
      previousSessionIds: [],
      pendingOperation: null,
    });

    const rows = await collectDbRows(db, { sinceTs: 0, untilTs: 1000 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Distinct provenance, resolved from the two SEPARATE registers.
    assert.equal(byId.get("p1").provenance, null);
    assert.equal(byId.get("p1").role, "assistant");
    assert.equal(byId.get("p2").provenance, "cto_internal");
    assert.equal(byId.get("p3").provenance, CONVERSATION_ROLE);
    assert.equal(byId.get("p3").role, "assistant");
    assert.equal(byId.get("p4").provenance, CONVERSATION_ROLE);
    assert.equal(byId.get("p4").role, "user");
    // The conversation is NOT in the generic tombstones.
    assert.ok(!priorTombstones.ids?.includes && true);
    const tomb = await internalSessionsStore.load();
    assert.ok(!tomb.ids.includes("convo"));

    // Evidence extraction: ordinary tool call indexed; internal AND the
    // conversation's assistant tool call NOT ordinary evidence; the CEO's
    // user text row is not a tool part (yields nothing) but stays in the
    // page tagged for its role path.
    const evidence = extractFromDbRows(rows);
    assert.deepEqual(
      evidence.map((r) => [r.identity, r.sessionID]),
      [["github", "ordinary"]],
    );
    void markerFor;
  } finally {
    await internalSessionsStore.save(priorTombstones);
    await bindingStore.save(priorBinding);
  }
});
