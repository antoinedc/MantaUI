import { describe, it, expect } from "vitest";
import {
  filterByConstraints,
  scarcity,
  effectivePrice,
  chooseModel,
  REFERENCE_PRICE,
  FREE_FLOOR,
  AGENT_FLOOR,
  AGENT_TIER,
} from "./modelRouter.mjs";
import { tierRank } from "./modelGuide.mjs";
import type { Model } from "./modelRouter.mjs";

function m(id: string, over: Partial<Model> = {}): Model {
  return { providerID: "anthropic", id, status: "active", cost: { input: 0, output: 0 }, ...over };
}

describe("tierRank", () => {
  it("orders fast < balanced < deep, unknown to balanced", () => {
    expect(tierRank("fast")).toBe(0);
    expect(tierRank("balanced")).toBe(1);
    expect(tierRank("deep")).toBe(2);
    expect(tierRank("unknown")).toBe(1);
    expect(tierRank(undefined)).toBe(1);
  });
});

describe("filterByConstraints", () => {
  it("drops a model whose context limit leaves no headroom", () => {
    const ok = m("ok", { limit: { context: 125 } });
    const bad = m("bad", { limit: { context: 124 } });
    const res = filterByConstraints([ok, bad], { contextTokens: 100 });
    expect(res.map((x) => x.id)).toEqual(["ok"]);
  });

  it("drops on toolcall:false when tools are needed, keeps missing metadata", () => {
    const good = m("good", { capabilities: { toolcall: true } });
    const bad = m("bad", { capabilities: { toolcall: false } });
    const missing = m("missing"); // no capabilities at all
    const res = filterByConstraints([good, bad, missing], { needs: { tools: true } });
    expect(res.map((x) => x.id)).toEqual(["good", "missing"]);
  });

  it("drops on missing image input when images are needed", () => {
    const good = m("good", { capabilities: { input: { image: true } } });
    const bad = m("bad", { capabilities: { input: { image: false } } });
    const missing = m("missing");
    const res = filterByConstraints([good, bad, missing], { needs: { image: true } });
    expect(res.map((x) => x.id)).toEqual(["good", "missing"]);
  });

  it("drops on missing pdf input when pdfs are needed", () => {
    const good = m("good", { capabilities: { input: { pdf: true } } });
    const hasImageButNoPdf = m("img", { capabilities: { input: { image: true } } });
    const missing = m("missing");
    const res = filterByConstraints([good, hasImageButNoPdf, missing], { needs: { pdf: true } });
    expect(res.map((x) => x.id)).toEqual(["good", "missing"]);
  });

  it("drops on non-active status, keeps missing status", () => {
    const active = m("active", { status: "active" });
    const retired = m("retired", { status: "retired" });
    const deprecated = m("deprecated", { status: "deprecated" });
    const noStatus = m("noStatus");
    const res = filterByConstraints([active, retired, deprecated, noStatus]);
    expect(res.map((x) => x.id)).toEqual(["active", "noStatus"]);
  });

  it("keeps models with missing metadata (permissive) on every gate", () => {
    const bare = m("bare");
    const res = filterByConstraints([bare], {
      contextTokens: 100,
      needs: { tools: true, image: true, pdf: true },
    });
    expect(res.map((x) => x.id)).toEqual(["bare"]);
  });
});

describe("scarcity", () => {
  it("returns 0 with no window or pct below 50", () => {
    expect(scarcity(undefined, 0)).toBe(0);
    expect(scarcity(null, 0)).toBe(0);
    expect(scarcity({}, 0)).toBe(0);
    expect(scarcity({ pct: 49 }, 0)).toBe(0);
  });

  it("ramps at 50/75/89/100", () => {
    expect(scarcity({ pct: 50 }, 0)).toBe(0);
    expect(scarcity({ pct: 75 }, 0)).toBe(0.5);
    expect(scarcity({ pct: 89 }, 0)).toBeCloseTo(0.78, 5);
    expect(scarcity({ pct: 100 }, 0)).toBe(1);
  });

  it("returns 0 on a stale reading", () => {
    expect(scarcity({ pct: 100, stale: true }, 0)).toBe(0);
  });

  it("is lower near a reset", () => {
    const now = 1_000_000;
    const far = scarcity({ pct: 89, resetsAt: now + 25 * 60 * 60 * 1000 }, now);
    const near = scarcity({ pct: 89, resetsAt: now }, now);
    expect(far).toBeCloseTo(0.78, 5);
    expect(near).toBeCloseTo(0.78 * 0.25, 5);
    expect(near).toBeLessThan(far);
  });

  it("always returns a finite number in [0,1]", () => {
    for (const w of [{ pct: -5 }, { pct: 200 }, { pct: 75, resetsAt: 0 }, { pct: 40 }]) {
      const v = scarcity(w, 1e6);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("effectivePrice", () => {
  it("prices a dollar model by cost with no quota window", () => {
    const model = m("paid", { cost: { input: 2, output: 3 } });
    expect(effectivePrice(model, [], 0)).toBe(5);
  });

  it("blends quota scarcity into a subscription model at 89%", () => {
    const model = m("sub", { providerID: "anthropic", cost: { input: 0, output: 0 } });
    const quota = [{ providerIDs: ["anthropic"], pct: 89 }];
    expect(effectivePrice(model, quota, 0)).toBeCloseTo(0.78 * REFERENCE_PRICE, 5);
  });

  it("gives a free model with no window the FREE_FLOOR", () => {
    const model = m("free", { cost: { input: 0, output: 0 } });
    expect(effectivePrice(model, [], 0)).toBe(FREE_FLOOR);
  });
});

describe("chooseModel", () => {
  it("honours the agent floor under economy (general raised fast -> balanced)", () => {
    const fast = m("claude-haiku-4"); // tier fast
    const balanced = m("claude-sonnet-4"); // tier balanced
    const res = chooseModel({
      intent: { kind: "start", agent: "general" },
      catalog: [balanced, fast],
      policy: { preset: "economy" },
      nowMs: 0,
    });
    expect(AGENT_FLOOR.general).toBe("balanced");
    expect(AGENT_TIER.economy.general).toBe("fast");
    // floor must win: a fast model exists but the lower bound is balanced
    expect(res.model?.id).toBe("claude-sonnet-4");
    expect(res.reason).toBeTruthy();
  });

  it("is deterministic across 100 shuffles of the catalog", () => {
    const catalog = [
      m("claude-sonnet-4"),
      m("gpt-4o"),
      m("gpt-5"),
      m("claude-haiku-4"),
    ];
    const base = chooseModel({
      intent: { kind: "start", agent: "general", incumbent: m("claude-sonnet-4") },
      catalog,
      policy: { preset: "balanced" },
      nowMs: 0,
    });
    for (let i = 0; i < 100; i++) {
      const shuffled = [...catalog].sort(() => Math.random() - 0.5);
      const res = chooseModel({
        intent: { kind: "start", agent: "general", incumbent: m("claude-sonnet-4") },
        catalog: shuffled,
        policy: { preset: "balanced" },
        nowMs: 0,
      });
      expect(res.model?.id).toBe(base.model?.id);
    }
  });

  it("returns the incumbent and non-empty reason on every path", () => {
    const incumbent = m("claude-sonnet-4");
    const paths = [
      chooseModel({
        intent: { kind: "mid-exchange", agent: "general", incumbent },
        catalog: [m("claude-haiku-4")],
        policy: { preset: "balanced" },
        nowMs: 0,
      }),
      chooseModel({
        intent: { kind: "start", agent: "general", incumbent },
        catalog: [m("claude-sonnet-4")],
        policy: {},
        nowMs: 0,
      }),
      chooseModel({
        intent: { kind: "start", agent: "general", incumbent },
        catalog: [m("dead", { status: "retired" })],
        policy: { preset: "balanced" },
        nowMs: 0,
      }),
      chooseModel({
        intent: { kind: "start", agent: "general" },
        catalog: [m("claude-sonnet-4")],
        policy: { preset: "balanced" },
        nowMs: 0,
      }),
    ];
    for (const p of paths) {
      expect(typeof p.reason).toBe("string");
      expect(p.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns the incumbent unchanged when the conversation did not activate routing", () => {
    const incumbent = m("claude-sonnet-4");
    const res = chooseModel({
      intent: { kind: "start", agent: "general", incumbent },
      catalog: [m("claude-haiku-4")],
      policy: {},
      nowMs: 0,
    });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("routing not activated for this conversation");
  });

  it("REGRESSION: routing activates from a preset alone, without any enabled flag (BET-1251)", () => {
    // BET-1243 deleted the global `enabled` toggle; activation is per
    // conversation via the composer's preset pick. A preset in the policy must
    // be sufficient — no `enabled` field is consulted.
    const cheap = m("claude-haiku-4"); // tier fast
    const balanced = m("claude-sonnet-4"); // tier balanced
    const res = chooseModel({
      intent: { kind: "start", agent: "general", incumbent: m("claude-opus-4") },
      catalog: [cheap, balanced],
      policy: { preset: "economy" }, // no enabled key at all
      nowMs: 0,
    });
    expect(res.model?.id).toBe("claude-sonnet-4");
    expect(res.changed).toBe(true);
  });

  it("returns the incumbent when nothing survives filtering", () => {
    const incumbent = m("claude-sonnet-4");
    const res = chooseModel({
      intent: { kind: "start", agent: "general", incumbent },
      catalog: [m("dead", { status: "retired" })],
      policy: { preset: "balanced" },
      nowMs: 0,
    });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toContain("no general model passes constraints");
  });

  it("REGRESSION: mid-exchange never switches", () => {
    const incumbent = m("claude-opus-4");
    // A far cheaper, perfectly valid candidate exists — switching must still
    // be refused: replaying one model's thinking blocks to another is a
    // documented source of provider errors, and the cold cache write costs
    // more than it saves.
    const cheap = m("claude-haiku-4");
    const res = chooseModel({
      intent: { kind: "mid-exchange", agent: "general", incumbent },
      catalog: [incumbent, cheap],
      policy: { preset: "performance" },
      nowMs: 0,
    });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("mid-exchange switching is disabled");
  });
});
