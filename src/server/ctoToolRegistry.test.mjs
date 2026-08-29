import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createToolRegistry,
  fuseRow,
  weekKey,
  barCrossed,
  engagementBarMet,
  hasCredential,
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
  const before = tools[0].ewmaPerWeek;
  tools = fuseRow(tools, { channel: "transcript", identity: "x", detail: "cli:x", ts: W0 + 8 * DAY });
  const after = tools[0].ewmaPerWeek;
  assert.ok(after < before, "a week-old gap must decay the EWMA");
  assert.ok(after >= 1, "each use adds exactly 1 after decay");
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
  const reg2 = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [...usageRows, mk("vercel", day2), mk("stripe", day2)] }),
    cards,
    ledger: fakeLedger(),
    now: () => day2,
  });
  await reg2.dailyScan();
  assert.equal(cards.calls.upserts.length, 2);
  assert.equal(cards.calls.upserts[1].toolId, "stripe");

  // After 3 ask rounds with no answers, no more asks for that tool.
  const state = registryStore._state();
  for (const t of state.tools) t.askRound = 3;
  await registryStore.save(state);
  const day3 = W0 + 11 * DAY;
  const reg3 = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [...usageRows, mk("vercel", day3), mk("stripe", day3)] }),
    cards,
    ledger: fakeLedger(),
    now: () => day3,
  });
  const res3 = await reg3.dailyScan();
  assert.equal(res3.asked, null);
  assert.equal(cards.calls.upserts.length, 2);
});

test("not-now declines with a 30-day re-arm; a fresh bar crossing re-arms early", async () => {
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
  const reg2 = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [mk(day2)] }),
    cards,
    ledger: fakeLedger(),
    now: () => day2,
  });
  const res2 = await reg2.dailyScan();
  assert.equal(res2.asked, null);

  // Fresh engagement (2+ uses beyond the ask-time snapshot) re-arms early.
  const day3 = W0 + 11 * DAY;
  const reg3 = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [mk(day3), mk(day3 + 1000)] }),
    cards,
    ledger: fakeLedger(),
    now: () => day3,
  });
  const res3 = await reg3.dailyScan();
  assert.equal(res3.asked, "stripe");
  t = registryStore._state().tools.find((x) => x.tool === "stripe");
  assert.equal(t.consent.metadata, null); // re-armed
  assert.equal(t.askRound, 2);
});

test("never kills every ring and suppresses future asks", async () => {
  const cards = fakeCards();
  const mk = (ts) => ({ channel: "transcript", identity: "aws", detail: "cli:aws", ts, source: "catalog" });
  const { registry, registryStore } = makeRegistry({ cards, usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)], nowMs: W0 + 9 * DAY });
  await registry.dailyScan();
  const res = await registry.resolveConnect({ tool: "aws", answer: "never" });
  assert.equal(res.ok, true);
  const t = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.deepEqual(t.consent, { metadata: "never", deep_read: "never", write: "never" });

  // Even with fresh evidence, never a new ask.
  const day2 = W0 + 40 * DAY;
  const reg2 = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [mk(day2), mk(day2 + 1000), mk(day2 + 2000)] }),
    cards,
    ledger: fakeLedger(),
    now: () => day2,
  });
  const res2 = await reg2.dailyScan();
  assert.equal(res2.asked, null);
  assert.equal(cards.calls.upserts.length, 1);
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
