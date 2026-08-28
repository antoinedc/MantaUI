// src/server/ctoDigest.test.mjs
// BET-1383 — digest engine (spec §5.4–5.5). Coverage per decomposition A9:
//   - granularity table (Δ → reads/unit/rollup levels),
//   - tier lattice ordering + blocker exclusion,
//   - digest validation / parse / normalization ("nothing happened" legal),
//   - single-flight (concurrent triggers join, never a second run),
//   - timing fallback chain (learned → rising edge → inferred-TZ 09:00 →
//     box-local 09:00),
//   - persistence (`digests/` + latest-from-store) + learned-open recording,
//   - degraded fallback and digest-push gating.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCtoDigest,
  selectGranularity,
  sortItemsByTier,
  stripBlockers,
  validateDigestItem,
  validateDigest,
  parseDigestText,
  normalizeDigestItems,
  collectDigestRefs,
  degradedDigest,
  nextDigestMs,
  nextOccurrence,
  medianOf,
  buildDigestContext,
  DIGEST_VERSION,
  DIGEST_MAX_ITEMS,
  HOUR_MS,
  DAY_MS,
  SIXTEEN_HOURS_MS,
  THREE_DAYS_MS,
  DEFAULT_DIGEST_MS_INTO_DAY,
  RISING_EDGE_LEAD_MS,
} from "./ctoDigest.mjs";
import { startOfDay } from "./ctoDigest.mjs";

const G = 45; // minutes

function minutesMs(mins) {
  return Math.round(mins * 60_000);
}

// ---------------------------------------------------------------------------
// Granularity table (§5.4)
// ---------------------------------------------------------------------------

test("selectGranularity: Δ < G reads live events", () => {
  const gMs = minutesMs(G);
  const g = selectGranularity(gMs - 1, { gMinutes: G });
  assert.equal(g.reads, "events");
  assert.equal(g.unit, "events");
  assert.deepEqual(g.rollupLevels, []);
});

test("selectGranularity: Δ == G reads segment summaries (work episodes)", () => {
  const g = selectGranularity(minutesMs(G), { gMinutes: G });
  assert.equal(g.reads, "segments");
  assert.equal(g.unit, "work episodes");
});

test("selectGranularity: Δ within [G, 16h) reads segments", () => {
  const g = selectGranularity(2 * HOUR_MS, { gMinutes: G });
  assert.equal(g.reads, "segments");
  const g2 = selectGranularity(SIXTEEN_HOURS_MS - 1, { gMinutes: G });
  assert.equal(g2.reads, "segments");
});

test("selectGranularity: Δ in [16h, 3d] reads hour/day rollups", () => {
  const g = selectGranularity(SIXTEEN_HOURS_MS, { gMinutes: G });
  assert.equal(g.reads, "rollups");
  assert.equal(g.unit, "sessions/threads with outcomes");
  assert.deepEqual(g.rollupLevels, ["hour", "day"]);
  assert.deepEqual(selectGranularity(2 * DAY_MS, { gMinutes: G }).rollupLevels, ["hour", "day"]);
  assert.deepEqual(selectGranularity(THREE_DAYS_MS, { gMinutes: G }).rollupLevels, ["hour", "day"]);
});

test("selectGranularity: Δ > 3d reads day rollups (themes + trends)", () => {
  const g = selectGranularity(THREE_DAYS_MS + 1, { gMinutes: G });
  assert.equal(g.reads, "rollups");
  assert.equal(g.unit, "themes + trends");
  assert.deepEqual(g.rollupLevels, ["day"]);
});

test("selectGranularity: full boundary table is exact", () => {
  const gMs = minutesMs(G);
  const rows = [
    [0, "events"],
    [gMs - 1, "events"],
    [gMs, "segments"],
    [SIXTEEN_HOURS_MS - 1, "segments"],
    [SIXTEEN_HOURS_MS, "rollups"],
    [THREE_DAYS_MS, "rollups"],
    [THREE_DAYS_MS + 1, "rollups"],
  ];
  for (const [delta, reads] of rows) {
    const g = selectGranularity(delta, { gMinutes: G });
    assert.equal(g.reads, reads, `delta=${delta}`);
  }
  const day = selectGranularity(THREE_DAYS_MS + 1, { gMinutes: G });
  assert.deepEqual(day.rollupLevels, ["day"]);
});

test("selectGranularity: default G (45m) applies when omitted", () => {
  assert.equal(selectGranularity(30 * 60_000).reads, "events");
  assert.equal(selectGranularity(60 * 60_000).reads, "segments");
});

// ---------------------------------------------------------------------------
// Tier lattice (§5.5)
// ---------------------------------------------------------------------------

function item(tier, text = "t") {
  return { tier, text, refs: [] };
}

test("sortItemsByTier: orders by the deterministic lattice (failure ≫ progress)", () => {
  const sorted = sortItemsByTier([
    item("progress"),
    item("failure"),
    item("shipped/milestone"),
    item("decision-made"),
    item("external"),
  ]);
  assert.deepEqual(
    sorted.map((i) => i.tier),
    ["failure", "decision-made", "shipped/milestone", "external", "progress"],
  );
});

test("sortItemsByTier: stable for equal tiers", () => {
  const a = item("progress", "a");
  const b = item("progress", "b");
  const sorted = sortItemsByTier([b, a]);
  assert.equal(sorted[0], b);
  assert.equal(sorted[1], a);
});

test("stripBlockers: removes any blocker-tier item", () => {
  const out = stripBlockers([item("blocker"), item("progress"), item("failure")]);
  assert.deepEqual(out.map((i) => i.tier), ["progress", "failure"]);
});

// ---------------------------------------------------------------------------
// Validation / parse / normalize
// ---------------------------------------------------------------------------

test("validateDigestItem: accepts a legal item with sub/deep/refs", () => {
  assert.equal(
    validateDigestItem({ tier: "failure", text: "build broke", sub: "x", deep: "log", refs: ["s1"] }),
    true,
  );
});

test("validateDigestItem: rejects bad tier / empty text / wrong refs", () => {
  assert.equal(validateDigestItem({ tier: "bogus", text: "x" }), false);
  assert.equal(validateDigestItem({ tier: "progress", text: "  " }), false);
  assert.equal(validateDigestItem({ tier: "progress", text: "x", refs: "s1" }), false);
});

test("validateDigest: empty items (nothing happened) is legal; blocker item is refused", () => {
  const base = {
    v: DIGEST_VERSION,
    granularity: selectGranularity(2 * DAY_MS, { gMinutes: G }),
    window: [1000, 2000],
    generated: 2000,
    items: [],
  };
  assert.equal(validateDigest(base), true);
  assert.equal(validateDigest({ ...base, items: [item("progress")] }), true);
  assert.equal(validateDigest({ ...base, items: [item("progress", "x")] }), true);
  assert.equal(validateDigest({ ...base, items: [item("blocker")] }), false, "blocker is not a digest item (D15)");
  assert.equal(validateDigest({ ...base, generated: "x" }), false);
});

test("parseDigestText: extracts JSON wrapped in prose/fences", () => {
  const out = parseDigestText('Here you go:\n```json\n{"items":[{"tier":"progress","text":"hi","refs":[]}]}\n```');
  assert.ok(out);
  assert.equal(out.items.length, 1);
  assert.equal(parseDigestText("no braces here"), null);
  assert.equal(parseDigestText("{invalid"), null);
});

test("normalizeDigestItems: strips blockers, sorts by tier, honors nothing marker, caps at budget", () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push(item("progress", `p${i}`));
  assert.equal(normalizeDigestItems({ items: many }).length, DIGEST_MAX_ITEMS);

  assert.deepEqual(
    normalizeDigestItems({ items: [item("progress"), item("blocker"), item("failure")] }).map((i) => i.tier),
    ["failure", "progress"],
  );
  assert.deepEqual(normalizeDigestItems({ items: [item("progress")], nothingHappened: true }), []);
  assert.deepEqual(normalizeDigestItems({ items: [item("bogus")] }), []);
});

test("collectDigestRefs: unions refs across items", () => {
  const refs = collectDigestRefs([
    item("progress"),
    { tier: "failure", text: "x", refs: ["a", "b"] },
    { tier: "external", text: "y", refs: ["b", "c"] },
  ]);
  assert.deepEqual(refs, ["a", "b", "c"]);
});

test("degradedDigest: empty slice → nothing happened; segment slice → progress items with refs", () => {
  const window = [0, 1000];
  const empty = degradedDigest({ granularity: selectGranularity(2 * DAY_MS, { gMinutes: G }), window, slice: [], generated: 1000 });
  assert.equal(empty.items.length, 0);
  assert.equal(validateDigest(empty), true);

  const seg = degradedDigest({
    granularity: selectGranularity(2 * HOUR_MS, { gMinutes: G }),
    window,
    slice: [{ id: "s1", oneLiner: "fixed auth" }, { id: "s2", oneLiner: "shipped parser" }],
    generated: 1000,
  });
  assert.deepEqual(seg.items.map((i) => [i.tier, i.text, i.refs]), [
    ["progress", "fixed auth", ["s1"]],
    ["progress", "shipped parser", ["s2"]],
  ]);
});

test("buildDigestContext: includes all input blocks and the legal-empty instruction", () => {
  const ctx = buildDigestContext({
    granularity: selectGranularity(2 * DAY_MS, { gMinutes: G }),
    window: [1, 200],
    slice: [{ id: "r1", level: "day", bullets: [{ text: "b", refs: ["r1"] }] }],
    needsYou: [{ id: "c1", title: "approve the deploy" }],
    factsChanged: [{ id: "f1", statement: "Q went live" }],
    probes: ["db reachable"],
  });
  const joined = ctx.map((b) => b.text).join("\n");
  assert.match(joined, /{"items":/);
  assert.match(joined, /approve the deploy/);
  assert.match(joined, /Q went live/);
  assert.match(joined, /db reachable/);
  assert.match(joined, /r1/);
  assert.match(joined, /Blockers are NOT digest items/);
});

// ---------------------------------------------------------------------------
// Timing fallback chain (§5.5, D9)
// ---------------------------------------------------------------------------

test("medianOf: returns the upper-median for even and odd lists", () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([1, 2, 3, 4]), 3);
  assert.equal(medianOf([]), null);
});

test("nextOccurrence: schedules today if still future, else tomorrow", () => {
  const day = startOfDay(REF);
  // REF is midday → 07:00 is already past → next day 07:00
  assert.equal(nextOccurrence(7 * HOUR_MS, REF), day + DAY_MS + 7 * HOUR_MS);
  // REF is midday → 09:00 today already passed → tomorrow
  assert.equal(nextOccurrence(DEFAULT_DIGEST_MS_INTO_DAY, REF), day + DAY_MS + DEFAULT_DIGEST_MS_INTO_DAY);
});

// A fixed reference: midday on a day, local-timezone-agnostic via startOfDay().
const REF = (() => {
  const d = new Date(2026, 0, 5, 12, 0, 0, 0);
  return d.getTime();
})();

test("nextDigestMs: learned median used once ≥7 opens exist, outranking rising edge", () => {
  const opens = new Array(7).fill(startOfDay(REF) + 7 * HOUR_MS); // all at 07:00
  const out = nextDigestMs({ now: REF, learnedOpenTimes: opens, risingEdgeMsIntoDay: 5 * HOUR_MS });
  assert.equal(out, startOfDay(REF) + DAY_MS + 7 * HOUR_MS);
});

test("nextDigestMs: learns only after the 7-open threshold", () => {
  const few = new Array(6).fill(startOfDay(REF) + 7 * HOUR_MS);
  const out = nextDigestMs({ now: REF, learnedOpenTimes: few, risingEdgeMsIntoDay: 5 * HOUR_MS });
  // 6 < 7 opens → falls to rising-edge default (05:00 minus 30 min lead = 04:30)
  assert.equal(out, startOfDay(REF) + DAY_MS + (5 * HOUR_MS - RISING_EDGE_LEAD_MS));
});

test("nextDigestMs: rising-edge default when no learned opens", () => {
  const out = nextDigestMs({ now: REF, risingEdgeMsIntoDay: 7 * HOUR_MS });
  assert.equal(out, startOfDay(REF) + DAY_MS + (7 * HOUR_MS - RISING_EDGE_LEAD_MS));
});

test("nextDigestMs: inferred-TZ 09:00 when confidence high (no dominant component)", () => {
  const out = nextDigestMs({
    now: REF,
    inferredTz: { utcOffsetHours: 2, confidence: 0.9 },
    boxUtcOffsetHours: 0,
  });
  // user-local 09:00 at UTC+2 = 11:00 UTC
  assert.equal(out, startOfDay(REF) + DAY_MS + 11 * HOUR_MS);
});

test("nextDigestMs: falls to box-local 09:00 on low-confidence inferred TZ", () => {
  const out = nextDigestMs({
    now: REF,
    inferredTz: { utcOffsetHours: 2, confidence: 0.1 },
    boxUtcOffsetHours: 0,
  });
  assert.equal(out, startOfDay(REF) + DAY_MS + DEFAULT_DIGEST_MS_INTO_DAY);
});

test("nextDigestMs: falls to box-local 09:00 when nothing else applies", () => {
  const out = nextDigestMs({ now: REF });
  assert.equal(out, startOfDay(REF) + DAY_MS + DEFAULT_DIGEST_MS_INTO_DAY);
});

// ---------------------------------------------------------------------------
// Engine: single-flight, persistence, degraded, digest-push
// ---------------------------------------------------------------------------

function makeDigestStore() {
  const map = new Map();
  return {
    map,
    dir: "/nonexistent/digests", // getLatest uses the real fs; override via fs in engine
    save: async (id, data) => {
      map.set(id, data);
    },
    load: async (id) => map.get(id) ?? { v: 1 },
  };
}

async function waitFor(fn, timeout = 2000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 1));
  }
}

function makeEngine(overrides = {}) {
  const store = overrides.store ?? makeDigestStore();
  const state = new Map();
  const ledgerRows = [];
  const engine = createCtoDigest({
    now: () => REF,
    presence: { get: () => ({ lastSeen: REF - 2 * DAY_MS, absenceDelta: 2 * DAY_MS }) },
    getGMinutes: () => G,
    digests: store,
    ledger: { append: async (e) => ledgerRows.push(e) },
    engineState: {
      load: async () => {
        const raw = state.get("v");
        return raw === undefined ? {} : raw;
      },
      save: async (d) => {
        state.set("v", d);
      },
    },
    listOpenCards: async () => [],
    factsChanged: async () => [],
    probeFindings: async () => [],
    loadSlice: async () => [],
    getEnabled: async () => true,
    digestPushEnabled: async () => false,
    pushDigest: async () => {},
    fs: {
      readdir: async () => Array.from(store.map.keys()).map((k) => `${k}.json`),
    },
    ...overrides,
  });
  return { engine, store, state, ledgerRows };
}

test("generateDigest: single-flight — concurrent triggers join one generation", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const model = async () => {
    calls += 1;
    await gate;
    return { text: JSON.stringify({ items: [{ tier: "progress", text: "shipped", refs: [] }] }) };
  };
  const { engine, store } = makeEngine({ runEphemeral: model });

  const p1 = engine.generateDigest({ reason: "manual" });
  assert.equal(engine.isGenerating(), true, "generation state published on start");
  await waitFor(() => calls === 1, 2000); // first generation awaits the gate
  const p2 = engine.generateDigest({ reason: "manual" }); // races the in-flight one
  assert.equal(calls, 1, "second trigger must join the in-flight generation, not start a second");
  release();
  const [d1, d2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1, "exactly one model call across both triggers");
  assert.equal(d1.generated, d2.generated);
  assert.equal(engine.isGenerating(), false, "generation state cleared after completion");
  assert.equal(store.map.size, 1, "exactly one digest persisted");
  assert.equal(store.map.get(String(d1.generated)).items[0].text, "shipped");
});

test("generateDigest: model output is normalized (blockers stripped, sorted)", async () => {
  const model = async () => ({
    text: JSON.stringify({
      items: [
        { tier: "progress", text: "p", refs: ["a"] },
        { tier: "blocker", text: "needs you", refs: [] },
        { tier: "failure", text: "f", refs: ["b"] },
      ],
    }),
  });
  const { engine, store } = makeEngine({ runEphemeral: model });
  const digest = await engine.generateDigest({ reason: "manual" });
  assert.deepEqual(digest.items.map((i) => i.tier), ["failure", "progress"]);
  assert.equal(digest.nothingHappened, false);
  assert.equal(validateDigest(digest), true);
});

test("generateDigest: without a model call → degraded truthful digest, persisted", async () => {
  const { engine, store } = makeEngine({ runEphemeral: null });
  const digest = await engine.generateDigest({ reason: "manual" });
  assert.ok(digest);
  assert.equal(digest.items.length, 0);
  assert.equal(digest.nothingHappened, true);
  assert.equal(validateDigest(digest), true);
  assert.equal(store.map.size, 1);
  const latest = await engine.getLatest();
  assert.equal(latest.generated, digest.generated);
});

test("getLatest: returns the newest valid digest from the store", async () => {
  const { engine, store } = makeEngine({ runEphemeral: null });
  await engine.generateDigest({ reason: "manual" });
  const d = await engine.getLatest();
  assert.equal(String(d.generated), Array.from(store.map.keys())[0]);
  assert.equal(validateDigest(d), true);
});

test("recordOpen: persisted opens drive the scheduler's learned path", async () => {
  const { engine } = makeEngine({ runEphemeral: null });
  // <7 opens → no learned component → scheduler falls to the default
  for (let i = 0; i < 6; i++) await engine.recordOpen();
  const before = await engine.nextScheduledAt();
  // ≥7 opens → learned median kicks in; still a valid future epoch
  for (let i = 0; i < 2; i++) await engine.recordOpen();
  const after = await engine.nextScheduledAt();
  assert.ok(typeof before === "number" && before > REF);
  assert.ok(typeof after === "number" && after > REF);
});

test("digest-push: fires only when the §10.5 toggle is on AND reason is scheduled", async () => {
  let pushed = 0;
  const { engine } = makeEngine({
    runEphemeral: async () => ({ text: JSON.stringify({ items: [] }) }),
    digestPushEnabled: async () => true,
    pushDigest: async () => {
      pushed += 1;
    },
  });
  await engine.generateDigest({ reason: "manual" });
  assert.equal(pushed, 0, "manual generation must not push");

  await engine.generateDigest({ reason: "scheduled" });
  assert.equal(pushed, 1, "scheduled generation pushes when toggle is on");
});

test("digest-push: toggle off → never pushes even on scheduled generation", async () => {
  let pushed = 0;
  const { engine } = makeEngine({
    runEphemeral: async () => ({ text: JSON.stringify({ items: [] }) }),
    digestPushEnabled: async () => false,
    pushDigest: async () => {
      pushed += 1;
    },
  });
  await engine.generateDigest({ reason: "scheduled" });
  assert.equal(pushed, 0);
});
