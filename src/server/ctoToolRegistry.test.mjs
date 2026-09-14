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

// The secret store, as the registry sees it: metadata rows only (this is the
// `toMeta` shape — a value is never part of the contract). Injected in every
// test so the suite never reads the box's real store.
function fakeSecrets(keys = []) {
  return keys.map((k) => (typeof k === "string" ? { key: k, scope: "shared", hint: "" } : k));
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
function nextDay(registryStore, dayMs, rows, overrides = {}) {
  return createToolRegistry({
    registryStore,
    classificationStore: memStore(),
    usageStore: memStore({ rows }),
    ledger: fakeLedger(),
    listSecretMetas: () => [],
    now: () => dayMs,
    ...overrides,
  });
}

function makeRegistry({ usageRows = [], secrets = [], runEphemeral = null, nowMs = W0, collectDb = null, collectSurfaces = null, scaffoldProbes = null } = {}) {
  const registryStore = memStore();
  const usageStore = memStore({ rows: [...usageRows] });
  const ledger = fakeLedger();
  const registry = createToolRegistry({
    registryStore,
    classificationStore: memStore(),
    usageStore,
    ledger,
    runEphemeral,
    listSecretMetas: () => fakeSecrets(secrets),
    scaffoldProbes,
    now: () => nowMs,
    collectDb,
    collectSurfaces,
  });
  return { registry, registryStore, usageStore, ledger };
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

// A row carries the §7.2 axes and NO access field: access lives in the secret
// store, so a registry row must never look like it grants anything.
test("fused rows carry the §7.2 schema axes verbatim (engagement nested, vitality present)", () => {
  const tools = fuseRow([], { channel: "transcript", identity: "vercel", detail: "cli:vercel", ts: W0, project: "manta" });
  const t = tools[0];
  assert.deepEqual(
    Object.keys(t).filter((k) => ["engagement", "vitality", "evidence", "consent", "status", "role", "relevance", "as_source", "as_workflow", "tool"].includes(k)).sort(),
    ["as_source", "as_workflow", "engagement", "evidence", "relevance", "role", "status", "tool", "vitality"],
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
// the engine: scan → fusion → classification → lifecycle
// ---------------------------------------------------------------------------

test("dailyScan fuses channel 2+3 rows, classifies raw once, and promotes", async () => {
  const dbRows = [
    { session_id: "s1", data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "gh pr list" } } }), time_created: W0 },
    { session_id: "s1", data: JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "gh pr view" } } }), time_created: W0 + 8 * DAY },
  ];
  const { registry, registryStore, usageStore } = makeRegistry({
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
  // 3 uses across 2 distinct weeks → the engagement bar → candidate. The mcp
  // row is its own identity, 1 use → observed. Nothing asks the user
  // anything: only a stored secret grants access.
  assert.equal(tools.github.uses, 3);
  assert.equal(tools.github.status, "candidate");
  assert.equal(tools.linear.status, "observed");
  assert.equal("asked" in r, false);
  // The usage log holds every evidence row (channels 2+3).
  const logRows = usageStore._state().rows;
  assert.equal(logRows.length, 4);
  // First scan consumed the whole window → the backfill range ran once.
  assert.ok(state.lastScanTs >= W0 + 9 * DAY);
});

test("LLM fallback classifies an unknown identity at most once and merges it", async () => {
  const calls = [];
  const runEphemeral = async (opts) => {
    calls.push(opts);
    return { text: "graphite\n(other text ignored)" };
  };
  const raw1 = { channel: "transcript", identity: null, detail: "cli:gt", ts: W0, source: "raw" };
  const raw2 = { channel: "transcript", identity: null, detail: "cli:gt", ts: W0 + DAY, source: "raw" };
  const { registry, registryStore } = makeRegistry({
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
  let calls = 0;
  const runEphemeral = async () => {
    calls += 1;
    return { text: "unknown" };
  };
  const raw = (ts) => ({ channel: "transcript", identity: null, detail: "cli:junktool", ts, source: "raw" });
  const { registry, registryStore } = makeRegistry({
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
  const usageRows = [
    { channel: "secret", identity: "github_pat", detail: "secret:GITHUB_PAT", ts: W0, source: "raw" },
  ];
  const { registry, registryStore } = makeRegistry({ usageRows, nowMs: W0 + DAY });
  await registry.dailyScan();
  const t = registryStore._state().tools.find((x) => x.tool === "github_pat");
  assert.ok(t);
  assert.equal(t.raw, true);
  assert.equal(hasCredential(t), true);
  assert.equal(barCrossed(t), true);
  assert.equal(t.status, "observed"); // an unresolved identity stays observed
});

test("listTools returns the §10.5 view shape, naming the secret that grants the tool", async () => {
  const mk = (ts) => ({ channel: "transcript", identity: "vercel", detail: "cli:vercel", ts, source: "catalog" });
  const { registry } = makeRegistry({
    usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)],
    secrets: ["VERCEL_TOKEN"],
    nowMs: W0 + 9 * DAY,
  });
  await registry.dailyScan();
  const view = await registry.listTools();
  assert.equal(view.length, 1);
  const row = view[0];
  for (const k of ["tool", "displayName", "status", "role", "uses", "weeksActive", "ewmaPerWeek", "lastSeenTs", "firstSeenTs", "accessKey"]) {
    assert.ok(k in row, k);
  }
  assert.equal(row.displayName, "Vercel");
  assert.equal(row.accessKey, "VERCEL_TOKEN");
  assert.equal("consent" in row, false, "consent rings are gone — the store is the grant");
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
  // Uses across two distinct weeks so the §7.4 engagement bar clears.
  const mk = (ts) => ({ channel: "transcript", identity: "aws", detail: "cli:aws", ts, source: "catalog" });
  const { registry, registryStore } = makeRegistry({ usageRows: [mk(W0), mk(W0 + 8 * DAY), mk(W0 + 9 * DAY)], secrets: ["AWS_ACCESS_KEY_ID"], nowMs: W0 + 10 * DAY });
  await registry.dailyScan();

  const rows = await registry.listTools({ nowMs: W0 + 4 * DAY });
  const aws = rows.find((r) => r.tool === "aws");
  assert.ok(aws, "the observed tool is listed");
  assert.equal(aws.derivedRole, "workflow", "3 uses in 3 weeks clears the engagement bar");
  assert.deepEqual(aws.vitality.last_event, null, "vitality axis rides along");
  assert.equal(aws.role, null, "the stored role is untouched (read-time derivation only)");
  const stored = registryStore._state().tools.find((x) => x.tool === "aws");
  assert.equal(stored.role ?? null, null);
});

// ---------------------------------------------------------------------------
// The access grant: a key in the secret store IS the grant. These pin the
// whole rule — derived from the store (not from usage), mapped by key, full
// for every ring, unshadowable by stale consent state, and nothing without a
// key.
// ---------------------------------------------------------------------------

test("a stored secret grants access with no usage, no evidence and no registry row at all", async () => {
  const { registry, registryStore } = makeRegistry({ secrets: ["NORDVPN_TOKEN"], nowMs: W0 });
  // Nothing has ever been observed: the registry is empty.
  assert.deepEqual(registryStore._state().tools ?? [], []);
  assert.equal(await registry.consentFor("nordvpn"), "yes");
  assert.equal(registry.grantFor("nordvpn"), "NORDVPN_TOKEN");
});

test("the grant is FULL: every ring a caller asks about answers yes", async () => {
  const { registry } = makeRegistry({ secrets: ["GITHUB_PAT"], nowMs: W0 });
  for (const ring of ["metadata", "deep_read", "write", undefined]) {
    assert.equal(await registry.consentFor("github", ring), "yes", `ring ${ring}`);
  }
});

test("key → tool mapping: the required table, and an unmatched key grants nothing", async () => {
  const cases = [
    ["CAPO_MULTICA_TOKEN", "multica"],
    ["GITHUB_PAT", "github"],
    ["GITHUB_TOKEN", "github"],
    ["MODAL_TOKEN_ID", "modal"],
    ["NORDVPN_TOKEN", "nordvpn"],
  ];
  for (const [key, tool] of cases) {
    const { registry } = makeRegistry({ secrets: [key], nowMs: W0 });
    assert.equal(await registry.consentFor(tool), "yes", `${key} → ${tool}`);
    // The grant is specific: it never spills onto an unrelated tool.
    assert.equal(await registry.consentFor("stripe"), null, `${key} must not grant stripe`);
  }
  // A key made only of credential vocabulary names no tool at all.
  for (const key of ["API_KEY", "TOKEN", "SECRET"]) {
    const { registry } = makeRegistry({ secrets: [key], nowMs: W0 });
    for (const tool of ["github", "multica", "api", "key", "api_key", "token", "secret"]) {
      assert.equal(await registry.consentFor(tool), null, `${key} must grant nothing (${tool})`);
    }
  }
});

test("a tool with no matching secret gets nothing — however heavily it is used", async () => {
  const mk = (ts) => ({ channel: "transcript", identity: "stripe", detail: "cli:stripe", ts, source: "catalog" });
  const { registry } = makeRegistry({
    usageRows: [mk(W0), mk(W0 + 2 * DAY), mk(W0 + 8 * DAY)],
    secrets: [],
    nowMs: W0 + 9 * DAY,
  });
  await registry.dailyScan();
  assert.equal(await registry.consentFor("stripe"), null);
  assert.equal(registry.grantFor("stripe"), null);
  assert.equal((await registry.listTools()).find((r) => r.tool === "stripe").accessKey, null);
});

test("stale consent state from the retired ask flow cannot shadow the store either way", async () => {
  const mk = (ts) => ({ channel: "transcript", identity: "stripe", detail: "cli:stripe", ts, source: "catalog" });
  // (a) an old "never" record on the row must NOT block a stored secret.
  const denied = makeRegistry({ usageRows: [mk(W0)], secrets: ["STRIPE_API_KEY"], nowMs: W0 + DAY });
  await denied.registry.dailyScan();
  const row = denied.registryStore._state().tools.find((t) => t.tool === "stripe");
  row.consent = { metadata: "never", deep_read: "never", write: "never" };
  row.askRound = 3;
  await denied.registryStore.save(denied.registryStore._state());
  assert.equal(await denied.registry.consentFor("stripe"), "yes", "the store grants; the stale record is not consulted");

  // (b) an old "yes" record must NOT survive the secret's absence.
  const granted = makeRegistry({ usageRows: [mk(W0)], secrets: [], nowMs: W0 + DAY });
  await granted.registry.dailyScan();
  const row2 = granted.registryStore._state().tools.find((t) => t.tool === "stripe");
  row2.consent = { metadata: "yes", deep_read: "yes", write: "yes" };
  await granted.registryStore.save(granted.registryStore._state());
  assert.equal(await granted.registry.consentFor("stripe"), null, "no secret, no access — whatever the old record said");
});

test("the secret store is read at decision time — adding and deleting a key take effect immediately", async () => {
  const registryStore = memStore();
  let keys = [];
  const registry = createToolRegistry({
    registryStore,
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretMetas: () => fakeSecrets(keys),
    now: () => W0,
  });
  assert.equal(await registry.consentFor("modal"), null);
  keys = ["MODAL_TOKEN_ID"];
  assert.equal(await registry.consentFor("modal"), "yes", "adding the secret grants at once — no scan, no use");
  keys = [];
  assert.equal(await registry.consentFor("modal"), null, "deleting the secret revokes at once");
});

test("the probe scaffold follows the grant, and is handed the key NAME (never a value)", async () => {
  const scaffolded = [];
  const { registry } = makeRegistry({
    secrets: [{ key: "CAPO_MULTICA_TOKEN", scope: "shared", hint: "capo api" }],
    scaffoldProbes: async (tool, opts) => {
      scaffolded.push([tool, opts]);
      return { ok: true };
    },
    nowMs: W0,
  });
  await registry.dailyScan();
  assert.deepEqual(scaffolded, [["multica", { secret: "CAPO_MULTICA_TOKEN" }]], "one scaffold, for the key's primary tool");
});

test("a failing secret store denies rather than grants", async () => {
  const registry = createToolRegistry({
    registryStore: memStore(),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretMetas: () => {
      throw new Error("store unreadable");
    },
    now: () => W0,
  });
  assert.equal(await registry.consentFor("github"), null);
});

// ---------------------------------------------------------------------------
// BET-1404 — as_source counters + the dismissal decay chain
// ---------------------------------------------------------------------------

import { AS_SOURCE_MIN_REPORTS, AS_SOURCE_DECAY_LOWER_BOUND } from "./ctoToolRegistry.mjs";
import { CADENCE_WEEKLY_MS } from "./ctoProbes.mjs";
import { betaLowerBound } from "./ctoVerdicts.mjs";

// An integrated, live tool with a relevance argmax — the shape the §7.6
// chain tests fold counters onto.
function deepEligibleRow(overrides = {}) {
  return {
    tool: "github",
    displayName: "GitHub",
    status: "integrated",
    engagement: { ewma_per_week: 4, last_used: W0, per_project: {} },
    vitality: { last_event: W0 - DAY, inflow_rate: 3, ewma: 0.8, last_probed: W0 - DAY },
    ewmaAt: W0,
    uses: 6,
    weeks: [weekKey(W0), weekKey(W0 - 7 * DAY)],
    evidence: [],
    relevance: { alpha: 0.7, beta: 0.3 },
    as_source: { reports: 0, accepted: 0 },
    firstSeenTs: W0 - 30 * DAY,
    ...overrides,
  };
}

function seededRegistry(rows, { nowMs = W0 + DAY, secrets = [] } = {}) {
  const registryStore = memStore({ tools: rows, lastScanTs: W0 });
  const ledger = fakeLedger();
  const registry = createToolRegistry({
    registryStore,
    usageStore: memStore({ rows: [] }),
    ledger,
    listSecretMetas: () => fakeSecrets(secrets),
    now: () => nowMs,
  });
  return { registry, registryStore, ledger };
}

test("thresholds match the BET-1404 on-call decisions", () => {
  assert.equal(AS_SOURCE_MIN_REPORTS, 3);
  assert.equal(AS_SOURCE_DECAY_LOWER_BOUND, 0.3);
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

test("decay chain: a tripped tool probes weekly; fresh engagement revives it", async () => {
  const tripped = deepEligibleRow({ asSourceDecayed: true, decayedAtUses: 6, uses: 6 });
  const { registry } = seededRegistry([tripped]);
  await registry.dailyScan();
  // probing caps at weekly — the chain's source of truth lives here
  assert.equal(await registry.probeCadenceCapMs("github"), CADENCE_WEEKLY_MS);
  assert.equal(await registry.probeCadenceCapMs("nope"), null);
  // revival: fresh engagement beyond the trip's snapshot (uses > decayedAtUses + 2).
  const revivedStore = memStore({
    tools: [deepEligibleRow({ asSourceDecayed: true, decayedAtUses: 6, uses: 9 })],
    lastScanTs: W0,
  });
  const revLedger = fakeLedger();
  const rev = createToolRegistry({ registryStore: revivedStore, usageStore: memStore({ rows: [] }), ledger: revLedger, listSecretMetas: () => [], now: () => W0 + DAY });
  await rev.dailyScan();
  const revivedRow = revivedStore._state().tools.find((x) => x.tool === "github");
  assert.equal(revivedRow.asSourceDecayed, false);
  assert.equal(revivedRow.decayedAtUses, 0);
  assert.ok(revLedger.rows.some((r) => r.kind === "cto.tool.as_source_revived"));
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
