// src/server/ctoProfile.test.mjs
// BET-1393 — profile engine (spec §8.1–8.4). Coverage per decomposition:
//   - circular stats against fixtures (known mean hour / R̄),
//   - 24-bin histogram component peak finding (von Mises cheap method),
//   - BKT binary update (directions + weight magnitude),
//   - TrueSkill graded update (directions + magnitude),
//   - decay constant (σ returns to SIGMA0 after ~26 idle weeks),
//   - reservoir median,
//   - dimension cap displacement (≤40),
//   - μ−2σ audience-block derivation,
//   - rising edge + deviation-from-baseline consumers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateCircular,
  circularStats,
  addHistogram,
  histogramPeaks,
  inferTz,
  ewma,
  createReservoir,
  bktUpdate,
  trueSkillUpdate,
  applyAtom,
  sigmaDecay,
  repFamErode,
  repFamOwn,
  expertiseOf,
  expertiseLabel,
  computeAudience,
  dominantComponent,
  risingEdgeMsIntoDay,
  offHoursDeviation,
  capDimensions,
  BKT,
  MIN_SIGMA,
  SIGMA0,
  SIGMA_MAX,
  MU0,
  WEEKLY_DECAY_C,
  SKILL_DIM_MAX,
  HOUR_MS,
} from "./ctoProfile.mjs";
import { createCtoProfile } from "./ctoProfile.mjs";

const close = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// Circular stats
// ---------------------------------------------------------------------------

test("circular stats: single sample → its hour, R̄ = 1", () => {
  let acc = accumulateCircular(undefined, 6);
  const { meanHour, rBar } = circularStats(acc);
  assert.ok(close(meanHour, 6));
  assert.ok(close(rBar, 1));
});

test("circular stats: 10h + 14h → mean 12h, R̄ ≈ 0.866", () => {
  let acc = accumulateCircular(undefined, 10);
  acc = accumulateCircular(acc, 14);
  const { meanHour, rBar } = circularStats(acc);
  assert.ok(close(meanHour, 12, 1e-2), `meanHour=${meanHour}`);
  assert.ok(close(rBar, Math.sqrt(3) / 2, 1e-2), `rBar=${rBar}`);
});

test("circular stats: empty → null mean, R̄ 0", () => {
  const { meanHour, rBar } = circularStats({ S: 0, C: 0, n: 0 });
  assert.equal(meanHour, null);
  assert.equal(rBar, 0);
});

// ---------------------------------------------------------------------------
// Component peak finding (§8.2 cheap method — no EM)
// ---------------------------------------------------------------------------

test("histogramPeaks: single peak → one component at its centre, weight 1", () => {
  const freqs = new Array(24).fill(0);
  freqs[12] = 20; // lone peak bin 12 (mu 12.5)
  const c = histogramPeaks(freqs);
  assert.equal(c.length, 1);
  assert.ok(close(c[0].mu_hour, 12.5));
  assert.ok(close(c[0].weight, 1));
  assert.ok(c[0].kappa >= 1);
});

test("histogramPeaks: two separated peaks → two components, weights by share", () => {
  const freqs = new Array(24).fill(0);
  freqs[9] = 5;
  freqs[10] = 20;
  freqs[11] = 5;
  freqs[19] = 5;
  freqs[20] = 20;
  freqs[21] = 5;
  const c = histogramPeaks(freqs);
  assert.equal(c.length, 2);
  const hours = c.map((x) => x.mu_hour).sort();
  assert.ok(close(hours[0], 10.5) && close(hours[1], 20.5));
});

test("histogramPeaks: dominantWorkdays weights + rising edge", () => {
  const c = [
    { mu_hour: 10, kappa: 2, weight: 0.3 },
    { mu_hour: 15, kappa: 3, weight: 0.7 },
  ];
  const dom = dominantComponent(c);
  assert.equal(dom.mu_hour, 15);
  const edge = risingEdgeMsIntoDay({
    components: c,
    tzOffset: 0,
    boxUtcOffsetHours: 0,
  });
  // dominant peak 15h, kappa 3 → margin = min(2, max(.25, 1.5/3=.5)) = .5 → 14.5h
  assert.ok(close(edge / HOUR_MS, 14.5), `edge=${edge / HOUR_MS}`);
});

test("risingEdgeMsIntoDay: no components → null", () => {
  assert.equal(risingEdgeMsIntoDay({ components: [] }), null);
});

// ---------------------------------------------------------------------------
// TZ inference
// ---------------------------------------------------------------------------

test("inferTz: trough at box 3h, box UTC → offset +1; low conf before 14 days", () => {
  // activity suppressed at bin 3 (box 03:00–04:00); trough = 3 → +1 offset.
  const freqs = new Array(24).fill(3);
  freqs[3] = 0;
  const early = inferTz({ freqs, dayCount: 5, rBar: 0.8, boxUtcOffsetHours: 0 });
  assert.equal(early.value, 1);
  assert.ok(early.confidence < 0.5, `early conf ${early.confidence}`);
  const mature = inferTz({ freqs, dayCount: 20, rBar: 0.8, boxUtcOffsetHours: 0 });
  assert.equal(mature.value, 1);
  assert.ok(mature.confidence >= 0.5, `mature conf ${mature.confidence}`);
});

// ---------------------------------------------------------------------------
// BKT binary update (§8.2 constants)
// ---------------------------------------------------------------------------

test("BKT: up moves belief up, down moves it down (from pL0)", () => {
  const up = bktUpdate(BKT.pL0, "up", { weight: 1 });
  const down = bktUpdate(BKT.pL0, "down", { weight: 1 });
  assert.ok(up > BKT.pL0, `up=${up}`);
  assert.ok(down < BKT.pL0, `down=${down}`);
  assert.ok(up < 1 && down > 0);
});

test("BKT: weight scales magnitude (weak evidence moves less)", () => {
  const full = bktUpdate(BKT.pL0, "up", { weight: 1 });
  const half = bktUpdate(BKT.pL0, "up", { weight: 0.4 });
  const none = bktUpdate(BKT.pL0, "up", { weight: 0 });
  assert.ok(half < full);
  assert.ok(close(none, BKT.pL0 + BKT.pT * (1 - BKT.pL0))); // 0-w ≠ prior but transit-only
});

test("applyAtom: binary encodes direction + weight", () => {
  const base = { mu: MU0, sigma: SIGMA0, evidence: [], updated: 0 };
  const up = applyAtom(base, { dimension: "ts", direction: "up", weight: 1, ref: "r1" });
  const down = applyAtom(base, { dimension: "ts", direction: "down", weight: 1, ref: "r2" });
  assert.ok(up.mu > base.mu && down.mu < base.mu);
  assert.ok(deepContains(up.evidence, "r1"));
});

function deepContains(arr, v) {
  return (arr || []).includes(v);
}

// ---------------------------------------------------------------------------
// TrueSkill graded update
// ---------------------------------------------------------------------------

test("graded: ±dir move mu oppositely; magnitude scales with weight", () => {
  const pos = trueSkillUpdate(0.5, 1.0, { dir: 0.8, weight: 1 });
  const neg = trueSkillUpdate(0.5, 1.0, { dir: -0.8, weight: 1 });
  assert.ok(pos.mu > 0.5 && neg.mu < 0.5);
  assert.ok(close(Math.abs(pos.mu - 0.5), Math.abs(neg.mu - 0.5), 1e-6));
  const weak = trueSkillUpdate(0.5, 1.0, { dir: 0.8, weight: 0.2 });
  assert.ok(weak.mu < pos.mu);
  // zero dir → no change
  const zero = trueSkillUpdate(0.5, 1.0, { dir: 0, weight: 1 });
  assert.ok(close(zero.mu, 0.5));
});

test("applyAtom: graded numeric direction", () => {
  const base = { mu: 0.5, sigma: 1.0, evidence: [], updated: 0 };
  const graded = applyAtom(base, { dimension: "api-design", direction: 0.6, weight: 1, ref: "seg1" });
  assert.ok(graded.mu > 0.5);
});

// ---------------------------------------------------------------------------
// Decay constant (§8.2)
// ---------------------------------------------------------------------------

test("decay: σ returns to SIGMA0 after ~26 idle weeks from MIN_SIGMA", () => {
  const grown = sigmaDecay(MIN_SIGMA, 26, { c: WEEKLY_DECAY_C });
  assert.ok(close(grown, SIGMA0, 0.05), `grown=${grown}`);
  // monotonic
  assert.ok(sigmaDecay(MIN_SIGMA, 0) < sigmaDecay(MIN_SIGMA, 10));
  // bounded at SIGMA_MAX
  assert.ok(sigmaDecay(MIN_SIGMA, 10000) <= SIGMA_MAX);
});

// ---------------------------------------------------------------------------
// Reservoir median
// ---------------------------------------------------------------------------

test("reservoir: median of a small odd sample", () => {
  const r = createReservoir(100, () => 0); // fixed rng → never displaces small samples
  for (const x of [1, 3, 2, 5, 4]) r.push(x);
  assert.equal(r.median(), 3);
  assert.equal(r.size, 5);
});

test("reservoir: capped size + persisted seed round-trips", () => {
  const r = createReservoir(10, () => 0.99); // rng near 1 → late displacement
  for (let i = 0; i < 50; i++) r.push(i);
  assert.equal(r.size, 50);
  const meta = {};
  r._snapshot(meta);
  assert.ok(Array.isArray(meta.reservoir) && meta.reservoir.length <= 10);
  const r2 = createReservoir(10, () => 0);
  r2._seed(meta.reservoir);
  assert.equal(r2.median(), r.median());
});

// ---------------------------------------------------------------------------
// Repo familiarity erosion (∝ log of others' edits)
// ---------------------------------------------------------------------------

test("repFamErode: bigger othersDelta erodes more; log shape", () => {
  assert.ok(repFamErode(0.8, 10) < repFamErode(0.8, 2));
  assert.ok(repFamErode(0.8, 0) === 0.8);
  assert.ok(repFamErode(0.01, 1000) >= 0);
});

test("repFamOwn: own edit raises familiarity toward 1", () => {
  assert.ok(repFamOwn(0.2) > 0.2);
});

// ---------------------------------------------------------------------------
// Dimension cap displacement (≤40)
// ---------------------------------------------------------------------------

test("capDimensions: keeps the 40 most recent, drops the stalest", () => {
  const skills = {};
  for (let i = 0; i < SKILL_DIM_MAX + 3; i++) {
    skills[`dim${i}`] = { mu: 0.5, sigma: 1, updated: i };
  }
  const capped = capDimensions(skills);
  const keys = Object.keys(capped);
  assert.equal(keys.length, SKILL_DIM_MAX);
  assert.ok(!("dim0" in capped) && "dim42" in capped); // oldest dropped
});

// ---------------------------------------------------------------------------
// μ−2σ audience block (§8.3/§8.4)
// ---------------------------------------------------------------------------

test("expertiseOf: conservative μ−2σ, clamped", () => {
  assert.ok(close(expertiseOf({ mu: 0.9, sigma: 0.1 }), 0.7));
  assert.equal(expertiseOf({ mu: 0.4, sigma: 0.3 }), 0);
});

test("computeAudience: technical topic → technical, novice → novice", () => {
  const dimensions = {
    "distributed-systems": { mu: 0.95, sigma: 0.05 },
    "excel-sheets": { mu: 0.5, sigma: 1.2 },
  };
  const tech = computeAudience({ dimensions, topics: ["distributed-systems"], depthPref: 0 });
  assert.equal(tech.label, "technical");
  assert.match(tech.text, /technical/);
  const novice = computeAudience({ dimensions, topics: ["excel-sheets"], depthPref: 0 });
  assert.equal(novice.label, "novice");
});

test("computeAudience: depth pref blends in (explicit beats implicit)", () => {
  const dimensions = { x: { mu: 0.5, sigma: 1.2 } }; // low expertise
  const shallow = computeAudience({ dimensions, topics: ["x"], depthPref: 0 });
  const deep = computeAudience({ dimensions, topics: ["x"], depthPref: 1 });
  assert.ok(deep.tech > shallow.tech);
});

// ---------------------------------------------------------------------------
// Deviation-from-baseline (§8.4)
// ---------------------------------------------------------------------------

test("offHoursDeviation: 3am for a midday worker → flagged; midday → null", () => {
  const components = [{ mu_hour: 12, kappa: 3, weight: 1 }];
  const off = offHoursDeviation({ hour: 3, components });
  assert.ok(off && off.type === "off-hours");
  assert.equal(offHoursDeviation({ hour: 12, components }), null);
  assert.equal(offHoursDeviation({ hour: 13, components }), null);
});

// ---------------------------------------------------------------------------
// Engine integration (injected store)
// ---------------------------------------------------------------------------

test("engine: observable deterministic layer builds temporal stats", async () => {
  const store = {
    saved: null,
    load: async () => ({}),
    save: async (d) => {
      store.saved = d;
    },
  };
  const p = createCtoProfile({ store, now: () => 0 });
  await p.init();
  const DAY = 86_400_000;
  // midday activity (epoch → Date shift is platform-dependent; use now()=0 offset)
  for (let i = 0; i < 5; i++) {
    p.observeEvent({ kind: "prompt", ts: 12 * 3_600_000 }); // hour 12 box-local
  }
  assert.ok(p.get().temporal.dayCount >= 1);
  assert.ok(p.get().temporal.workday.components.length >= 1);
  assert.ok(p.get().interaction.correction_rate.total === 0);
});

test("engine: atoms + session length apply through applySegmentSummary", async () => {
  const store = {
    saved: null,
    load: async () => ({}),
    save: async (d) => {
      store.saved = d;
    },
  };
  const p = createCtoProfile({ store, now: () => 0 });
  await p.init();
  await p.applySegmentSummary({
    project: "manta",
    atoms: [{ dimension: "swift", direction: "up", weight: 1, ref: "s1" }],
    window: [0, 60_000],
  });
  const s = p.get();
  assert.ok(s.skills.swift.mu > MU0);
  assert.ok(s.repo_familiarity.manta.doa > 0);
  assert.equal(s.interaction.session_len_median, 1); // 1 minute
});

test("engine: weekly decay erodes repo familiarity from others' edits", async () => {
  const store = {
    saved: null,
    load: async () => ({}),
    save: async (d) => {
      store.saved = d;
    },
  };
  const p = createCtoProfile({ store, now: () => 0 });
  await p.init();
  await p.recordRepoEdit({ repo: "manta", own: true }); // 0.2 → ~0.28
  await p.recordRepoEdit({ repo: "manta", own: false });
  await p.recordRepoEdit({ repo: "manta", own: false }); // 2 others' edits pending
  const beforeErode = p.get().repo_familiarity.manta.doa;
  await p.decayWeekly();
  const after = p.get();
  // erosion ∝ ln(1 + 2)·0.12
  const expectErode = 0.12 * Math.log(3);
  assert.ok(after.repo_familiarity.manta.doa <= beforeErode - expectErode + 1e-6);
  assert.ok(store.saved, "persisted on decay");
});

test("engine: audience consumer + rising edge + deviations work end-to-end", async () => {
  const store = { load: async () => ({}), save: async () => {} };
  const p = createCtoProfile({ store, now: () => 0 });
  await p.init();
  p.observeEvent({ kind: "busy", ts: 12 * 3_600_000 });
  await p.flush();
  const audience = p.getAudience({});
  assert.equal(typeof audience.text, "string");
  assert.ok(p.getRisingEdgeMsIntoDay() === null || typeof p.getRisingEdgeMsIntoDay() === "number");
  assert.ok(Array.isArray(p.getDeviations({ hour: 12 })));
});
