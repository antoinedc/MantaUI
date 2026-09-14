// BET-1490: shared fail-fast guard — must stay the first import (see ctoTestGuard.mjs).
import "./ctoTestGuard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createToolRegistry,
  isIssueToolGranted,
  identitiesOf,
  findToolRow,
  grantedKeyForName,
  resolveIdentities,
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

// The secret store, as the registry sees it: KEY NAMES only — the dep's whole
// contract is `() => string[]`, so nothing value-bearing can reach the grant
// path even in a test. Injected everywhere so the suite never reads the box's
// real store.
function fakeSecrets(keys = []) {
  return [...keys];
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
    listSecretKeys: () => [],
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
    listSecretKeys: () => fakeSecrets(secrets),
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
  assert.equal(await registry.grantFor("nordvpn"), "NORDVPN_TOKEN");
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

test("a grant is an authorization decision: no org prefixes, no second service, no hostnames from hints", async () => {
  // An org/codename prefix names no tool — it must never become a grant.
  const prefixed = makeRegistry({ secrets: ["CAPO_MULTICA_TOKEN"], nowMs: W0 });
  assert.equal(await prefixed.registry.consentFor("multica"), "yes");
  assert.equal(await prefixed.registry.consentFor("capo"), null, "the org prefix must not be granted");
  assert.equal(await prefixed.registry.consentFor("capo_multica_token"), null, "nor the raw key");

  // Two services in one key is ambiguous — it grants NEITHER, not both.
  const ambiguous = makeRegistry({ secrets: ["GITHUB_STRIPE_TOKEN"], nowMs: W0 });
  assert.equal(await ambiguous.registry.consentFor("github"), null);
  assert.equal(await ambiguous.registry.consentFor("stripe"), null);

  // A hostname a human mentioned in the hint authorizes nothing: the hint is
  // not part of the decision at all (the dep carries key names only).
  const hinted = createToolRegistry({
    registryStore: memStore(),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => ["NORDVPN_TOKEN"],
    now: () => W0,
  });
  assert.equal(await hinted.consentFor("nordvpn"), "yes");
  assert.equal(await hinted.consentFor("github"), null, "an incidental host in a hint must not grant GitHub");
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
  assert.equal(await registry.grantFor("stripe"), null);
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
    listSecretKeys: () => fakeSecrets(keys),
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
    secrets: ["CAPO_MULTICA_TOKEN"],
    scaffoldProbes: async (tool, opts) => {
      scaffolded.push([tool, opts]);
      return { ok: true };
    },
    nowMs: W0,
  });
  await registry.dailyScan();
  assert.deepEqual(scaffolded, [["multica", { secret: "CAPO_MULTICA_TOKEN" }]], "one scaffold, for the one tool the key names");
});

test("a failing secret store denies rather than grants", async () => {
  const registry = createToolRegistry({
    registryStore: memStore(),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => {
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
    listSecretKeys: () => fakeSecrets(secrets),
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
  const rev = createToolRegistry({ registryStore: revivedStore, usageStore: memStore({ rows: [] }), ledger: revLedger, listSecretKeys: () => [], now: () => W0 + DAY });
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

// The §6.7 issue surface (index.mjs `issueToolConsented`) asks the registry
// whether the box's issue tool is reachable. It reads a REAL listTools
// projection, so the test feeds one — without the §7.4 port this fails: the
// projection carries no `consent` field, so checkable-verify stayed off even
// with the granting secret in the store.
test("isIssueToolGranted reads the grant off a REAL listTools projection — from an EMPTY registry", async () => {
  // NOTHING has been discovered: no usage rows, no registry rows. The key in
  // the store is the only input, exactly as it is on a box where the user has
  // just added a secret and no agent has touched the tool yet.
  const listWith = async (secrets) => {
    const { registry, registryStore } = makeRegistry({ usageRows: [], secrets, nowMs: W0 + DAY });
    await registry.dailyScan();
    assert.deepEqual(registryStore._state().tools ?? [], [], "the registry really is empty");
    return registry.listTools();
  };

  const granted = await listWith(["CAPO_MULTICA_TOKEN"]);
  assert.ok(granted.some((t) => t.tool === "multica"), "a granted tool is enumerable with no registry row at all");
  assert.equal(isIssueToolGranted(granted), true, "a stored key naming the issue tool opens the surface");

  assert.equal(isIssueToolGranted(await listWith([])), false, "no key → no issue surface");
  assert.equal(isIssueToolGranted(await listWith(["GITHUB_TOKEN"])), false, "a key for another tool opens nothing");

  // Shape guards: the identity must match, and junk is never a grant.
  assert.equal(isIssueToolGranted([{ tool: "issue-tracker", accessKey: "MULTICA_TOKEN" }]), true);
  assert.equal(isIssueToolGranted([{ tool: "github", accessKey: "GITHUB_TOKEN" }]), false);
  assert.equal(isIssueToolGranted([{ tool: "multica", accessKey: "" }]), false);
  assert.equal(isIssueToolGranted([{ tool: "multica" }]), false);
  assert.equal(isIssueToolGranted(null), false);
});

test("a never-used secret is ENUMERABLE, not just answerable: the projected row is honest and does not pretend to be discovery", async () => {
  const { registry, registryStore } = makeRegistry({ usageRows: [], secrets: ["NORDVPN_TOKEN"], nowMs: W0 });
  const view = await registry.listTools();
  const row = view.find((r) => r.tool === "nordvpn");
  assert.ok(row, "the granted tool appears without ever having been seen");
  assert.equal(row.accessKey, "NORDVPN_TOKEN");
  assert.equal(await registry.consentFor("nordvpn"), "yes", "and the chokepoint agrees with the list");
  // The projection is not a write, and it invents no evidence.
  assert.equal(row.uses, 0);
  assert.equal(row.status, "observed");
  assert.equal(row.ewmaPerWeek, 0);
  assert.equal(row.vitality.ewma, null);
  assert.deepEqual(registryStore._state().tools ?? [], [], "listTools never writes a row");
  // A discovered tool is not duplicated by its own grant.
  const dup = makeRegistry({
    usageRows: [{ channel: "transcript", identity: "nordvpn", detail: "cli:nordvpn", ts: W0, source: "catalog" }],
    secrets: ["NORDVPN_TOKEN"],
    nowMs: W0 + DAY,
  });
  await dup.registry.dailyScan();
  const rows = (await dup.registry.listTools()).filter((r) => r.tool === "nordvpn");
  assert.equal(rows.length, 1, "one identity, one row");
  assert.equal(rows[0].uses, 1);
  assert.equal(rows[0].accessKey, "NORDVPN_TOKEN");
});

test("channel-1 credential evidence lands on the tool the key names, not on a phantom raw row", async () => {
  // The production shape: recordSecretUsage writes the FACT (identity null,
  // `secret:<KEY>`); the registry names the tool with the grant's matcher.
  const { registry, registryStore } = makeRegistry({
    usageRows: [{ channel: "secret", identity: null, detail: "secret:GITHUB_PAT", ts: W0, source: "raw" }],
    secrets: ["GITHUB_PAT"],
    nowMs: W0 + DAY,
  });
  await registry.dailyScan();
  const tools = registryStore._state().tools;
  assert.deepEqual(tools.map((t) => t.tool), ["github"], "no parallel github_pat row");
  assert.equal(tools[0].raw, false, "a resolved credential is catalog-identified, not raw");
  assert.equal(hasCredential(tools[0]), true, "and it still carries the vitality path");
  assert.equal((await registry.listTools())[0].accessKey, "GITHUB_PAT");

  // A key the catalog cannot place keeps the raw identity for the one-shot
  // LLM classification — and grants nothing.
  const unknown = makeRegistry({
    usageRows: [{ channel: "secret", identity: null, detail: "secret:ACME_INTERNAL_TOKEN", ts: W0, source: "raw" }],
    secrets: ["ACME_INTERNAL_TOKEN"],
    nowMs: W0 + DAY,
  });
  await unknown.registry.dailyScan();
  const raw = unknown.registryStore._state().tools.find((t) => t.tool === "acme_internal_token");
  assert.ok(raw);
  assert.equal(raw.raw, true);
  assert.equal(await unknown.registry.consentFor("acme_internal_token"), null);
});

test("an ALIASING row carries the grant — a persisted alias can never suppress it", async () => {
  // Real data, not a contrived fixture: classification merges a raw row into
  // its canonical one and keeps the old token as an alias, so an identity the
  // store grants can live on a row with a different primary name.
  const seeded = memStore({
    tools: [{
      tool: "multica-ai",
      displayName: "Multica AI",
      aliases: ["multica"],
      status: "integrated",
      engagement: { ewma_per_week: 2, last_used: W0, per_project: {} },
      vitality: { last_event: null, inflow_rate: null, ewma: null, last_probed: null },
      evidence: [],
      uses: 4,
      weeks: [],
      firstSeenTs: W0,
    }],
    lastScanTs: W0,
  });
  const registry = createToolRegistry({
    registryStore: seeded,
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => ["MULTICA_TOKEN"],
    now: () => W0 + DAY,
  });

  assert.equal(await registry.consentFor("multica"), "yes", "the chokepoint grants the identity");
  const view = await registry.listTools();
  // No phantom: the alias row is the multica row, so nothing is projected…
  assert.equal(view.length, 1, "no duplicate row for an identity a real row already answers to");
  assert.equal(view[0].tool, "multica-ai", "and the real row is not masked");
  assert.deepEqual(view[0].aliases, ["multica"]);
  // …and it CARRIES the grant, so every consumer of the list sees it.
  assert.equal(view[0].accessKey, "MULTICA_TOKEN", "the grant lands on the row that answers to the identity");
  assert.equal(isIssueToolGranted(view), true, "the issue gate agrees with consentFor");

  // Same row, no secret → no access anywhere.
  const ungranted = createToolRegistry({
    registryStore: seeded,
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => [],
    now: () => W0 + DAY,
  });
  const none = await ungranted.listTools();
  assert.equal(none[0].accessKey, null);
  assert.equal(isIssueToolGranted(none), false);
});

test("EVERY grant/access lookup resolves the same identity set — canonical name and alias alike", async () => {
  // The regression: alias resolution reached the list view but not the probe
  // path, so the drill-down showed access while `consentFor("multica-ai")`
  // said no and `toolRow("multica")` found nothing — probes under the
  // canonical name stayed disabled, and under the alias had no evidence to
  // author from.
  const row = {
    tool: "multica-ai",
    displayName: "Multica AI",
    aliases: ["multica"],
    status: "integrated",
    engagement: { ewma_per_week: 2, last_used: W0, per_project: {} },
    vitality: { last_event: null, inflow_rate: null, ewma: null, last_probed: null },
    evidence: [{ channel: "config", detail: "git:api.multica.ai", ts: W0 }],
    uses: 4,
    weeks: [],
    firstSeenTs: W0,
  };
  const registry = createToolRegistry({
    registryStore: memStore({ tools: [row], lastScanTs: W0 }),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => ["MULTICA_TOKEN"],
    now: () => W0 + DAY,
  });

  for (const name of ["multica", "multica-ai", "MULTICA", " Multica-AI "]) {
    assert.equal(await registry.consentFor(name), "yes", `consentFor(${name})`);
    assert.equal(await registry.grantFor(name), "MULTICA_TOKEN", `grantFor(${name})`);
    const found = await registry.toolRow(name);
    assert.ok(found, `toolRow(${name}) must find the row`);
    assert.equal(found.tool, "multica-ai", "…and it is the SAME single row under either name");
    assert.equal(found.evidence.length, 1, "the evidence authoring needs is reachable under either name");
  }

  // The writers the probe runner calls reach that one row under either name.
  assert.equal((await registry.applyProbeResult("multica", { fields: { last_event: W0 }, probedAt: W0, cadenceMs: 3_600_000, probeName: "p" })).ok, true);
  assert.equal((await registry.appendEvidence("multica-ai", { channel: "probe", detail: "p:500", ts: W0 })).ok, true);
  const after = await registry.toolRow("multica");
  assert.equal(after.vitality.last_event, W0, "the probe result folded onto the row, not a phantom");
  assert.equal(after.evidence.length, 2);
  assert.equal((await registry.listTools()).length, 1, "and still exactly one row");

  // An alias can only WIDEN: with no secret, neither name grants anything.
  const ungranted = createToolRegistry({
    registryStore: memStore({ tools: [row], lastScanTs: W0 }),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => [],
    now: () => W0 + DAY,
  });
  for (const name of ["multica", "multica-ai"]) {
    assert.equal(await ungranted.consentFor(name), null, name);
    assert.equal(await ungranted.grantFor(name), null, name);
  }
});

test("a registry row can never WITHHOLD a grant — an unknown name resolves to itself", async () => {
  // The alias lookup must not become a precondition for access: a secret
  // nothing has ever used still grants, with an unrelated row present.
  const { registry } = makeRegistry({ secrets: ["NORDVPN_TOKEN"], nowMs: W0 });
  assert.equal(await registry.consentFor("nordvpn"), "yes");
  const withRows = createToolRegistry({
    registryStore: memStore({ tools: [{ tool: "github", aliases: ["gh"], evidence: [], uses: 1 }], lastScanTs: W0 }),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => ["NORDVPN_TOKEN"],
    now: () => W0,
  });
  assert.equal(await withRows.consentFor("nordvpn"), "yes", "a row for another tool cannot deny it");
  assert.equal(await withRows.consentFor("github"), null, "and cannot invent one either");
});

test("identitiesOf is the single identity resolver both halves of listTools use", () => {
  assert.deepEqual(identitiesOf({ tool: "multica-ai", aliases: ["multica", "mc"] }), ["multica-ai", "multica", "mc"]);
  assert.deepEqual(identitiesOf({ tool: "github" }), ["github"]);
  assert.deepEqual(identitiesOf({ tool: "x", aliases: ["", null, 7, "y"] }), ["x", "y"]);
  assert.deepEqual(identitiesOf(null), []);
});

test("resolveIdentities / findToolRow: the seam every lookup in the path goes through", () => {
  const tools = [{ tool: "multica-ai", aliases: ["multica"] }, { tool: "github" }];
  assert.equal(findToolRow(tools, "multica")?.tool, "multica-ai");
  assert.equal(findToolRow(tools, "MULTICA-AI ")?.tool, "multica-ai");
  assert.equal(findToolRow(tools, "nope"), null);
  assert.equal(findToolRow(tools, ""), null);
  assert.equal(findToolRow(null, "github"), null);
  // A name the catalog does NOT know resolves to the row's whole identity set…
  assert.deepEqual(resolveIdentities(tools, "multica-ai"), ["multica-ai", "multica"]);
  // …but a KNOWN catalog name never inherits through the bridge: it is a
  // distinct service its own keys name, so an alias must not extend anything
  // onto it (only its own key — the direct path — may serve it).
  assert.deepEqual(resolveIdentities(tools, "multica"), ["multica"]);
  // …an unknown one to itself, so a row is never a precondition for a grant.
  assert.deepEqual(resolveIdentities(tools, "nordvpn"), ["nordvpn"]);
  assert.deepEqual(resolveIdentities([], "nordvpn"), ["nordvpn"]);
  assert.deepEqual(resolveIdentities(tools, "  GitHub "), ["github"]);
  assert.deepEqual(resolveIdentities(tools, ""), []);
});

// Astra round 6, P1: the first-match alias lookup let a row's alias shadow an
// exact primary and transfer a grant between distinct known services. The
// seam's resolution order and its fail-closed edges, pinned pure:
test("findToolRow: exact primary beats an alias; ambiguous aliases fail closed; row order never matters", () => {
  // github's row claims "stripe" as an alias; a REAL stripe row also exists.
  const withStripe = [{ tool: "github", aliases: ["stripe"] }, { tool: "stripe" }];
  const withStripeReversed = [{ tool: "stripe" }, { tool: "github", aliases: ["stripe"] }];
  for (const rows of [withStripe, withStripeReversed]) {
    assert.equal(findToolRow(rows, "stripe")?.tool, "stripe", "exact primary wins");
    assert.deepEqual(resolveIdentities(rows, "stripe"), ["stripe"], "the stripe row's own set only");
  }
  // The alias bridge without a target row: for a KNOWN catalog name the
  // bridge is refused at the ROW level too — a distinct known service never
  // resolves onto another known service's row, so no evidence, hosts or
  // folding cross — and resolveIdentities returns the name alone.
  const ghostAlias = [{ tool: "github", aliases: ["stripe"] }];
  assert.equal(findToolRow(ghostAlias, "stripe"), null);
  assert.equal(findToolRow([ghostAlias[0], { tool: "nordvpn" }], "stripe"), null, "order-independent");
  assert.equal(findToolRow([{ tool: "nordvpn" }, ghostAlias[0]], "stripe"), null);
  assert.deepEqual(resolveIdentities(ghostAlias, "stripe"), ["stripe"]);
  // The valid bridge survives: a NON-catalog primary answers for its catalog
  // alias, in both directions of the row (multica-ai <-> multica).
  assert.equal(findToolRow([{ tool: "multica-ai", aliases: ["multica"] }], "multica")?.tool, "multica-ai");
  assert.equal(findToolRow([{ tool: "multica", aliases: ["multica-ai"] }], "multica-ai")?.tool, "multica");
  // Two rows claiming the same alias, no primary: ambiguous → no row, no
  // inheritance — and the answer is identical whichever row comes first.
  const ambiguousA = [{ tool: "aa", aliases: ["amb"] }, { tool: "bb", aliases: ["amb"] }];
  const ambiguousB = [{ tool: "bb", aliases: ["amb"] }, { tool: "aa", aliases: ["amb"] }];
  for (const rows of [ambiguousA, ambiguousB]) {
    assert.equal(findToolRow(rows, "amb"), null);
    assert.deepEqual(resolveIdentities(rows, "amb"), ["amb"]);
  }
});

// The transfer rule, pinned pure: a name's own key always serves it; a known
// catalog name never inherits another service's key through a row's aliases;
// a non-catalog name (multica-ai) does.
test("grantedKeyForName: own key serves; known names never inherit; unknown names may", () => {
  const granted = new Map([["github", "GITHUB_TOKEN"], ["stripe", "STRIPE_KEY"]]);
  assert.equal(grantedKeyForName(granted, "github", ["github"]), "GITHUB_TOKEN");
  assert.equal(grantedKeyForName(granted, "stripe", ["stripe"]), "STRIPE_KEY");
  // github's row claims stripe as an alias: requesting stripe must NOT reach
  // github's key, and requesting github must NOT reach stripe's.
  assert.equal(grantedKeyForName(granted, "stripe", ["github", "stripe"]), "STRIPE_KEY");
  assert.equal(grantedKeyForName(granted, "github", ["github", "stripe"]), "GITHUB_TOKEN");
  // Only the ALIASED key exists: the known name fails closed…
  const half = new Map([["github", "GITHUB_TOKEN"]]);
  assert.equal(grantedKeyForName(half, "stripe", ["github", "stripe"]), null);
  const halfStripe = new Map([["stripe", "STRIPE_KEY"]]);
  assert.equal(grantedKeyForName(halfStripe, "github", ["github", "stripe"]), null);
  // …while a non-catalog name inherits freely (the preserved mapping).
  const multica = new Map([["multica", "MULTICA_TOKEN"]]);
  assert.equal(grantedKeyForName(multica, "multica-ai", ["multica-ai", "multica"]), "MULTICA_TOKEN");
});

// Astra round 6, P1 — the SAME adversarial scenarios through the REAL engine,
// in BOTH row orders, because store-key authorization must be deterministic
// independent of evidence ordering. Fixtures: "stripe" and "github" are BOTH
// known catalog identities (distinct services their own keys name);
// "codespace" and "multica-ai" are not.
function seamRegistry(rows, keys) {
  return createToolRegistry({
    registryStore: memStore({ v: 1, tools: rows }),
    classificationStore: memStore(),
    usageStore: memStore({ rows: [] }),
    ledger: fakeLedger(),
    listSecretKeys: () => keys,
    now: () => W0,
  });
}
for (const order of ["alias-row-first", "primary-row-first"]) {
  test(`exact primary beats a colliding alias, everywhere (${order})`, async () => {
    const rows = [
      { tool: "github", aliases: ["stripe"], evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 },
      { tool: "stripe", evidence: [{ channel: "config", detail: "git:stripe.com", ts: 1 }], uses: 1 },
    ];
    const reg = seamRegistry(order === "alias-row-first" ? rows : [...rows].reverse(), ["GITHUB_TOKEN"]);
    // Consent + grant: stripe's own row answers, and github's key may NOT
    // serve it just because github's row once claimed the alias.
    assert.equal(await reg.consentFor("stripe"), null);
    assert.equal(await reg.grantFor("stripe"), null);
    assert.equal(await reg.consentFor("github"), "yes");
    assert.equal(await reg.grantFor("github"), "GITHUB_TOKEN");
    // The row lookup lands on the stripe row in both orders — probe folding
    // can no longer land on the alias claimant.
    assert.equal((await reg.toolRow("stripe")).tool, "stripe");
    // The LIST agrees with the chokepoint: stripe ungranted, github granted.
    const list = await reg.listTools();
    const stripeRow = list.find((t) => t.tool === "stripe");
    const githubRow = list.find((t) => t.tool === "github");
    assert.equal(stripeRow.accessKey, null);
    assert.equal(githubRow.accessKey, "GITHUB_TOKEN");
    // Probe folding under the exact name reaches the RIGHT row.
    await reg.applyProbeResult("stripe", { fields: { last_event: W0 }, probedAt: W0 });
    const after = await reg.toolRow("stripe");
    assert.equal(after.vitality.last_probed, W0);
    const githubAfter = await reg.toolRow("github");
    assert.equal(githubAfter.vitality?.last_probed ?? null, null);
  });

  test(`an alias on a distinct known service never transfers the grant, even with no target row (${order})`, async () => {
    const rows = [{ tool: "github", aliases: ["stripe"], evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 }];
    // GITHUB_TOKEN only: stripe must read as unconsented and ungranted.
    const gh = seamRegistry(order === "alias-row-first" ? rows : [...rows], ["GITHUB_TOKEN"]);
    assert.equal(await gh.consentFor("stripe"), null);
    assert.equal(await gh.grantFor("stripe"), null);
    assert.equal(await gh.consentFor("github"), "yes");
    const ghList = await gh.listTools();
    assert.deepEqual(ghList.map((t) => t.tool), ["github"], "no phantom stripe row");
    assert.equal(ghList[0].accessKey, "GITHUB_TOKEN");
    // Folding follows the same boundary: a probe result under the aliased
    // known name cannot land on the other service's row — no evidence, no
    // vitality, no host ever crosses.
    const fold = await gh.applyProbeResult("stripe", { fields: { last_event: W0 }, probedAt: W0 });
    assert.equal(fold.ok, false, "no github row is reachable under the stripe name");
    assert.equal((await gh.toolRow("github")).vitality?.last_probed ?? null, null);
    // MIRROR — STRIPE_KEY only: stripe's own key serves stripe directly, but
    // it must NOT cross the alias onto github, and the LIST must say the
    // same thing the chokepoint says (the grant projects as its own row
    // rather than vanishing behind the alias claimant).
    const st = seamRegistry(rows, ["STRIPE_KEY"]);
    assert.equal(await st.consentFor("stripe"), "yes");
    assert.equal(await st.consentFor("github"), null);
    assert.equal(await st.grantFor("github"), null);
    const stList = await st.listTools();
    const ghRow = stList.find((t) => t.tool === "github");
    const stRow = stList.find((t) => t.tool === "stripe");
    assert.equal(ghRow.accessKey, null, "github does not display stripe's key");
    assert.equal(stRow.accessKey, "STRIPE_KEY", "the grant stays visible, on its own row");
  });

  test(`an alias claimed by two rows fails closed, in both row orders (${order})`, async () => {
    const rows = [
      { tool: "github", aliases: ["codespace"], evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 },
      { tool: "nordvpn", aliases: ["codespace"], evidence: [{ channel: "config", detail: "git:nordvpn.com", ts: 1 }], uses: 1 },
    ];
    const reg = seamRegistry(order === "alias-row-first" ? rows : [...rows].reverse(), ["GITHUB_TOKEN"]);
    // Ambiguous alias: no row answers for it, and nothing inherits —
    // identical under both orderings.
    assert.equal(await reg.toolRow("codespace"), null);
    assert.equal(await reg.consentFor("codespace"), null);
    assert.equal(await reg.grantFor("codespace"), null);
    // The rows' own grants are untouched by the collision.
    assert.equal(await reg.consentFor("github"), "yes");
    assert.equal(await reg.consentFor("nordvpn"), null);
    const list = await reg.listTools();
    assert.equal(list.find((t) => t.tool === "github").accessKey, "GITHUB_TOKEN");
    assert.equal(list.find((t) => t.tool === "nordvpn").accessKey, null);
    assert.deepEqual(list.filter((t) => t.tool === "codespace"), [], "no phantom row for the ambiguous alias");
  });
}

// The stale-pin check the probe runner uses before sending a pinned
// credential. It must ask the SAME authorization seam as every regular grant
// (grantedKeyForName) and require the EXACT key's presence — no independent
// alias policy, no identity-only pass.
test("keyGrantedForTool: the grant seam decides; exact key required; a cross-service alias never authorizes", async () => {
  // The Astra exploit: github's row claims "stripe" as an alias and BOTH
  // keys are stored. The row's identity set contains "stripe", but the grant
  // policy for the catalog name "github" serves direct-only — the pinned
  // STRIPE_TOKEN must be refused, never used to answer github's endpoint.
  const reg = seamRegistry(
    [{ tool: "github", aliases: ["stripe"], evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 }],
    ["GITHUB_TOKEN", "STRIPE_TOKEN"],
  );
  assert.equal(await reg.keyGrantedForTool("STRIPE_TOKEN", "github"), false, "the alias must not authorize another service's key");
  assert.equal(await reg.keyGrantedForTool("GITHUB_TOKEN", "github"), true);
  // A non-catalog tool name reaches its identity through the alias bridge,
  // and the pinned key of THAT identity is authorized (the preserved mapping).
  const regM = seamRegistry(
    [{ tool: "multica-ai", aliases: ["multica"], evidence: [{ channel: "config", detail: "git:api.multica.ai", ts: 1 }], uses: 1 }],
    ["MULTICA_TOKEN"],
  );
  assert.equal(await regM.keyGrantedForTool("MULTICA_TOKEN", "multica-ai"), true);
  // The tool named by its alias reaches the same identity set.
  assert.equal(await regM.keyGrantedForTool("MULTICA_TOKEN", "multica"), true);
  // EXACT key presence: the pinned key must itself be in the store — its
  // identity being covered by another key is not enough (GITHUB_OLD_TOKEN
  // absent must not pass because GITHUB_TOKEN exists).
  const reg2 = seamRegistry(
    [{ tool: "github", evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 }],
    ["GITHUB_TOKEN"],
  );
  assert.equal(await reg2.keyGrantedForTool("GITHUB_OLD_TOKEN", "github"), false);
  assert.equal(await reg2.keyGrantedForTool("GITHUB_TOKEN", "github"), true);
  // A sibling key of the SAME identity (both in the store) is the same
  // service: the policy serves one key per identity, the sibling passes.
  const reg3 = seamRegistry(
    [{ tool: "github", evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 }],
    ["GITHUB_PAT", "GITHUB_TOKEN"],
  );
  assert.equal(await reg3.keyGrantedForTool("GITHUB_TOKEN", "github"), true);
  // The store empty: nothing is authorized.
  const reg4 = seamRegistry(
    [{ tool: "github", evidence: [{ channel: "config", detail: "git:github.com", ts: 1 }], uses: 1 }],
    [],
  );
  assert.equal(await reg4.keyGrantedForTool("GITHUB_TOKEN", "github"), false);
  assert.equal(await reg4.keyGrantedForTool("STRIPE_KEY", "github"), false);
});
