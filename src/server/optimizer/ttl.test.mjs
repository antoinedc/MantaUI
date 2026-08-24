// Tests for optimizer/ttl.mjs — the effective prompt-cache TTL measurement
// (BET-1334, Optimizer P1.2). Pure; `measureEffectiveTtl(rows, now)` never
// touches a DB. Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { measureEffectiveTtl } from "./ttl.mjs";

const T0 = 1_750_000_000_000;

function row(over = {}) {
  return { sessionID: "s1", input: 0, cacheRead: 0, cacheWrite: 0, startedMs: 0, completedMs: 0, ...over };
}

// n consecutive turns in ONE session, `gapMs` apart, each with `input`/`read`.
// Every consecutive pair takes prevCtx = input+read and warm = read >= 0.5*prevCtx.
function sessionTurns({ count, gapMs = 10 * 60_000, input = 10_000, read = 20_000 }) {
  const rows = [];
  let start = T0;
  for (let i = 0; i < count; i++) {
    rows.push(row({ startedMs: start, completedMs: start + 10_000, input, cacheRead: read }));
    start += 10_000 + gapMs;
  }
  return rows;
}

test("< 5 observations → default 5m", () => {
  const a = sessionTurns({ count: 2 });
  const b = sessionTurns({ count: 2 }).map((r) => ({ ...r, sessionID: "s2" })); // 2 pairs
  assert.deepEqual(measureEffectiveTtl([...a, ...b], T0), { ms: 300_000, confidence: "default", observations: 2 });
});

test("warm pair across a 10-min gap → 1h measured", () => {
  const r = measureEffectiveTtl(sessionTurns({ count: 6 }), T0); // 5 pairs, all warm
  assert.deepEqual(r, { ms: 3_600_000, confidence: "measured", observations: 5 });
});

test("all-cold beyond 5m → 5m measured", () => {
  const r = measureEffectiveTtl(sessionTurns({ count: 8, read: 0 }), T0); // all cold
  assert.deepEqual(r, { ms: 300_000, confidence: "measured", observations: 7 });
});

test("pairs whose previous ctx < 5000 are skipped", () => {
  const r = measureEffectiveTtl(sessionTurns({ count: 8, input: 100, read: 0 }), T0);
  assert.deepEqual(r, { ms: 300_000, confidence: "default", observations: 0 });
});

test("gap bounds are respected; 6.5-min warm boundary flips to 1h", () => {
  const mkPair = (gap) => {
    const s1 = T0, c1 = s1 + 5_000, s2 = c1 + gap;
    return [
      row({ sessionID: "x", startedMs: s1, completedMs: c1, input: 10_000, cacheRead: 20_000 }),
      row({ sessionID: "x", startedMs: s2, completedMs: s2 + 5_000, input: 10_000, cacheRead: 20_000 }),
    ];
  };
  // 30s and 5h gaps dropped; only the 20-min pair is observed → <5 → default.
  const mixed = [...mkPair(30_000), ...mkPair(20 * 60_000), ...mkPair(5 * 3_600_000)];
  assert.deepEqual(measureEffectiveTtl(mixed, T0), { ms: 300_000, confidence: "default", observations: 1 });
  // Boundary: maxWarmGap must be > 390_000 for 1h.
  assert.equal(measureEffectiveTtl(sessionTurns({ count: 6, gapMs: 390_000 }), T0).ms, 300_000);
  assert.equal(measureEffectiveTtl(sessionTurns({ count: 6, gapMs: 390_001 }), T0).ms, 3_600_000);
});

test("empty / non-array input → default with 0 observations", () => {
  assert.deepEqual(measureEffectiveTtl([], T0), { ms: 300_000, confidence: "default", observations: 0 });
  assert.deepEqual(measureEffectiveTtl(undefined, T0), { ms: 300_000, confidence: "default", observations: 0 });
});
