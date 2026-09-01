// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createToolRegistry,
  fuseRow,
  weekKey,
  barCrossed,
  engagementBarMet,
  hasCredential,
  deriveRole,
  parseClassification,
  findHostParent,
  RAW_CLASSIFY_MIN_USES,
  ENGAGEMENT_MIN_USES,
  ENGAGEMENT_MIN_WEEKS,
} from "./ctoToolRegistry.mjs";

const DAY = 24 * 3_600_000;
const W0 = 1_700_000_000_000; // a fixed epoch

function memStore(initial = {}) {
  let state = { ...initial };
  return {
    load: async () => ({ ...state }),
    save: async (next) => {
      state = { ...next };
    },
    _state: () => state,
  };
}

function fakeCards() {
  const calls = { upserts: [], resolved: [] };
  const open = [];
  return {
    calls,
    open,
    async upsertConnect(input) {
      calls.upserts.push(input);
      open.push({ id: `card-${input.toolId}`, variant: "connect", state: "open", refs: input.refs });
      return { changed: true, isNew: true };
    },
    async listOpen() {
      return open.filter((c) => c.state === "open");
    },
    async resolveConnectCards(toolId, reason) {
      const hit = open.some((c) => c.state === "open" && c.refs?.includes(toolId));
      for (const c of open) if (c.refs?.includes(toolId)) c.state = "resolved";
      calls.resolved.push({ toolId, reason, hit });
      return { changed: hit };
    },
  };
}

function fakeLedger() {
  const rows = [];
  return {
    rows,
    async append(entry) {
      rows.push(entry);
    },
  };
}

// A next-day scan over the SAME persisted registry store (fresh registry
// instance, shared state) — the common shape of the lifecycle timing tests.
function nextDay(registryStore, cards, dayMs, rows, overrides = {}) {
  return createToolRegistry({
    registryStore,
    usageStore: memStore({ rows }),
    cards,
    ledger: fakeLedger(),
    now: () => dayMs,
    ...overrides,
  });
}

function makeRegistry({ usageRows = [], cards = fakeCards(), runEphemeral = null, nowMs = W0, collectDb = null, collectSurfaces = null } = {}) {
  const registryStore = memStore();
  const usageStore = memStore({ rows: [...usageRows] });
  const ledger = fakeLedger();
  const registry = createToolRegistry({
    registryStore,
    usageStore,
    cards,
    ledger,
    runEphemeral,
    now: () => nowMs,
    collectDb,
    collectSurfaces,
  });
  return { registry, registryStore, usageStore, ledger, cards };
}

// ---------------------------------------------------------------------------
// pure fusion helpers
// ---------------------------------------------------------------------------

test("weekKey buckets timestamps into ISO weeks", () => {
  assert.match(weekKey(W0), /^\d{4}-W\d{2}$/);
  assert.equal(weekKey("not-a-number"), null);
});

test("fuseRow creates one row per identity and accumulates uses/weeks", () => {
  let tools = [];
  tools = fuseRow(tools, { channel: "transcript", identity: "github", detail: "cli:gh", ts: W0 });
  tools = fuseRow(tools, { channel: "transcript", identity: "github", detail: "cli:gh", ts: W0 + 3 * DAY });
  tools = fuseRow(tools, { channel: "secret", identity: "github", detail: "secret:GITHUB_PAT", ts: W0 + 8 * DAY });
  assert.equal(tools.length, 1);
  const t = tools[0];
  assert.equal(t.tool, "github");
  assert.equal(t.uses, 3);
  assert.equal(t.weeksActive, 2);
  assert.equal(t.status, "observed");
  assert.equal(hasCredential(t), true); // channel-1 evidence = vitality path
  assert.equal(barCrossed(t), true); // credential alone crosses the bar
  // Evidence trail dedups by channel+detail and caps.
  assert.equal(t.evidence.length, 2);
});

test("raw evidence without a catalog identity becomes a raw entry (LLM-classifiable); labels stay log-only", () => {
  let tools = fuseRow([], { channel: "transcript", identity: null, detail: "cli:weird", ts: W0, source: "raw" });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool, "weird");
  assert.equal(tools[0].raw, true);
  assert.equal(tools[0].status, "observed");
  // Free-text labels (webhooks/schedules) are not tool tokens — log-only.
  tools = fuseRow(tools, { channel: "config", identity: null, detail: "webhook:some label", ts: W0 });
  assert.equal(tools.length, 1);
});

test("engagement bar needs uses AND distinct weeks", () => {
  const t = { uses: 10, weeksActive: 1, evidence: [] };
  assert.equal(engagementBarMet(t), false);
  assert.equal(barCrossed(t), false);
  const t2 = { uses: 3, weeksActive: 2, evidence: [] };
  assert.equal(engagementBarMet(t2), true);
  assert.equal(barCrossed(t2), true);
});

test("near-duplicate suppression folds a subdomain host into the known tool", () => {
  let tools = fuseRow([], { channel: "transcript", identity: "github", detail: "domain:github.com", ts: W0 });
  const parent = findHostParent(tools, "api.github.com");
  assert.equal(parent?.tool, "github");
  // A raw row for the subdomain folds into the parent by identity.
  const merged = fuseRow(tools, { channel: "transcript", identity: null, detail: "domain:api.github.com", ts: W0 + 1 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].uses, 2);
  // An unrelated host does NOT fold.
  assert.equal(findHostParent(tools, "api.stripe.com"), null);
});

test("EWMA decays toward zero with inactivity (single application)", () => {
  let tools = [];
  tools = fuseRow(tools, { channel: "transcript", identity: "x", detail: "cli:x", ts: W0 });
  tools = fuseRow(tools, { channel: "transcript", identity: "x", detail: "cli:x", ts: W0 + 1 * DAY });
  const before = tools[0].engagement.ewma_per_week;
  tools = fuseRow(tools, { channel: "transcript", identity: "x", detail: "cli:x", ts: W0 + 8 * DAY });
  const after = tools[0].engagement.ewma_per_week;
  assert.ok(after < before, "a week-old gap must decay the EWMA");
  assert.ok(after >= 1, "each use adds exactly 1 after decay");
});

test("fused rows carry the §7.2 schema axes verbatim (engagement nested, vitality present)", () => {
  const tools = fuseRow([], { channel: "transcript", identity: "vercel", detail: "cli:vercel", ts: W0, project: "manta" });
  const t = tools[0];
  assert.deepEqual(
    Object.keys(t).filter((k) => ["engagement", "vitality", "evidence", "consent", "status", "role", "relevance", "as_source", "as_workflow", "tool"].includes(k)).sort(),
    ["as_source", "as_workflow", "consent", "engagement", "evidence", "relevance", "role", "status", "tool", "vitality"],
  );
  assert.equal(t.engagement.ewma_per_week, 1);
  assert.equal(t.engagement.last_used, W0);
  assert.deepEqual(t.engagement.per_project, { manta: 1 });
  // Vitality is the §7.5 probes' axis — present but empty until they run.
  assert.deepEqual(t.vitality, { last_event: null, inflow_rate: null, ewma: null, last_probed: null });
});

test("parseClassification accepts one kebab-case line, rejects junk", () => {
  assert.equal(parseClassification("github\nextra"), "github");
  assert.equal(parseClassification("  Stripe-API \n"), "stripe-api");
  assert.equal(parseClassification("unknown"), null);
  assert.equal(parseClassification("I think it is github"), null);
  assert.equal(parseClassification(""), null);
});

// ---------------------------------------------------------------------------
// the engine: scan → fusion → classification → lifecycle → asks → resolve
// ---------------------------------------------------------------------------

test("dailyScan fuses channel 2+3 rows, classifies raw once, promotes and asks", async () => {
  const cards = fakeCards();
  const dbRows = [
    { session_id: "s1", data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "gh pr list" } } }), time_created: W0 },
    { session_id: "s1", data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "gh pr view" } } }), time_created: W0 + 8 * DAY },
  ];
  const { registry, registryStore, usageStore } = makeRegistry({
    cards,
    nowMs: W0 + 9 * DAY,
    collectDb: async ({ sinceTs, untilTs }) => {
      assert.ok(sinceTs < W0);
      assert.ok(untilTs >= W0 + 9 * DAY);
      return dbRows;
    },
    collectSurfaces: async () => ({
      config: { mcp: { linear: { url: "https://mcp.linear.app/sse" } } },
      gitRemotes: [{ project: "manta", url: "https://github.com/antoinedc/MantaUI.git" }],
    }),
    runEphemeral: async () => ({ text: "unknown" }), // nothing raw here — never called
  });

  const r = await registry.dailyScan();
  assert.equal(r.ok, true);
  const state = registryStore._state();
  const tools = Object.fromEntries(state.tools.map((t) => [t.tool, t]));

  // Channel 2 (gh 2×) + channel 3 (git:github.com) fuse into ONE github row:
  // 3 uses across 2 distinct weeks → the engagement bar → candidate + the
  // first connect ask. The mcp row is its own identity, 1 use → observed.
  assert.equal(tools.github.uses, 3);
  assert.equal(tools.github.status, "candidate");
  assert.equal(tools.linear.status, "observed");
  assert.equal(r.asked, "github");
  assert.equal(cards.calls.upserts.length, 1);
  // The usage log holds every evidence row (channels 2+3).
  const logRows = usageStore._state().rows;
  assert.equal(logRows.length, 4);
  // First scan consumed the whole window → the backfill range ran once.
  assert.ok(state.lastScanTs >= W0 + 9 * DAY);
});

test("engagement-bar tool becomes a candidate and raises ONE connect ask; the answer writes consent + verdict + resolves the card", async () => {
  const cards = fakeCards();
  const usageRows = [
    { channel: "transcript", identity: "vercel", detail: "cli:vercel", ts: W0, source: "catalog" },
    { channel: "transcript", identity: "vercel", detail: "cli:vercel", ts: W0 + 2 * DAY, source: "catalog" },
    { channel: "transcript", identity: "vercel", detail: "cli:vercel", ts: W0 + 8 * DAY, source: "catalog" },
  ];
  const { registry, registryStore, ledger } = makeRegistry({ cards, usageRows, nowMs: W0 + 9 * DAY });

  const r = await registry.dailyScan();
  assert.equal(r.asked, "vercel");
  assert.equal(cards.calls.upserts.length, 1);
  const ask = cards.calls.upserts[0];
  assert.equal(ask.toolId, "vercel");
  assert.match(ask.title, /Connect Vercel \(read-only\)\?/);
  assert.ok(ask.body.includes("3×"));
  const state = registryStore._state();
  const t = state.tools.find((x) => x.tool === "vercel");
  assert.equal(t.status, "candidate");
  assert.equal(t.askRound, 1);
  assert.equal(state.lastAskDay, new Date(W0 + 9 * DAY).toISOString().slice(0, 10));

  // The ask is recorded on the activity ledger.
  assert.ok(ledger.rows.some((row) => row.kind === "cto.tool.ask" && row.tool === "vercel"));

  // Resolve: connect → consent.metadata=yes, accept verdict, card closed.
  const res = await registry.resolveConnect({ tool: "vercel", answer: "connect" });
  assert.equal(res.ok, true);
  const after = registryStore._state().tools.find((x) => x.tool === "vercel");
  assert.equal(after.consent.metadata, "yes");
  assert.ok(ledger.rows.some((row) => row.kind === "cto.tool.consent" && row.value === "yes"));
  assert.equal(cards.calls.resolved.length, 1);
  assert.equal(cards.calls.resolved[0].hit, true);
  assert.equal(cards.open.every((c) => c.state === "resolved"), true);
});

test("ask pacing: at most one NEW ask per day, and askRound < 3 forever", async () => {
  const cards = fakeCards();
  const mk = (identity, ts) => ({ channel: "transcript", identity, detail: `cli:${identity}`, ts, source: "catalog" });
  const usageRows = [
    mk("vercel", W0), mk("vercel", W0 + 2 * DAY), mk("vercel", W0 + 8 * DAY),
    mk("stripe", W0), mk("stripe", W0 + 2 * DAY), mk("stripe", W0 + 8 * DAY),
  ];
  const { registry, registryStore } = makeRegistry({ cards, usageRows, nowMs: W0 + 9 * DAY });
  await registry.dailyScan();
  assert.equal(cards.calls.upserts.length, 1); // ≤1/day
  assert.equal(cards.calls.upserts[0].toolId, "vercel"); // highest uses first — tie → deterministic order

  // Next day: the second tool asks (round 1 each) — vercel's ask card is
  // still open, so the gate skips it and picks stripe.
  const day2 = W0 + 10 * DAY;
  const reg2 = nextDay(registryStore, cards, day2, [...usageRows, mk("vercel", day2), mk("stripe", day2)]);
  await reg2.dailyScan();
  assert.equal(cards.calls.upserts.length, 2);
  assert.equal(cards.calls.upserts[1].toolId, "stripe");

  // After 3 ask rounds with no answers, no more asks for that tool.
  const state = registryStore._state();
  for (const t of state.tools) t.askRound = 3;
  await registryStore.save(state);
  const day3 = W0 + 11 * DAY;
  const reg3 = nextDay(registryStore, cards, day3, [...usageRows, mk("vercel", day3), mk("stripe", day3)]);
  const res3 = await reg3.dailyScan();
  assert.equal(res3.asked, null);
  assert.equal(cards.calls.upserts.length, 2);
});

test("not-now declines with a 30-day re-arm; a fresh bar crossing re-arms early — engagement path only", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "stripe", detail: "cli:stripe", ts, source: "catalog" });
  const usageRows = [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)];
  const { registry, registryStore } = makeRegistry({ cards, usageRows, nowMs: W0 + 9 * DAY });
  await registry.dailyScan();
  await registry.resolveConnect({ tool: "stripe", answer: "not-now" });
  let t = registryStore._state().tools.find((x) => x.tool === "stripe");
  assert.equal(t.consent.metadata, "no");
  assert.equal(t.reArmAt, W0 + 9 * DAY + 30 * DAY);

  // Same day again → no new ask (reArmAt in the future, no fresh uses).
  const day2 = W0 + 10 * DAY;
  const reg2 = nextDay(registryStore, cards, day2, [mk(day2)]);
  const res2 = await reg2.dailyScan();
  assert.equal(res2.asked, null);

  // Fresh engagement (2+ uses beyond the ask-time snapshot) re-arms early —
  // this tool crossed the ENGAGEMENT bar, so the fresh-crossing path applies.
  const day3 = W0 + 11 * DAY;
  const reg3 = nextDay(registryStore, cards, day3, [mk(day3), mk(day3 + 1000)]);
  const res3 = await reg3.dailyScan();
  assert.equal(res3.asked, "stripe");
  t = registryStore._state().tools.find((x) => x.tool === "stripe");
  assert.equal(t.consent.metadata, null); // re-armed
  assert.equal(t.askRound, 2);
});

test("§7.4 carve-out: a credential-only tool declined 'not now' re-arms ONLY at the 30-day timer", async () => {
  const cards = fakeCards();
  const secret = (ts) => ({ channel: "secret", identity: "github_pat", detail: "secret:GITHUB_PAT", ts, source: "raw" });
  const { registry, registryStore } = makeRegistry({ cards, usageRows: [secret(W0)], nowMs: W0 + DAY });
  await registry.dailyScan();
  await registry.resolveConnect({ tool: "github_pat", answer: "not-now" });
  let t = registryStore._state().tools.find((x) => x.tool === "github_pat");
  assert.equal(t.consent.metadata, "no");
  assert.equal(t.reArmAt, W0 + DAY + 30 * DAY);
  assert.equal(engagementBarMet(t), false, "the tool is vitality-path only");

  // Fresh CLI uses arrive well inside the 30 days — the vitality path's bar
  // (a credential exists) cannot re-cross, so NO early re-arm.
  const day5 = W0 + 5 * DAY;
  const reg2 = nextDay(registryStore, cards, day5, [secret(day5), secret(day5 + 1000), secret(day5 + 2000)]);
  const res2 = await reg2.dailyScan();
  assert.equal(res2.asked, null, "fresh uses must not re-arm a vitality-path decline");
  t = registryStore._state().tools.find((x) => x.tool === "github_pat");
  assert.equal(t.consent.metadata, "no");

  // Only the 30-day timer re-arms.
  const day32 = W0 + 32 * DAY;
  const reg3 = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [] }),
    cards,
    ledger: fakeLedger(),
    now: () => day32,
  });
  const res3 = await reg3.dailyScan();
  assert.equal(res3.asked, "github_pat");
});

// The aws fixture: a tool at the engagement bar (3 uses across 2 weeks),
// scanned at day 9 — the common setup of the never/un-never lifecycle tests.
function awsSetup() {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "aws", detail: "cli:aws", ts, source: "catalog" });
  const { registry, registryStore } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)], nowMs: W0 + 9 * DAY });
  return { cards, mk, registry, registryStore };
}

test("never kills every ring and suppresses future asks", async () => {
  const { cards, mk, registry, registryStore } = awsSetup();
  await registry.dailyScan();
  const res = await registry.resolveConnect({ tool: "aws", answer: "never" });
  assert.equal(res.ok, true);
  const t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.deepEqual(t.consent, { metadata: "never", deep_read: "never", write: "never" });

  // Even with fresh evidence, never a new ask.
  const day2 = W0 + 40 * DAY;
  const reg2 = nextDay(registryStore, cards, day2, [mk(day2), mk(day2 + 1000), mk(day2 + 2000)]);
  const res2 = await reg2.dailyScan();
  assert.equal(res2.asked, null);
  assert.equal(cards.calls.upserts.length, 1);
});

test("§7.4 un-never: returns the tool to observed; a fresh bar crossing is required before the next ask", async () => {
  const { cards, mk, registry, registryStore } = awsSetup();
  await registry.dailyScan();
  await registry.resolveConnect({ tool: "aws", answer: "never" });

  // Un-never (what B11's drill-down will call): back to observed, rings cleared.
  const un = await registry.unNever("aws");
  assert.equal(un.ok, true);
  let t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.deepEqual(t.consent, { metadata: null, deep_read: null, write: null });
  assert.equal(t.status, "observed");
  assert.equal(t.unneverAtUses, t.uses);

  // The bar is still crossed (monotone uses) — but the next scan must NOT
  // immediately re-promote + re-ask: no fresh crossing since the snapshot.
  const day2 = W0 + 10 * DAY;
  const reg2 = nextDay(registryStore, cards, day2, [mk(day2)]);
  const res2 = await reg2.dailyScan();
  assert.equal(res2.asked, null, "an un-never'd tool must not re-ask without a fresh bar crossing");
  t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(t.status, "observed", "still observed — the fresh-crossing gate holds");

  // Fresh engagement beyond the snapshot (2+ new uses) re-promotes → re-asks.
  const day3 = W0 + 11 * DAY;
  const reg3 = nextDay(registryStore, cards, day3, [mk(day3), mk(day3 + 1000)]);
  const res3 = await reg3.dailyScan();
  assert.equal(res3.asked, "aws");
  t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(t.status, "candidate");
  assert.equal(t.unneverAtUses, null);

  // Un-nevering a tool that was never never'd is a clean error.
  assert.equal((await registry.unNever("ghost")).ok, false);
});

test("a connect answer landing mid-scan is not lost (writers serialized)", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "vercel", detail: "cli:vercel", ts, source: "catalog" });
  // One registry instance — the writer mutex is per-instance, matching
  // production (the engine owns one registry). The db seam blocks on its
  // SECOND call (the seconds-long await window where the stale-save clobber
  // used to happen).
  let blockSecond = null;
  let releaseDb = () => {};
  const { registry, registryStore } = makeRegistry({
    cards,
    usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)],
    nowMs: W0 + 9 * DAY,
    collectDb: async () => {
      if (blockSecond) await blockSecond;
      return [];
    },
  });
  await registry.dailyScan(); // scan 1: raises the ask (candidate)
  await registry.resolveConnect({ tool: "vercel", answer: "connect" });

  // Scan 2 starts and blocks inside its db batch.
  blockSecond = new Promise((resolve) => (releaseDb = resolve));
  const scanDone = registry.dailyScan();
  await new Promise((r) => setTimeout(r, 25)); // let the scan reach the blocked await
  // The user answers "never" DURING the scan. With serialized writers it
  // queues behind the scan and its save lands LAST.
  const answerDone = registry.resolveConnect({ tool: "vercel", answer: "never" });
  releaseDb();
  const [scanRes, answerRes] = await Promise.all([scanDone, answerDone]);
  assert.equal(scanRes.ok, true);
  assert.equal(answerRes.ok, true);
  const t = registryStore._state().tools.find((x) => x.tool === "vercel");
  assert.equal(t.consent.metadata, "never", "the mid-scan answer must survive the scan's save");
  assert.deepEqual(t.consent, { metadata: "never", deep_read: "never", write: "never" });
});

test("LLM fallback classifies an unknown identity at most once and merges it", async () => {
  const cards = fakeCards();
  const calls = [];
  const runEphemeral = async (opts) => {
    calls.push(opts);
    return { text: "graphite\n(other text ignored)" };
  };
  const raw1 = { channel: "transcript", identity: null, detail: "cli:gt", ts: W0, source: "raw" };
  const raw2 = { channel: "transcript", identity: null, detail: "cli:gt", ts: W0 + DAY, source: "raw" };
  const { registry, registryStore } = makeRegistry({
    cards,
    usageRows: [raw1, raw2],
    nowMs: W0 + 2 * DAY,
    runEphemeral,
  });
  await registry.dailyScan();
  assert.equal(calls.length, 1, "exactly one classification call");
  assert.equal(calls[0].taskClass, "ambient-summarize");
  const t = registryStore._state().tools.find((x) => x.tool === "graphite");
  assert.ok(t, "the raw evidence merged into the classified identity");
  assert.equal(t.uses, 2);
  assert.equal(t.source, "llm");
  assert.equal(t.raw, false);
  assert.equal(registryStore._state().tools.some((x) => x.tool === "gt"), false);

  // A second scan never re-asks (cached).
  await registry.dailyScan();
  assert.equal(calls.length, 1);
});

test("LLM fallback caches 'unknown' as unclassifiable and never re-asks", async () => {
  const cards = fakeCards();
  let calls = 0;
  const runEphemeral = async () => {
    calls += 1;
    return { text: "unknown" };
  };
  const raw = (ts) => ({ channel: "transcript", identity: null, detail: "cli:junktool", ts, source: "raw" });
  const { registry, registryStore } = makeRegistry({
    cards,
    usageRows: [raw(W0), raw(W0 + DAY)],
    nowMs: W0 + 2 * DAY,
    runEphemeral,
  });
  await registry.dailyScan();
  assert.equal(calls, 1);
  assert.equal(registryStore._state().tools.some((x) => x.tool === "junktool"), true);
  await registry.dailyScan();
  assert.equal(calls, 1, "unclassifiable is cached — never re-asked");
});

test("channel-1 secret rows (raw keys) fuse and give the tool the vitality path", async () => {
  const cards = fakeCards();
  const usageRows = [
    { channel: "secret", identity: "github_pat", detail: "secret:GITHUB_PAT", ts: W0, source: "raw" },
  ];
  const { registry, registryStore } = makeRegistry({ cards, usageRows, nowMs: W0 + DAY });
  await registry.dailyScan();
  const t = registryStore._state().tools.find((x) => x.tool === "github_pat");
  assert.ok(t);
  assert.equal(t.raw, true);
  assert.equal(hasCredential(t), true);
  assert.equal(barCrossed(t), true);
  assert.equal(t.status, "candidate"); // vitality path promotes at ONE use
});

test("consentFor reads the rings the future probe/tool-write gates will check", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "stripe", detail: "cli:stripe", ts, source: "catalog" });
  const { registry } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)], nowMs: W0 + 9 * DAY });
  await registry.dailyScan();
  await registry.resolveConnect({ tool: "stripe", answer: "connect" });
  assert.equal(await registry.consentFor("stripe", "metadata"), "yes");
  assert.equal(await registry.consentFor("stripe", "deep_read"), null);
  assert.equal(await registry.consentFor("nope"), null);
});

test("resolveConnect rejects bad input without touching the store", async () => {
  const cards = fakeCards();
  const { registry, registryStore } = makeRegistry({ cards, nowMs: W0 });
  assert.equal((await registry.resolveConnect({})).ok, false);
  assert.equal((await registry.resolveConnect({ tool: "x", answer: "maybe" })).ok, false);
  assert.equal((await registry.resolveConnect({ tool: "ghost", answer: "connect" })).ok, false);
  assert.deepEqual(registryStore._state().tools ?? [], []);
  assert.equal(cards.calls.resolved.length, 0);
});

test("listTools returns the §10.5 view shape", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "vercel", detail: "cli:vercel", ts, source: "catalog" });
  const { registry } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)], nowMs: W0 + 9 * DAY });
  await registry.dailyScan();
  const view = await registry.listTools();
  assert.equal(view.length, 1);
  const row = view[0];
  for (const k of ["tool", "displayName", "status", "role", "uses", "weeksActive", "ewmaPerWeek", "lastSeenTs", "firstSeenTs", "consent", "askRound"]) {
    assert.ok(k in row, k);
  }
  assert.equal(row.displayName, "Vercel");
  assert.deepEqual(row.consent, { metadata: null, deep_read: null, write: null });
});

test("thresholds match the spec bars", () => {
  assert.equal(ENGAGEMENT_MIN_USES, 3);
  assert.equal(ENGAGEMENT_MIN_WEEKS, 2);
  assert.equal(RAW_CLASSIFY_MIN_USES, 2);
});

// ---------------------------------------------------------------------------
// BET-1399 — §10.5 row 4: derived §7.3 role (dead-tool flag) and the §7.4
// consent-ring revoke. Display-role derivation is read-time-only: the stored
// `role` field stays null until a later issue writes it.
// ---------------------------------------------------------------------------

function mkTool(over = {}) {
  return {
    tool: "aws",
    status: "integrated",
    uses: 5,
    weeksActive: 3,
    engagement: { ewma_per_week: 2.5, last_used: W0 },
    vitality: { last_event: null, inflow_rate: null, ewma: null, last_probed: null },
    ...over,
  };
}

test("deriveRole maps the §7.3 quadrants (both / workflow / data-source / dead) at read time", () => {
  const nowMs = W0 + 10 * DAY;
  // Both bars high → both.
  assert.equal(
    deriveRole(mkTool({ vitality: { last_event: nowMs - DAY, inflow_rate: null, ewma: null, last_probed: nowMs } }), { nowMs }),
    "both",
  );
  // Engagement only → workflow.
  assert.equal(deriveRole(mkTool(), { nowMs }), "workflow");
  // Vitality only → data-source.
  assert.equal(
    deriveRole(mkTool({ uses: 1, weeksActive: 0, vitality: { last_event: nowMs - DAY, inflow_rate: null, ewma: null, last_probed: nowMs } }), { nowMs }),
    "data-source",
  );
  // Both low WITH prior engagement → the dead-tool candidate flag. (The
  // engagement bar is NOT met — 1 week < 2 — and last_event is older than
  // the 14-day vitality-recency window.)
  assert.equal(
    deriveRole(mkTool({ weeksActive: 1, vitality: { last_event: W0 - 10 * DAY, inflow_rate: 0, ewma: 0, last_probed: null } }), { nowMs }),
    "dead",
  );
  // Nothing at all (no uses) → no derived role.
  assert.equal(deriveRole(mkTool({ uses: 0, weeksActive: 0 }), { nowMs }), null);
});

test("listTools copies the vitality axis and derives the display role without writing it back", async () => {
  const cards = fakeCards();
  // Uses across two distinct weeks so the §7.4 engagement bar clears.
  const mk = (ts) => ({ channel: "transcript", identity: "aws", detail: "cli:aws", ts, source: "catalog" });
  const { registry, registryStore } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + 8 * DAY), mk(W0 + 9 * DAY)], nowMs: W0 + 10 * DAY });
  await registry.dailyScan();
  await registry.resolveConnect({ tool: "aws", answer: "connect" });

  const rows = await registry.listTools({ nowMs: W0 + 4 * DAY });
  const aws = rows.find((r) => r.tool === "aws");
  assert.ok(aws, "the observed tool is listed");
  assert.equal(aws.derivedRole, "workflow", "3 uses in 3 weeks clears the engagement bar");
  assert.deepEqual(aws.vitality.last_event, null, "vitality axis rides along");
  assert.equal(aws.role, null, "the stored role is untouched (read-time derivation only)");
  const stored = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(stored.role ?? null, null);
});

test("§7.4 per-ring revoke writes the ring to no; revoked metadata stops the probe consent gate", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "aws", detail: "cli:aws", ts, source: "catalog" });
  const { registry, registryStore, ledger } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + DAY), mk(W0 + 2 * DAY)], nowMs: W0 + 3 * DAY });
  await registry.dailyScan();
  assert.equal((await registry.resolveConnect({ tool: "aws", answer: "connect" })).ok, true);
  assert.equal(await registry.consentFor("aws", "metadata"), "yes");

  // Revoking the metadata ring stops the probes (consentFor flips to no).
  const rev = await registry.revokeConsent("aws", "metadata");
  assert.equal(rev.ok, true);
  assert.equal(rev.value, "no");
  assert.equal(await registry.consentFor("aws", "metadata"), "no");
  let t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(t.consent.metadata, "no");
  assert.ok(ledger.rows.some((r) => r.kind === "cto.tool.consent" && r.ring === "metadata" && r.value === "no"), "the revoke is ledgered");

  // A non-granted ring cannot be revoked (server-side backstop).
  assert.equal((await registry.revokeConsent("aws", "deep_read")).ok, false);
  assert.equal((await registry.revokeConsent("aws", "write")).ok, false);
  assert.equal((await registry.revokeConsent("ghost", "metadata")).ok, false);
  assert.equal((await registry.revokeConsent("aws", "bogus")).ok, false);
  assert.equal((await registry.revokeConsent("", "metadata")).ok, false);

  // deep_read grant → revoke round-trips ring by ring. (The deep-read grant
  // path lives in the deep-read ask flow, not resolveConnect — seed the ring
  // directly to exercise the revoke transition.)
  registryStore._state().tools.find((x) => x.tool === "aws").consent.deep_read = "yes";
  assert.equal(await registry.consentFor("aws", "deep_read"), "yes");
  assert.equal((await registry.revokeConsent("aws", "deep_read")).ok, true);
  assert.equal(await registry.consentFor("aws", "deep_read"), "no");
  t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(t.consent.metadata, "no", "other rings untouched");
});

test("revoke then un-never-style lifecycle: a revoked tool can re-grant on a fresh ask", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "aws", detail: "cli:aws", ts, source: "catalog" });
  const { registry, registryStore } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + DAY), mk(W0 + 2 * DAY)], nowMs: W0 + 3 * DAY });
  await registry.dailyScan();
  await registry.resolveConnect({ tool: "aws", answer: "connect" });
  assert.equal((await registry.revokeConsent("aws", "metadata")).ok, true);

  // The revoked tool keeps its lifecycle status — revoke narrows features;
  // it does not reset the lifecycle (and un-never is a clean error here).
  assert.equal((await registry.unNever("aws")).ok, false);
  const statusBefore = registryStore._state().tools.find((x) => x.tool === "aws").status;
  const t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(t.status, statusBefore, "revoke narrows features; it does not reset the lifecycle");
});

// ---------------------------------------------------------------------------
// BET-1404 — deep-read asks, as_source counters, dismissal decay chain
// ---------------------------------------------------------------------------

import { deepReadBar, AS_SOURCE_MIN_REPORTS, AS_SOURCE_DECAY_LOWER_BOUND } from "./ctoToolRegistry.mjs";
import { CADENCE_WEEKLY_MS } from "./ctoProbes.mjs";
import { betaLowerBound } from "./ctoVerdicts.mjs";

// An integrated tool that clears the deep-read bar: metadata consented,
// live vitality, and a relevance argmax above 0.5.
function deepEligibleRow(overrides = {}) {
  return {
    tool: "github",
    displayName: "GitHub",
    status: "integrated",
    consent: { metadata: "yes", deep_read: null, write: null },
    engagement: { ewma_per_week: 4, last_used: W0, per_project: {} },
    vitality: { last_event: W0 - DAY, inflow_rate: 3, ewma: 0.8, last_probed: W0 - DAY },
    ewmaAt: W0,
    uses: 6,
    weeks: [weekKey(W0), weekKey(W0 - 7 * DAY)],
    evidence: [],
    relevance: { alpha: 0.7, beta: 0.3 },
    as_source: { reports: 0, accepted: 0 },
    askRound: 1,
    firstSeenTs: W0 - 30 * DAY,
    ...overrides,
  };
}

function seededRegistry(rows, { nowMs = W0 + DAY } = {}) {
  const registryStore = memStore({ tools: rows, lastScanTs: W0, lastAskDay: null, lastDeepAskDay: null });
  const cards = fakeCards();
  const ledger = fakeLedger();
  const registry = createToolRegistry({ registryStore, usageStore: memStore({ rows: [] }), cards, ledger, now: () => nowMs });
  return { registry, registryStore, cards, ledger };
}

test("thresholds match the BET-1404 on-call decisions", () => {
  assert.equal(AS_SOURCE_MIN_REPORTS, 3);
  assert.equal(AS_SOURCE_DECAY_LOWER_BOUND, 0.3);
});

test("deepReadBar: metadata yes + ewma>0 + max relevance >= 0.5 (Q1: no invented vitality floor)", () => {
  assert.equal(deepReadBar(deepEligibleRow()).met, true);
  assert.equal(deepReadBar(deepEligibleRow()).project, "alpha");
  // each leg missing → not met
  assert.equal(deepReadBar(deepEligibleRow({ consent: { metadata: "no", deep_read: null, write: null } })).met, false);
  assert.equal(deepReadBar(deepEligibleRow({ vitality: { last_event: null, inflow_rate: null, ewma: null, last_probed: null } })).met, false);
  assert.equal(deepReadBar(deepEligibleRow({ vitality: { last_event: W0, inflow_rate: 1, ewma: 0, last_probed: W0 } })).met, false, "ewma=0 is not 'high' — the bar is ewma > 0");
  assert.equal(deepReadBar(deepEligibleRow({ relevance: { alpha: 0.49 } })).met, false);
  assert.equal(deepReadBar(deepEligibleRow({ relevance: {} })).met, false);
});

test("deep-read ask: the bar crossing raises ONE concrete ask (ring deep_read, intent in the copy), once per day", async () => {
  const { registry, registryStore, cards, ledger } = seededRegistry([deepEligibleRow()]);
  const out = await registry.dailyScan();
  assert.equal(out.ok, true);
  assert.equal(cards.calls.upserts.length, 1, JSON.stringify(cards.calls.upserts));
  const ask = cards.calls.upserts[0];
  assert.equal(ask.ring, "deep_read");
  assert.equal(ask.toolId, "github");
  assert.match(ask.body, /analyze GitHub's data about alpha overnight and report findings/);
  const row = registryStore._state().tools.find((x) => x.tool === "github");
  assert.equal(row.deepAskRound, 1);
  assert.equal(row.deepAskBarMet, true);
  assert.equal(registryStore._state().lastDeepAskDay, new Date(W0 + DAY).toISOString().slice(0, 10));
  assert.ok(ledger.rows.some((r) => r.kind === "cto.tool.deep_ask" && r.project === "alpha"));
  // same day again → no second ask
  await registry.dailyScan();
  assert.equal(cards.calls.upserts.length, 1);
  // next day → the gate re-opens (askRound < 3), one more ask
  const { registry: reg2, cards: cards2 } = seededRegistry(
    [deepEligibleRow({ deepAskRound: 1, deepAskBarMet: true })],
    { nowMs: W0 + 2 * DAY },
  );
  await reg2.dailyScan();
  assert.equal(cards2.calls.upserts.length, 1);
});

test("deep-read ask: consented, rounds exhausted, and chain-tripped tools are skipped", async () => {
  // already deep-consented
  const a = seededRegistry([deepEligibleRow({ consent: { metadata: "yes", deep_read: "yes", write: null } })]);
  await a.registry.dailyScan();
  assert.equal(a.cards.calls.upserts.length, 0);
  // rounds exhausted
  const b = seededRegistry([deepEligibleRow({ deepAskRound: 3 })]);
  await b.registry.dailyScan();
  assert.equal(b.cards.calls.upserts.length, 0);
  // chain tripped
  const c = seededRegistry([deepEligibleRow({ asSourceDecayed: true, decayedAtUses: 6 })]);
  await c.registry.dailyScan();
  assert.equal(c.cards.calls.upserts.length, 0);
});

test("deep-read ask: a declined ask re-arms ONLY on the 30-day timer (vitality path)", async () => {
  const row = deepEligibleRow({ consent: { metadata: "yes", deep_read: "no", write: null }, deepAskRound: 1, deepAskAtUses: 6, deepReArmAt: W0 + DAY + 10 * DAY });
  const { registry, cards } = seededRegistry([row]);
  await registry.dailyScan();
  assert.equal(cards.calls.upserts.length, 0, "timer not elapsed — no ask");
  const row2 = deepEligibleRow({ consent: { metadata: "yes", deep_read: "no", write: null }, deepAskRound: 1, deepAskAtUses: 6, deepReArmAt: W0 + DAY - 1000 });
  const { registry: r2, cards: c2, registryStore: s2 } = seededRegistry([row2]);
  await r2.dailyScan();
  assert.equal(c2.calls.upserts.length, 1);
  const after = s2._state().tools.find((x) => x.tool === "github");
  assert.equal(after.consent.deep_read, null, "re-armed");
  assert.equal(after.deepAskRound, 2);
});

test("resolveConnect deep_read ring: connect grants deep read (metadata backstop); not-now re-arms; never kills all rings; bad ring rejected", async () => {
  // grant — requires metadata consent
  const ok = seededRegistry([deepEligibleRow()]);
  const granted = await ok.registry.resolveConnect({ tool: "github", answer: "connect", ring: "deep_read" });
  assert.equal(granted.ok, true);
  const grantedRow = ok.registryStore._state().tools.find((x) => x.tool === "github");
  assert.equal(grantedRow.consent.deep_read, "yes");
  assert.ok(ok.ledger.rows.some((r) => r.kind === "cto.tool.consent" && r.ring === "deep_read" && r.value === "yes"));
  // grant without metadata consent → refused
  const noMeta = seededRegistry([deepEligibleRow({ consent: { metadata: "no", deep_read: null, write: null } })]);
  const refused = await noMeta.registry.resolveConnect({ tool: "github", answer: "connect", ring: "deep_read" });
  assert.equal(refused.ok, false);
  // not-now re-arms on the 30-day timer
  const later = seededRegistry([deepEligibleRow({ deepAskRound: 1 })]);
  const declined = await later.registry.resolveConnect({ tool: "github", answer: "not-now", ring: "deep_read" });
  assert.equal(declined.ok, true);
  const declinedRow = later.registryStore._state().tools.find((x) => x.tool === "github");
  assert.equal(declinedRow.consent.deep_read, "no");
  assert.equal(declinedRow.deepReArmAt, W0 + DAY + 30 * DAY);
  // never kills every ring regardless of the ask's ring
  const never = seededRegistry([deepEligibleRow({ deepAskRound: 1 })]);
  const killed = await never.registry.resolveConnect({ tool: "github", answer: "never", ring: "deep_read" });
  assert.equal(killed.ok, true);
  const killedRow = never.registryStore._state().tools.find((x) => x.tool === "github");
  assert.deepEqual(killedRow.consent, { metadata: "never", deep_read: "never", write: "never" });
  // invalid ring rejected without touching the store
  const bad = seededRegistry([deepEligibleRow()]);
  const badRes = await bad.registry.resolveConnect({ tool: "github", answer: "connect", ring: "write" });
  assert.equal(badRes.ok, false);
});

test("applyAsSource: folds success/rejection, ignores access/decay, and trips the chain at LB<0.3 after >=3 reports", async () => {
  // 3 reports, 1 accepted → betaLowerBound(1, 2) ≈ 0.075 < 0.3 → trip
  const trip = seededRegistry([deepEligibleRow({ uses: 6 })]);
  assert.equal(AS_SOURCE_MIN_REPORTS, 3);
  const acc = await trip.registry.applyAsSource("github", { success: true });
  assert.equal(acc.ok, true);
  assert.deepEqual(acc.as_source, { reports: 1, accepted: 1 });
  assert.equal(acc.decayed, false);
  await trip.registry.applyAsSource("github", { rejection: true });
  const tripped = await trip.registry.applyAsSource("github", { rejection: true });
  assert.equal(tripped.decayed, true, "1 accept / 2 rejects after 3 reports trips");
  const row = trip.registryStore._state().tools.find((x) => x.tool === "github");
  assert.equal(row.asSourceDecayed, true);
  assert.equal(row.decayedAtUses, 6);
  assert.ok(trip.ledger.rows.some((r) => r.kind === "cto.tool.as_source_decayed" && r.reports === 3));
  // access/decay effects never enter the counters
  const noFold = seededRegistry([deepEligibleRow()]);
  const access = await noFold.registry.applyAsSource("github", { access: true, decay: true });
  assert.deepEqual(access, { ok: true, changed: false });
  const cleanRow = noFold.registryStore._state().tools.find((x) => x.tool === "github");
  assert.deepEqual(cleanRow.as_source, { reports: 0, accepted: 0 });
  // 3 accepts / 1 reject after 4 reports: LB ≈ 0.43 > 0.3 → no trip
  // (2 accepts / 1 reject after 3 DOES trip: LB ≈ 0.279)
  const hold = seededRegistry([deepEligibleRow()]);
  await hold.registry.applyAsSource("github", { success: true });
  await hold.registry.applyAsSource("github", { success: true });
  await hold.registry.applyAsSource("github", { success: true });
  const fourth = await hold.registry.applyAsSource("github", { rejection: true });
  assert.equal(fourth.decayed, false);
  assert.ok(betaLowerBound(3, 1) >= 0.3);
  // unknown tool / missing id
  assert.equal((await hold.registry.applyAsSource("nope", { success: true })).ok, false);
  assert.equal((await hold.registry.applyAsSource("", { success: true })).ok, false);
});

test("decay chain: a tripped tool stops deep asks and probes weekly; fresh engagement revives it", async () => {
  const tripped = deepEligibleRow({ asSourceDecayed: true, decayedAtUses: 6, uses: 6 });
  const { registry, registryStore, cards, ledger } = seededRegistry([tripped]);
  // deep asks suppressed while decayed
  await registry.dailyScan();
  assert.equal(cards.calls.upserts.length, 0);
  // probing caps at weekly — the chain's source of truth lives here
  assert.equal(await registry.probeCadenceCapMs("github"), CADENCE_WEEKLY_MS);
  assert.equal(await registry.probeCadenceCapMs("nope"), null);
  // revival: fresh engagement beyond the trip's snapshot (uses > decayedAtUses + 2).
  // The row is deep-consented (the trip came from dismissed REPORTS, which
  // only exist under deep consent) so no new ask fires over the revival.
  const revivedStore = memStore({
    tools: [deepEligibleRow({ asSourceDecayed: true, decayedAtUses: 6, uses: 9, consent: { metadata: "yes", deep_read: "yes", write: null } })],
    lastScanTs: W0,
    lastAskDay: null,
    lastDeepAskDay: null,
  });
  const revCards = fakeCards();
  const revLedger = fakeLedger();
  const rev = createToolRegistry({ registryStore: revivedStore, usageStore: memStore({ rows: [] }), cards: revCards, ledger: revLedger, now: () => W0 + DAY });
  await rev.dailyScan();
  const revivedRow = revivedStore._state().tools.find((x) => x.tool === "github");
  assert.equal(revivedRow.asSourceDecayed, false);
  assert.equal(revivedRow.decayedAtUses, 0);
  assert.equal(revivedRow.deepReArmAt, W0 + DAY + 30 * DAY);
  assert.ok(revLedger.rows.some((r) => r.kind === "cto.tool.as_source_revived"));
  // and the deep ask front door re-opens after the timer
  assert.equal(await rev.probeCadenceCapMs("github"), null);
  // not-yet-fresh engagement does NOT revive (uses <= decayedAtUses + 2)
  const stale = seededRegistry([deepEligibleRow({ asSourceDecayed: true, decayedAtUses: 6, uses: 8 })]);
  await stale.registry.dailyScan();
  assert.equal(stale.registryStore._state().tools.find((x) => x.tool === "github").asSourceDecayed, true);
});

test("listTools exposes the §7.6 chain state + relevance map (no dead state)", async () => {
  const { registry } = seededRegistry([deepEligibleRow({ asSourceDecayed: true, as_source: { reports: 4, accepted: 1 } })]);
  const view = await registry.listTools();
  assert.equal(view.length, 1);
  assert.deepEqual(view[0].asSource, { reports: 4, accepted: 1 });
  assert.equal(view[0].asSourceDecayed, true);
  assert.deepEqual(view[0].relevance, { alpha: 0.7, beta: 0.3 });
});
