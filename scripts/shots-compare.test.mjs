import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  policyFor,
  decideShot,
  summarize,
  SHOT_POLICY,
  MIN_CHANNEL_DELTA,
} from "./shots-compare.mjs";

const shot = (over = {}) => ({
  name: "shot-hero.webp",
  inCommitted: true,
  inRegenerated: true,
  bytesEqual: false,
  changedPixels: 0,
  ...over,
});

describe("policyFor", () => {
  test("grants a budget only to the four measured environment-sensitive shots", () => {
    for (const n of ["shot-approvals.webp", "shot-hero.webp", "shot-sync.webp", "shot-phone-session.webp"]) {
      assert.equal(policyFor(n).kind, "budget", `${n} should have a budget`);
    }
  });

  test("the three stable shots keep exact byte equality", () => {
    // Measured byte-identical across both runner variants — no tolerance is
    // warranted and granting one would only reduce coverage.
    for (const n of ["hero-poster.webp", "shot-phone-list.webp", "shot-terminal.webp"]) {
      assert.equal(policyFor(n).kind, "exact", `${n} must stay exact`);
    }
  });

  test("REGRESSION: an unlisted or newly added shot defaults to exact", () => {
    // A tolerance must never be granted by accident — it has to be measured
    // and written into SHOT_POLICY first.
    assert.equal(policyFor("shot-brand-new.webp").kind, "exact");
    assert.equal(policyFor("").kind, "exact");
  });
});

describe("budgets are measured, and sit between noise and the weakest real defect", () => {
  // The two guardrails this whole approach rests on. If either fails, the gate
  // is either flaky again or has gone blind.
  test("every budget clears its measured runner variance with real headroom", () => {
    for (const [name, p] of Object.entries(SHOT_POLICY)) {
      assert.ok(
        p.maxChangedPixels >= p.observed * 4,
        `${name}: budget ${p.maxChangedPixels} is under 4x the observed ${p.observed}`,
      );
    }
  });

  test("no budget can swallow the weakest defect class the loop must catch", () => {
    // BET-550 recorded a colour-only defect — the hardest to see — at 0.142%
    // of subpixels. A budget at or above that would hide it.
    for (const [name, p] of Object.entries(SHOT_POLICY)) {
      const weakestDefect = p.pixels * 0.00142;
      assert.ok(
        p.maxChangedPixels < weakestDefect,
        `${name}: budget ${p.maxChangedPixels} >= weakest detectable defect ${Math.round(weakestDefect)}`,
      );
    }
  });
});

describe("decideShot", () => {
  test("byte-identical always passes, whatever the policy", () => {
    assert.equal(decideShot(shot({ bytesEqual: true })).ok, true);
    assert.equal(decideShot(shot({ name: "shot-terminal.webp", bytesEqual: true })).ok, true);
  });

  test("passes runner variance inside the budget", () => {
    // The real measured figure for this shot.
    const r = decideShot(shot({ name: "shot-approvals.webp", changedPixels: 706 }));
    assert.equal(r.ok, true);
    assert.match(r.reason, /runner variance/);
  });

  test("fails a real render change that exceeds the budget", () => {
    const r = decideShot(shot({ name: "shot-approvals.webp", changedPixels: 4001 }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /real render change/);
  });

  test("a shot with no tolerance fails on any byte difference", () => {
    const r = decideShot(shot({ name: "shot-terminal.webp", changedPixels: 1 }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /no tolerance/);
  });

  test("REGRESSION: an uncomputable pixel diff fails rather than passing", () => {
    // Never pass on missing evidence — a decode failure or a size mismatch
    // must not read as "within budget".
    const r = decideShot(shot({ name: "shot-hero.webp", changedPixels: null }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not be computed/);
  });

  test("an added or deleted capture fails loudly", () => {
    assert.match(decideShot(shot({ inCommitted: false })).reason, /missing from the committed/);
    assert.match(decideShot(shot({ inRegenerated: false })).reason, /missing from the regenerated/);
  });

  test("the budget boundary is inclusive", () => {
    assert.equal(decideShot(shot({ name: "shot-hero.webp", changedPixels: 4000 })).ok, true);
    assert.equal(decideShot(shot({ name: "shot-hero.webp", changedPixels: 4001 })).ok, false);
  });
});

describe("summarize", () => {
  test("green only when every shot passes", () => {
    assert.equal(summarize([{ name: "a", ok: true }, { name: "b", ok: true }]).ok, true);
  });

  test("collects every failure, not just the first", () => {
    const s = summarize([
      { name: "a", ok: false, reason: "x" },
      { name: "b", ok: true },
      { name: "c", ok: false, reason: "y" },
    ]);
    assert.equal(s.ok, false);
    assert.deepEqual(s.failures.map((f) => f.name), ["a", "c"]);
  });

  test("tolerates junk input", () => {
    assert.equal(summarize(null).ok, true);
  });
});

describe("MIN_CHANNEL_DELTA", () => {
  test("REGRESSION: must stay below 30, the weakest real defect's delta", () => {
    // BET-550 measured a colour-only defect at max channel delta 30. A
    // threshold at or above that hides the entire class no matter how many
    // pixels it covers — a first draft used 32 and an injected 88x88 colour
    // shift (delta 14 on a light background) passed silently.
    assert.ok(MIN_CHANNEL_DELTA < 30, "threshold would hide the colour-defect class");
    assert.ok(MIN_CHANNEL_DELTA > 0, "a zero threshold would count encoder noise");
  });
});
