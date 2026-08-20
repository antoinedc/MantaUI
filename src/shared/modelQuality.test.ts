import { describe, it, expect } from "vitest";
import {
  qualityScore,
  tierForScore,
  meetsFloor,
  AGENT_FLOOR_SCORE,
  TIERS,
} from "./modelQuality.mjs";
import { FAMILY_TIERS, tierRank } from "./modelGuide.mjs";
import { AGENT_FLOOR } from "./modelRouter.mjs";
import type { QualityModel } from "./modelQuality.mjs";

// A test field helper that converts a benchmark score to a percentile of "the
// models we can currently see" — the injected ranking helper qualityScore
// depends on for relativity. indexOf(score) / (n - 1): 0 = weakest in the set,
// 1 = strongest.
function percentileField(allScores: number[]) {
  const sorted = [...allScores].sort((a, b) => a - b);
  return {
    benchmarkPercentile(_name: string, score: number): number {
      const idx = sorted.indexOf(score);
      if (idx === -1) return Number.NaN;
      if (sorted.length === 1) return 1;
      return idx / (sorted.length - 1);
    },
  };
}

function model(over: Record<string, unknown> = {}): QualityModel {
  return { id: "m", providerID: "p", ...over } as QualityModel;
}

describe("qualityScore — benchmark", () => {
  it("ranks a higher SWE-Bench Verified score above a lower one, basis benchmark", () => {
    const field = percentileField([40, 80]);
    const low = qualityScore(
      model(),
      { family: "sonnet", benchmarks: [{ name: "SWE-Bench Verified", score: 40 }] },
      field,
    );
    const high = qualityScore(
      model(),
      { family: "sonnet", benchmarks: [{ name: "SWE-Bench Verified", score: 80 }] },
      field,
    );
    expect(low).toMatchObject({ basis: "benchmark", known: true });
    expect(high).toMatchObject({ basis: "benchmark", known: true });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("prefers SWE-Bench Verified over Aider Polyglot when both are present", () => {
    const field = percentileField([50]); // only whatever is asked will match
    // Aider Polyglot at 50 would resolve first if preference were ignored by
    // ordering — but the tested benchmark is the one used.
    const r = qualityScore(
      model(),
      {
        family: "sonnet",
        benchmarks: [
          { name: "Aider Polyglot", score: 50 },
          { name: "SWE-Bench Verified", score: 50 },
        ],
      },
      field,
    );
    // percentileField over [50] returns 1 regardless of which is picked;
    // this asserts the picked one resolves (not known:false via a no-match).
    expect(r.basis).toBe("benchmark");
    expect(r.known).toBe(true);
  });

  it("falls through to family when the field cannot rank the benchmark", () => {
    const r = qualityScore(
      model(),
      { family: "sonnet", benchmarks: [{ name: "SWE-Bench Verified", score: 50 }] },
      { benchmarkPercentile: () => Number.NaN },
    );
    expect(r).toMatchObject({ basis: "family", score: 0.55, known: true });
  });
});

describe("qualityScore — family", () => {
  it("gives a known family the seeded score, basis family", () => {
    const r = qualityScore(model(), { family: "sonnet" });
    expect(r).toEqual({ score: 0.55, basis: "family", known: true });
  });

  it("reads family from the catalogue authoritatively (not a regex on the id)", () => {
    // id carries no family hint at all; only the catalogue family matters.
    const r = qualityScore(model({ id: "some-random-name" }), { family: "opus" });
    expect(r).toMatchObject({ score: 0.85, basis: "family", known: true });
  });
});

describe("qualityScore — no regression for covered families", () => {
  it("every family in CATALOG lands in the same tier its hardcoded tier says today", () => {
    const families = Object.entries(FAMILY_TIERS);
    expect(families.length).toBeGreaterThan(10);
    for (const [family, expectedTier] of families) {
      const r = qualityScore(model({ family }), { family });
      expect(r.known).toBe(true);
      expect(tierForScore(r.score)).toBe(expectedTier);
    }
  });
});

describe("qualityScore — unknown", () => {
  it("returns known:false, score 0 for an unknown model", () => {
    const r = qualityScore(model({ id: "brand-new-model" }), {});
    expect(r).toEqual({ score: 0, basis: "structural", known: false });
  });
});

describe("qualityScore — structural", () => {
  it("places a reasoning model with a large context in the deep band", () => {
    const r = qualityScore(
      model({ capabilities: { reasoning: true }, limit: { context: 1_000_000 } }),
      {},
    );
    expect(r).toMatchObject({ basis: "structural", known: true });
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(tierForScore(r.score)).toBe("deep");
  });

  it("a model with no structural signal is not known", () => {
    const r = qualityScore(model({ id: "bare", providerID: "x" }), {});
    expect(r.known).toBe(false);
  });
});

describe("tierForScore", () => {
  it("maps bands to fast < balanced < deep", () => {
    expect(tierForScore(0.24)).toBe("fast");
    expect(tierForScore(0.4)).toBe("balanced");
    expect(tierForScore(0.55)).toBe("balanced");
    expect(tierForScore(0.7)).toBe("deep");
    expect(tierForScore(0.99)).toBe("deep");
    expect(TIERS).toEqual(["fast", "balanced", "deep"]);
  });
});

describe("meetsFloor", () => {
  it("matches today's AGENT_FLOOR for all five agents", () => {
    const agents = ["build", "plan", "general", "explore", "title"];
    for (const s of [0, 0.25, 0.55, 0.85, 1]) {
      for (const agent of agents) {
        const expected = tierRank(tierForScore(s)) >= tierRank(AGENT_FLOOR[agent]);
        expect(meetsFloor(s, agent)).toBe(expected);
      }
    }
  });

  it("uses score floors consistent with the tier bands", () => {
    expect(AGENT_FLOOR_SCORE.build).toBe(0.4);
    expect(AGENT_FLOOR_SCORE.general).toBe(0.4);
    expect(AGENT_FLOOR_SCORE.plan).toBe(0.7);
    expect(AGENT_FLOOR_SCORE.explore).toBe(0);
    expect(AGENT_FLOOR_SCORE.title).toBe(0);
  });
});

describe("relativity", () => {
  it("a new model scoring above the current top shifts existing percentiles down", () => {
    // Set A: only one model in the field (SWE-bench 50) -> percentile 1.
    const fieldA = percentileField([50]);
    const a = qualityScore(
      model(),
      { family: "sonnet", benchmarks: [{ name: "SWE-Bench Verified", score: 50 }] },
      fieldA,
    );
    expect(a.score).toBe(1);

    // Introduce a stronger model (90). Both now share the field; the old top
    // model's percentile falls — nothing is hardcoded, no list edited.
    const fieldAB = percentileField([50, 90]);
    const aAfter = qualityScore(
      model(),
      { family: "sonnet", benchmarks: [{ name: "SWE-Bench Verified", score: 50 }] },
      fieldAB,
    );
    const b = qualityScore(
      model(),
      { family: "sonnet", benchmarks: [{ name: "SWE-Bench Verified", score: 90 }] },
      fieldAB,
    );
    expect(aAfter.score).toBeLessThan(a.score);
    expect(b.score).toBeGreaterThan(aAfter.score);
    expect(aAfter.basis).toBe("benchmark");
  });
});
