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
  return { db, close: () => db.close() };
}

test("collectDbRows queries the part table in the half-open window", async () => {
  const fx = await openFixture();
  if (!fx) {
    test.skip("node:sqlite unavailable on this runtime");
    return;
  }
  const { db } = fx;
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

  // A missing/handle-less db yields no rows, never a throw.
  assert.deepEqual(await collectDbRows(null, { sinceTs: 0, untilTs: 10 }), []);
  const bad = { prepare() { throw new Error("boom"); } };
  assert.deepEqual(await collectDbRows(bad, { sinceTs: 0, untilTs: 10 }), []);
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
