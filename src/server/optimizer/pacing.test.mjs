// Tests for optimizer/pacing.mjs — the pacing controller's stateful core
// (Optimizer P2.3, BET-1345). Pure/injected throughout: no real state dir —
// `load`/`save` are in-memory, `now` is a controlled clock, and the token
// ledger is a stub. Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacingState, tokensPerPct } from "./pacing.mjs";
import { MIN_TOKENS_PER_PCT_SAMPLE } from "../../shared/quotaPressure.mjs";

const HOUR_MS = 3_600_000;

function fixed(ms) {
  return () => ms;
}

function makeState({ initial = {}, now, totals = {} }) {
  let state = initial;
  const saves = [];
  const st = createPacingState({
    load: async () => state,
    save: async (s) => {
      state = s;
      saves.push(JSON.parse(JSON.stringify(s)));
    },
    now,
    ledgerTokens: async () => ({ byProvider: totals }),
  });
  return { st, saves, get: () => st.snapshot() };
}

function snap(provider, providerIDs, windows, fetchedAt) {
  return { provider, providerIDs, windows, fetchedAt };
}

function window(pct, startedAt, resetsAt) {
  return { kind: "session", pct, startedAt, resetsAt };
}

test("observe seeds on first sight from the closed form (not Q=0)", async () => {
  const R = 100 * HOUR_MS;
  const { st } = makeState({ now: fixed(R / 2) });
  await st.observe([snap("claude", ["anthropic"], [window(80, 0, R)], R / 2)]);
  const state = await st.snapshot();
  const win = state.windows["claude:session"];
  assert.equal(win.deficit, 30); // 80 - 100 * 0.5
  assert.deepEqual(win.providerIDs, ["anthropic"]);
});

test("observe advances the accumulator over pace", async () => {
  const R = 1000; // short window for easy math
  const { st } = makeState({ now: fixed(0) });
  await st.observe([snap("claude", ["anthropic"], [window(50, 0, R)], 0)]);
  let state = await st.snapshot();
  assert.equal(state.windows["claude:session"].deficit, 50); // seed at t=0: 50 - 0

  // The 30s debounced save never fires in-test, so a second state created from
  // the mutated state would be stale; drive the SAME state through a second
  // observation instead. pct 50 → 90 over a 500ms step: rate=(100-50)/1000=.05/ms,
  // drain=.05*500=25 → Q = 50 + (90-50) - 25 = 65.
  const st2 = createPacingState({
    load: () => Promise.resolve(state),
    save: async () => {},
    now: fixed(500),
    ledgerTokens: async () => ({ byProvider: {} }),
  });
  await st2.observe([snap("claude", ["anthropic"], [window(90, 0, R)], 500)]);
  const state2 = await st2.snapshot();
  assert.equal(state2.windows["claude:session"].deficit, 65);
});

test("observe discards the accumulator and re-seeds on a -10 reset drop", async () => {
  const R = 1000;
  const { st } = makeState({ now: fixed(0) });
  await st.observe([snap("claude", ["anthropic"], [window(50, 0, R)], 0)]);
  let state = await st.snapshot();
  // A fresh window opens: pct drops to 5 (new startedAt/resetsAt). 5 < 50-10 → reset.
  const R2 = 10_000;
  const st2 = createPacingState({
    load: () => Promise.resolve(state),
    save: async () => {},
    now: fixed(2000),
    ledgerTokens: async () => ({ byProvider: {} }),
  });
  await st2.observe([snap("claude", ["anthropic"], [window(5, 1000, R2)], 2000)]);
  const state2 = await st2.snapshot();
  const win = state2.windows["claude:session"];
  // Re-seeded: elapsed=(2000-1000)/9000≈0.111 → deficit=5 - 100*0.111 → clamped 0.
  assert.equal(win.deficit, 0);
  assert.equal(win.pct, 5);
});

test("tokensPerPct is null below MIN_TOKENS_PER_PCT_SAMPLE of movement", () => {
  const state = {
    windows: {
      "claude:session": { pct: 60, pctAtMark: 58, tokensAtMark: 1000 },
    },
  };
  // delta 2 < 5 → null, even with a huge measured token delta.
  assert.equal(tokensPerPct("claude:session", { ledgerTokensSince: 100_000, state }), null);
  assert.equal(MIN_TOKENS_PER_PCT_SAMPLE, 5);
});

test("tokensPerPct returns the measured ratio when movement is sufficient", () => {
  const state = {
    windows: {
      "claude:session": { pct: 80, pctAtMark: 40, tokensAtMark: 1000 },
    },
  };
  // delta 40 → (5000-1000)/40 = 100.
  assert.equal(tokensPerPct("claude:session", { ledgerTokensSince: 5000, state }), 100);
});

test("pressureFor picks the largest-deficit window for a provider", async () => {
  const { st } = makeState({
    now: fixed(0),
    totals: { anthropic: 5000 },
    initial: {
      windows: {
        "claude:session": { deficit: 10, pct: 60, at: 10, tokensAtMark: 1000, pctAtMark: 40, rates: [1, 2, 3, 4, 5, 6, 7, 8], providerIDs: ["anthropic"], startedAt: 0, resetsAt: 1e9 },
        "claude:weekly": { deficit: 30, pct: 80, at: 10, tokensAtMark: 1000, pctAtMark: 40, rates: [1, 2, 3, 4, 5, 6, 7, 8], providerIDs: ["anthropic"], startedAt: 0, resetsAt: 1e9 },
      },
    },
  });
  const p = await st.pressureFor("anthropic");
  assert.ok(p);
  assert.equal(p.deficit, 30); // worst window wins
  assert.equal(p.ecoLevel, 2); // 30 is in [25, 40)
  assert.equal(p.tokensPerPct, 100); // (5000-1000)/(80-40)
  assert.equal(p.lambda, 30 / 25);
});

test("pressureFor returns null for a provider with no window", async () => {
  const { st } = makeState({
    now: fixed(0),
    initial: { windows: { "claude:session": { deficit: 5, pct: 50, providerIDs: ["anthropic"] } } },
  });
  assert.equal(await st.pressureFor("openai"), null);
  assert.equal(await st.pressureFor(""), null);
});

test("pressureFor returns null when the ledger read fails (fail-open)", async () => {
  // ledgerTokens loader returns null → sumTokens null → tokensPerPct null.
  const { st } = makeState({
    now: fixed(0),
    totals: null,
    initial: { windows: { "claude:session": { deficit: 20, pct: 70, pctAtMark: 40, tokensAtMark: 1000, providerIDs: ["anthropic"] } } },
  });
  const p = await st.pressureFor("anthropic");
  assert.equal(p.tokensPerPct, null);
});
