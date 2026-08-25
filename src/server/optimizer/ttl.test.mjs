// Tests for optimizer/ttl.mjs — the effective prompt-cache TTL measurement +
// verifier (BET-1340, repurposes the reverted BET-1334 module). Pure;
// `measureEffectiveTtl(rows, now)` / `verifyCacheTtl(...)` never touch a DB.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  measureEffectiveTtl,
  verifyCacheTtl,
  configuredTtlMs,
  cacheTtlLabelMs,
} from "./ttl.mjs";

// Ambient base timestamp so gaps are well clear of epoch-0.
const T0 = 1_750_000_000_000;

function row(over = {}) {
  return {
    sessionID: "s1",
    providerID: "anthropic",
    modelID: "claude-sonnet-4",
    agent: null,
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    startedMs: 0,
    completedMs: 0,
    ...over,
  };
}

// Build n consecutive assistant turns in ONE session, each separated from the
// previous by `gapMs`, each with `input` = `prevCtx` and `cacheRead` = `read`.
// Every consecutive pair therefore has a deterministic prevCtx and warm flag.
function sessionTurns({ count, gapMs = 10 * 60_000, prevCtx = 10_000, read = 20_000 }) {
  const rows = [];
  let start = T0;
  for (let i = 0; i < count; i++) {
    const completed = start + 10_000;
    rows.push(
      row({
        sessionID: "s1",
        startedMs: start,
        completedMs: completed,
        input: prevCtx,
        cacheRead: read,
        cacheWrite: 0,
      }),
    );
    start = completed + gapMs;
  }
  return rows;
}

test("< 5 observations → default 5m, confidence 'default'", () => {
  // 2 pairs < 5. Two sessions each contribute one pair.
  const a = sessionTurns({ count: 2 });
  const b = sessionTurns({ count: 2 }).map((r) => ({ ...r, sessionID: "s2" }));
  const r = measureEffectiveTtl([...a, ...b], T0);
  assert.deepEqual(r, { ms: 300_000, confidence: "default", observations: 2 });
});

test("warm pair across a 10-min gap → 1h measured", () => {
  // 6 turns = 5 pairs, every pair warm (read 20k >= 0.5*(10k+20k=30k)=15k) and
  // gap 10 min → maxWarmGap 600_000 > 390_000 → 1h.
  const rows = sessionTurns({ count: 6, gapMs: 10 * 60_000 });
  const r = measureEffectiveTtl(rows, T0);
  assert.equal(r.confidence, "measured");
  assert.equal(r.observations, 5);
  assert.equal(r.ms, 3_600_000);
});

test("all-cold beyond 5m → 5m measured", () => {
  // read 0 < 0.5*(10k)=5k → every pair cold; maxWarmGap stays 0 → 5m measured.
  const rows = sessionTurns({ count: 8, gapMs: 10 * 60_000, read: 0 });
  const r = measureEffectiveTtl(rows, T0);
  assert.deepEqual(r, { ms: 300_000, confidence: "measured", observations: 7 });
});

test("pairs whose previous ctx < 5000 are skipped", () => {
  // prevCtx = 100 (input 100, no cache read/write) < 5000 → all pairs dropped
  // → 0 observations → default.
  const rows = sessionTurns({ count: 8, prevCtx: 100, read: 0 });
  const r = measureEffectiveTtl(rows, T0);
  assert.deepEqual(r, { ms: 300_000, confidence: "default", observations: 0 });
});

test("gap bounds are respected (below 60s and above 4h are dropped)", () => {
  // Three pairs in one session: a 30s gap (dropped), a 20-min warm gap (kept),
  // a 5h gap (dropped). Only the 20-min pair is observed.
  const mkPair = (gapMs) => {
    const s1 = T0;
    const c1 = s1 + 5_000;
    const s2 = c1 + gapMs;
    return [
      row({ sessionID: "x", startedMs: s1, completedMs: c1, input: 10_000, cacheRead: 20_000 }),
      row({ sessionID: "x", startedMs: s2, completedMs: s2 + 5_000, input: 10_000, cacheRead: 20_000 }),
    ];
  };
  const rows = [
    ...mkPair(30_000), // 30s — too short
    ...mkPair(20 * 60_000), // 20 min — valid
    ...mkPair(5 * 3_600_000), // 5h — too long
  ];
  const r = measureEffectiveTtl(rows, T0);
  assert.deepEqual(r, { ms: 300_000, confidence: "default", observations: 1 });
});

test("empty / non-array input → default with 0 observations", () => {
  assert.deepEqual(measureEffectiveTtl([], T0), { ms: 300_000, confidence: "default", observations: 0 });
  assert.deepEqual(measureEffectiveTtl(undefined, T0), { ms: 300_000, confidence: "default", observations: 0 });
});

test("warm max gap exactly 6.5 min stays 5m; just over 6.5 min → 1h", () => {
  // 5 pairs all warm. Boundary: maxWarmGap must be > 390_000 for 1h.
  const atThreshold = sessionTurns({ count: 6, gapMs: 390_000, read: 20_000 });
  assert.equal(measureEffectiveTtl(atThreshold, T0).ms, 300_000);
  const over = sessionTurns({ count: 6, gapMs: 390_001, read: 20_000 });
  assert.equal(measureEffectiveTtl(over, T0).ms, 3_600_000);
});

// ---------------------------------------------------------------------------
// The VERIFIER (BET-1340): measured effective TTL vs configured TTL.
// ---------------------------------------------------------------------------

test("configuredTtlMs maps '5m'/'1h' and rejects unknown values", () => {
  assert.equal(configuredTtlMs("5m"), 300_000);
  assert.equal(configuredTtlMs("1h"), 3_600_000);
  assert.equal(configuredTtlMs("2h"), null);
  assert.equal(configuredTtlMs(null), null);
  assert.equal(configuredTtlMs(undefined), null);
});

test("cacheTtlLabelMs renders the human label", () => {
  assert.equal(cacheTtlLabelMs(300_000), "5m");
  assert.equal(cacheTtlLabelMs(3_600_000), "1h");
  assert.equal(cacheTtlLabelMs(600_000), "10m");
  assert.equal(cacheTtlLabelMs(0), "0m");
});

test("verifyCacheTtl: measured 5m vs configured 1h → mismatch", () => {
  const measured = { ms: 300_000, confidence: "measured", observations: 7 }; // all-cold → 5m
  assert.deepEqual(verifyCacheTtl(measured, "1h"), {
    measuredMs: 300_000,
    configuredMs: 3_600_000,
    matched: false,
  });
});

test("verifyCacheTtl: measured 1h vs configured 1h → match", () => {
  const measured = { ms: 3_600_000, confidence: "measured", observations: 5 }; // warm 10-min → 1h
  assert.deepEqual(verifyCacheTtl(measured, "1h"), {
    measuredMs: 3_600_000,
    configuredMs: 3_600_000,
    matched: true,
  });
});

test("verifyCacheTtl: measured 5m vs configured 5m → match", () => {
  const measured = { ms: 300_000, confidence: "measured", observations: 7 };
  assert.deepEqual(verifyCacheTtl(measured, "5m"), {
    measuredMs: 300_000,
    configuredMs: 300_000,
    matched: true,
  });
});

test("verifyCacheTtl: inconclusive ('default') measurement → null (no verdict, no log)", () => {
  const measured = { ms: 300_000, confidence: "default", observations: 0 };
  assert.equal(verifyCacheTtl(measured, "1h"), null);
  assert.equal(verifyCacheTtl(measured, "5m"), null);
});

test("verifyCacheTtl: unknown configured ttl → null", () => {
  const measured = { ms: 300_000, confidence: "measured", observations: 7 };
  assert.equal(verifyCacheTtl(measured, "2h"), null);
  assert.equal(verifyCacheTtl(measured, null), null);
});
