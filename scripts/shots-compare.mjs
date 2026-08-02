#!/usr/bin/env node
/**
 * Compare a regenerated shot set against the committed one, per-shot policy.
 *
 * WHY THIS EXISTS — the byte gate was unsatisfiable
 * -------------------------------------------------
 * The drift gate compared `website/shot-*.webp` byte-for-byte against the
 * committed set. For four of the seven shots that comparison cannot be
 * satisfied, because GitHub's runners render them in TWO variants and a given
 * job lands on one or the other:
 *
 *   shot-approvals    122820 bytes  <->  122898 bytes
 *   shot-hero         165382        <->  165406
 *   shot-phone-session 59696        <->  59704
 *   shot-sync         189474        <->  189474 (same size, different bytes)
 *
 * Measured 2026-08-02: main carried variant A and passed on three consecutive
 * PRs (#476, #477, #478); it was then replaced with variant B from a failing
 * run's artifact, and the very next PR — a branch identical to main apart from
 * an appended CSS *comment* — failed against it, with the byte sizes swapped
 * back exactly. Whichever variant is committed, roughly half of all runs
 * disagree, for reasons absent from the PR's diff.
 *
 * That is the mechanism behind a long run of issues (BET-444, BET-517,
 * BET-518, BET-537, BET-542, BET-543 and BET-575). BET-537 correctly found
 * "CI is deterministic, local is deterministic, and they disagree" and BET-542
 * concluded CI should be canonical — but CI is not ONE renderer, it is two, so
 * a canonical byte set does not exist and no regeneration can produce one.
 *
 * WHY A PIXEL BUDGET SEPARATES THE TWO CASES
 * ------------------------------------------
 * The variance is a few hundred pixels with large per-channel deltas — glyph
 * hinting flipping at text edges, not diffuse antialiasing. Measured between
 * the two variants (pixels whose max channel delta exceeds 32):
 *
 *   shot-approvals 285   shot-hero 136   shot-sync 136   shot-phone-session 112
 *   hero-poster / shot-phone-list / shot-terminal: 0 — byte-identical always
 *
 * That is 0.0055% of a 5.18M-pixel shot. The weakest REAL defect the epic
 * records detecting (BET-550: a colour-only change, the hardest class) covers
 * 0.142% of subpixels — twenty-five times more. So an absolute pixel budget
 * sits comfortably between them, and the three stable shots keep exact byte
 * equality with no tolerance at all.
 *
 * Budgets are an ABSOLUTE PIXEL COUNT, never a ratio, and are MEASURED rather
 * than assumed — the rule BET-550 states, because a ratio silently re-tunes
 * itself with frame size. Each budget below is ~5-7x the observed variance and
 * stays under 0.142% of that shot's own pixel count, so it cannot swallow the
 * weakest defect class the loop is supposed to catch.
 *
 * USAGE
 *   node scripts/shots-compare.mjs <dir-with-committed/-and-regenerated/>
 *
 * Exit 0 when every shot is within policy, 1 otherwise (with a per-shot
 * report). A shot present in one set but not the other is a failure: the gate
 * must not silently ignore an added or deleted capture.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pixels must exceed this per-channel delta to count against a budget.
 *
 * MUST stay below 30. BET-550 records the weakest defect class the loop has to
 * catch — a colour-only change — at a max channel delta of THIRTY. A threshold
 * at or above that makes the entire class invisible however many pixels it
 * covers, which a first draft of this file (delta 32) did: an injected 88x88
 * colour shift scored delta 14 against a light background and passed silently.
 * The runner variance is concentrated at HIGH deltas (glyph hinting flipping
 * at text edges), so lowering the threshold to 8 costs almost nothing —
 * measured, the worst shot moves from 285 px to 600 px — while bringing the
 * whole sub-30 colour band back into view.
 */
export const MIN_CHANNEL_DELTA = 8;

/**
 * Per-shot comparison policy.
 *
 * `exact` is the default and the safe case — any byte difference fails.
 * `maxChangedPixels` is only granted to a shot MEASURED to render in more than
 * one variant across runners, and the measured variance is recorded beside it
 * so the headroom can be re-checked rather than trusted.
 */
export const SHOT_POLICY = {
  // Environment-sensitive (two runner variants). `observed` = px over
  // MIN_CHANNEL_DELTA measured between the two variants on 2026-08-02, using
  // THIS script's own sharp-based counter — a PIL-based count of the same
  // pair reads ~25% lower, and recording the number the gate does not use
  // would silently eat the headroom.
  "shot-approvals.webp": { maxChangedPixels: 4000, observed: 706, pixels: 5_184_000 },
  "shot-hero.webp": { maxChangedPixels: 4000, observed: 383, pixels: 5_184_000 },
  "shot-sync.webp": { maxChangedPixels: 4000, observed: 795, pixels: 6_678_000 },
  // Smaller frame, so a smaller budget keeps the same distance from 0.142%.
  "shot-phone-session.webp": { maxChangedPixels: 1200, observed: 177, pixels: 1_339_344 },
};

/**
 * Resolve the policy for a shot. Anything not explicitly listed — including a
 * newly added capture — is `exact`, so a tolerance is never granted by
 * accident; it has to be measured and written down first.
 *
 * @param {string} name
 * @returns {{kind:"exact"} | {kind:"budget", maxChangedPixels:number}}
 */
export function policyFor(name) {
  const p = SHOT_POLICY[name];
  if (!p) return { kind: "exact" };
  return { kind: "budget", maxChangedPixels: p.maxChangedPixels };
}

/**
 * Decide one shot.
 *
 * @param {{name:string, inCommitted:boolean, inRegenerated:boolean,
 *          bytesEqual:boolean, changedPixels:number|null}} shot
 * @returns {{ok:boolean, reason:string}}
 */
export function decideShot({ name, inCommitted, inRegenerated, bytesEqual, changedPixels }) {
  if (!inCommitted || !inRegenerated) {
    const where = !inCommitted ? "committed" : "regenerated";
    return { ok: false, reason: `missing from the ${where} set` };
  }
  if (bytesEqual) return { ok: true, reason: "byte-identical" };

  const policy = policyFor(name);
  if (policy.kind === "exact") {
    return { ok: false, reason: "bytes differ and this shot has no tolerance" };
  }
  if (typeof changedPixels !== "number") {
    // A tolerance we cannot evaluate must fail — never pass on missing evidence.
    return { ok: false, reason: "bytes differ and the pixel diff could not be computed" };
  }
  if (changedPixels > policy.maxChangedPixels) {
    return {
      ok: false,
      reason: `${changedPixels} px over delta ${MIN_CHANNEL_DELTA} exceeds the ${policy.maxChangedPixels} px budget — this is a real render change, not runner variance`,
    };
  }
  return {
    ok: true,
    reason: `${changedPixels} px over delta ${MIN_CHANNEL_DELTA}, within the ${policy.maxChangedPixels} px budget (runner variance)`,
  };
}

/**
 * Roll per-shot decisions into a verdict.
 *
 * @param {Array<{name:string, ok:boolean, reason:string}>} results
 * @returns {{ok:boolean, failures:Array<{name:string, reason:string}>}}
 */
export function summarize(results) {
  const failures = (Array.isArray(results) ? results : [])
    .filter((r) => !r.ok)
    .map(({ name, reason }) => ({ name, reason }));
  return { ok: failures.length === 0, failures };
}

/* ------------------------------------------------------------------ *
 * IO below this line. Everything above is pure and unit-tested.
 * ------------------------------------------------------------------ */

/**
 * Count pixels whose maximum per-channel difference exceeds `minDelta`.
 * Mirrors the comparison in shots-drift-diff.mjs (same sharp raw-buffer walk);
 * kept here so the gate does not depend on the artifact-reporting script.
 */
export async function countChangedPixels(aPath, bPath, minDelta = MIN_CHANNEL_DELTA) {
  const { default: sharp } = await import("sharp");
  const [a, b] = await Promise.all([
    sharp(aPath).raw().toBuffer({ resolveWithObject: true }),
    sharp(bPath).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) return null;
  const w = a.info.width;
  const h = a.info.height;
  const channels = Math.min(a.info.channels, b.info.channels, 3);
  let changed = 0;
  for (let p = 0; p < w * h; p++) {
    let maxDelta = 0;
    for (let c = 0; c < channels; c++) {
      const d = Math.abs(a.data[p * a.info.channels + c] - b.data[p * b.info.channels + c]);
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta > minDelta) changed++;
  }
  return changed;
}

const listWebp = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".webp")).sort();
  } catch {
    return [];
  }
};

async function main() {
  const pairDir = process.argv[2];
  if (!pairDir) {
    console.error("usage: shots-compare.mjs <dir containing committed/ and regenerated/>");
    return 1;
  }
  const committedDir = join(pairDir, "committed");
  const regeneratedDir = join(pairDir, "regenerated");
  const names = [...new Set([...listWebp(committedDir), ...listWebp(regeneratedDir)])].sort();
  if (names.length === 0) {
    console.error(`No .webp files found under ${pairDir}`);
    return 1;
  }

  const results = [];
  for (const name of names) {
    const cPath = join(committedDir, name);
    const rPath = join(regeneratedDir, name);
    const inCommitted = existsSync(cPath);
    const inRegenerated = existsSync(rPath);
    let bytesEqual = false;
    let changedPixels = null;
    if (inCommitted && inRegenerated) {
      bytesEqual = readFileSync(cPath).equals(readFileSync(rPath));
      if (!bytesEqual && policyFor(name).kind === "budget") {
        try {
          changedPixels = await countChangedPixels(cPath, rPath);
        } catch (e) {
          console.log(`::warning::${name}: pixel diff failed (${e.message})`);
        }
      }
    }
    const { ok, reason } = decideShot({ name, inCommitted, inRegenerated, bytesEqual, changedPixels });
    results.push({ name, ok, reason });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name} — ${reason}`);
  }

  const { ok, failures } = summarize(results);
  if (!ok) {
    console.log("");
    for (const f of failures) {
      console.log(`::error file=website/${f.name}::${f.name}: ${f.reason}`);
    }
    console.log(
      "::error::Committed shots differ from this run's render beyond runner variance. Regenerate and commit them (any runner's bytes are acceptable — the budget absorbs the variant difference).",
    );
    return 1;
  }
  console.log(`All ${results.length} shots within policy.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main());
}
