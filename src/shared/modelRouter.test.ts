import { describe, it, expect } from "vitest";
import { chooseModel, AGENT_TIER, PRESETS, type RoutingServices } from "./modelRouter.mjs";
import { endpointKey } from "./endpointKey.mjs";
import { tierRank } from "./modelGuide.mjs";
import { AGENT_FLOOR_SCORE } from "./modelQuality.mjs";
// Standing rule 9: a routing test may not hand-write a candidate literal.
// Build every candidate through the REAL normaliser (the same seam the
// BET-1267 cases use) so the fixtures can never drift from what production
// actually produces.
// @ts-expect-error — server module has no .d.mts; _normalizeProviderModel is
// the canonical OpencodeModel producer every routed test builds through.
import { _normalizeProviderModel } from "../server/opencode.mjs";

// A catalogue entry field that forces a precise, known quality score so tests
// control the tier band deterministically. qualityScore's benchmark path wins
// over the family seed; the identity percentile is the score itself.
const CHECK = { name: "SWE-Bench Verified", score: 0.5 };

const TIER_SCORE: Record<string, number> = { fast: 0.25, balanced: 0.55, deep: 0.85 };

type EndpointOver = Record<string, unknown> & {
  providerID?: string;
  tier?: string;
  score?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  capabilities?: { toolcall?: boolean; input?: Array<string> | Record<string, boolean> };
};
type Endpoint = Record<string, unknown>;

// The intended benchmark quality per endpoint, keyed by endpointKey. Quality
// is a catalogue SERVICE input (the benchmark a given model posts), never a
// field on the candidate — so it lives here, looked up from the normalised
// candidate's providerID/id exactly as production's catalogue lookup does,
// instead of being hand-stamped onto the candidate object.
const SCORES = new Map<string, number>();

// Build one candidate through the real normaliser fed a raw `/provider`
// payload, so a fixture can never quietly disagree with what the box produces.
function endpoint(id: string, over: EndpointOver = {}): Endpoint {
  const { providerID = "p", tier = "balanced", score, cost, capabilities, ...rest } = over;
  const key = `${providerID}/${id}`;
  SCORES.set(key, score ?? TIER_SCORE[tier]);
  const raw = {
    id,
    status: "active",
    cost: cost
      ? { input: cost.input, output: cost.output, cache: { read: cost.cacheRead, write: cost.cacheWrite } }
      : { input: 1, output: 2, cache: { read: 0.5, write: 0.5 } },
    capabilities: { toolcall: true, input: ["image", "pdf"], ...capabilities },
    ...rest,
  };
  const m = _normalizeProviderModel(providerID, id, raw);
  if (!m) throw new Error(`candidate ${providerID}/${id} failed to normalise`);
  return m;
}

function defaultDeclared(catalog: Endpoint[]): Record<string, { catalogId: string }> {
  return Object.fromEntries(catalog.map((c) => [endpointKey(c), { catalogId: String(c.id) }]));
}

type RouteOpts = {
  catalog: Endpoint[];
  policy?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  services?: Record<string, unknown>;
  nowMs?: number;
};

function route({ catalog, policy, intent = {}, services: extra = {}, nowMs = 0 }: RouteOpts) {
  const services: RoutingServices = {
    catalogEntryFor: (c: any) => ({ benchmarks: [{ ...CHECK, score: SCORES.get(endpointKey(c)) ?? CHECK.score }] }),
    qualityField: { benchmarkPercentile: (_n: string, s: any) => s },
    declared: defaultDeclared(catalog),
    accounts: {},
    health: {},
    telemetry: {},
    ...(extra as RoutingServices),
  };
  return chooseModel({
    intent: { kind: "start", agent: "general", ...intent },
    catalog,
    policy,
    nowMs,
    services,
  });
}

const keyOf = endpointKey;

describe("PRESETS / AGENT_TIER", () => {
  it("exposes the three presets and the tier table read by the renderer", () => {
    expect(PRESETS).toEqual(["economy", "balanced", "performance"]);
    expect(AGENT_TIER.balanced.general).toBe("balanced");
    expect(AGENT_TIER.economy.general).toBe("fast");
  });
});

describe("chooseModel — off-path and invariants", () => {
  it("returns the incumbent by reference when routing is not activated", () => {
    const incumbent = endpoint("m", { providerID: "a" });
    const res = route({ catalog: [endpoint("other")], policy: {}, intent: { incumbent } });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("routing not activated for this conversation");
  });

  it("never routes mid-exchange", () => {
    const incumbent = endpoint("m", { providerID: "a" });
    const cheap = endpoint("other", { tier: "fast" });
    const res = route({
      catalog: [incumbent, cheap],
      policy: { preset: "performance" },
      intent: { kind: "mid-exchange", incumbent },
    });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("mid-exchange switching is disabled");
  });

  it("returns incumbent + non-empty reason when nothing survives filtering", () => {
    const incumbent = endpoint("m", { providerID: "a" });
    const res = route({
      catalog: [endpoint("dead", { providerID: "p" })],
      policy: { preset: "balanced" },
      intent: { incumbent },
      // A still-hard drop (provider out of credit) — status no longer excludes
      // a model (BET-1267 3d), so "nothing survives" must come from a real
      // per-turn constraint.
      services: { health: { p: "out-of-credit" } },
    });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toContain("no general model passes constraints");
  });

  it("REGRESSION: routing activates from a preset alone (BET-1251)", () => {
    const cheap = endpoint("haiku-4", { tier: "fast" });
    const balanced = endpoint("sonnet-4", { tier: "balanced" });
    const res = route({
      catalog: [cheap, balanced],
      policy: { preset: "economy" },
      intent: { incumbent: endpoint("opus-4", { providerID: "a" }) },
    });
    expect(res.model?.id).toBe("sonnet-4");
    expect(res.changed).toBe(true);
  });
});

describe("chooseModel — hard stages (eligibility, capability, health)", () => {
  it("honours the agent floor under economy (general raised fast -> balanced)", () => {
    expect(AGENT_FLOOR_SCORE.general).toBe(0.4);
    expect(AGENT_TIER.economy.general).toBe("fast");
    const fast = endpoint("haiku-4", { tier: "fast" });
    const balanced = endpoint("sonnet-4", { tier: "balanced" });
    const res = route({ catalog: [balanced, fast], policy: { preset: "economy" } });
    if (tierRank(AGENT_TIER.economy.general) < tierRank("balanced")) {
      // floor must win: a fast model exists but the lower bound is balanced
      expect(res.model?.id).toBe("sonnet-4");
    }
    expect(res.model).toBeTruthy();
  });

  it("endpoints do not merge — two providers of one model are two candidates", () => {
    const dear = endpoint("m", { providerID: "a" });
    const cheap = endpoint("m", { providerID: "b", cost: { input: 0.1, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05 } });
    const res = route({ catalog: [dear, cheap], policy: { preset: "balanced" } });
    expect(res.model?.providerID).toBe("b");
    expect(res.alternatives.some((x) => keyOf(x) === keyOf(dear))).toBe(true);
  });

  it("cheaper blended price wins between two endpoints of the same model", () => {
    const a = endpoint("m", { providerID: "a", cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 } });
    const b = endpoint("m", { providerID: "b", cost: { input: 5, output: 5, cacheRead: 2.5, cacheWrite: 2.5 } });
    const res = route({ catalog: [b, a], policy: { preset: "balanced" } });
    expect(res.model?.providerID).toBe("a");
  });

  it("the cache case: identical input/output, the caching endpoint wins", () => {
    const caching = endpoint("m", { providerID: "a", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
    const noCache = endpoint("m", { providerID: "b", cost: { input: 1, output: 1 } });
    const res = route({
      catalog: [noCache, caching],
      policy: { preset: "balanced" },
      services: { declared: { ...defaultDeclared([caching, noCache]), "b/m": { catalogId: "m", caches: true } } },
    });
    expect(res.model?.providerID).toBe("a");
  });

  it("tool filter fires: a tool-requiring intent drops toolcall:false", () => {
    const good = endpoint("m", { providerID: "a", capabilities: { toolcall: true, input: { image: true, pdf: true } } });
    const bad = endpoint("m", { providerID: "b", capabilities: { toolcall: false, input: { image: true, pdf: true } } });
    const res = route({
      catalog: [bad, good],
      policy: { preset: "balanced" },
      intent: { needs: { tools: true } },
    });
    expect(res.model?.providerID).toBe("a");
    expect(res.alternatives.find((x) => keyOf(x) === keyOf(bad))).toBeUndefined();
  });

  it("modality: an image-carrying turn drops an endpoint that cannot take images", () => {
    const good = endpoint("m", { providerID: "a" });
    const noImg = endpoint("m", { providerID: "b", capabilities: { toolcall: true, input: { image: false, pdf: true } } });
    const res = route({
      catalog: [noImg, good],
      policy: { preset: "balanced" },
      intent: { needs: { image: true } },
    });
    expect(res.model?.providerID).toBe("a");
  });

  it("unidentifiable excluded: autoEligibility false is never chosen", () => {
    const known = endpoint("known");
    const opaque = endpoint("opaque", { providerID: "q" });
    // `opaque` is deliberately NOT declared, so its identity is unknown.
    const res = route({
      catalog: [opaque, known],
      policy: { preset: "balanced" },
      services: { declared: defaultDeclared([known]) },
    });
    expect(res.model?.id).toBe("known");
  });

  it("unhealthy excluded: an out-of-credit provider is unselectable even when sole candidate", () => {
    const only = endpoint("m", { providerID: "a" });
    const incumbent = endpoint("inc", { providerID: "x" });
    const res = route({
      catalog: [only],
      policy: { preset: "balanced" },
      services: { health: { a: "out-of-credit" } },
      intent: { incumbent },
    });
    expect(res.model).toBe(incumbent);
    expect(res.changed).toBe(false);
    expect(res.reason).toContain("out-of-credit");
  });

  it("rate-limited is also excluded as a hard constraint", () => {
    const only = endpoint("m", { providerID: "a" });
    const incumbent = endpoint("inc", { providerID: "x" });
    const res = route({
      catalog: [only],
      policy: { preset: "balanced" },
      services: { health: { a: "rate-limited" } },
      intent: { incumbent },
    });
    expect(res.model).toBe(incumbent);
    expect(res.reason).toContain("rate-limited");
  });
});

describe("chooseModel — soft ordering (stage 3)", () => {
  it("reliability outranks price within a model: a penalised endpoint loses to a dearer reliable one", () => {
    const reliable = endpoint("m", { providerID: "a", cost: { input: 10, output: 10, cacheRead: 5, cacheWrite: 5 } });
    const unreliable = endpoint("m", { providerID: "b", cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 } });
    const res = route({
      catalog: [unreliable, reliable],
      policy: { preset: "balanced" },
      services: {
        reliability: {
          samples: { "b/m": { requests: 30, errored: 15, rate: 0.5 } },
          baseline: { m: { rate: 0.1, n: 100 } },
        },
      },
    });
    expect(res.model?.providerID).toBe("a");
  });

  it("below the sample floor no penalty applies and cost decides", () => {
    const reliable = endpoint("m", { providerID: "a", cost: { input: 10, output: 10, cacheRead: 5, cacheWrite: 5 } });
    const cheap = endpoint("m", { providerID: "b", cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 } });
    const res = route({
      catalog: [cheap, reliable],
      policy: { preset: "balanced" },
      services: {
        reliability: {
          samples: { "b/m": { requests: 3, errored: 3, rate: 1 } },
          baseline: { m: { rate: 0.1, n: 100 } },
        },
      },
    });
    expect(res.model?.providerID).toBe("b");
  });

  it("ties are defined: identical cost yields the same winner across runs and shuffles", () => {
    const a = endpoint("m", { providerID: "a" });
    const b = endpoint("m", { providerID: "b" });
    const base = route({ catalog: [a, b], policy: { preset: "balanced" } });
    for (let i = 0; i < 40; i++) {
      const shuffled = [a, b].sort(() => Math.random() - 0.5);
      const res = route({ catalog: shuffled, policy: { preset: "balanced" } });
      expect(keyOf(res.model)).toBe(keyOf(base.model));
    }
    expect(keyOf(base.model)).toBe("a/m"); // full key is the last, deterministic tiebreak
  });

  it("is deterministic across 100 shuffles of the catalog", () => {
    const catalog = [
      endpoint("sonnet-4", { tier: "balanced" }),
      endpoint("gpt-4o", { tier: "balanced" }),
      endpoint("gpt-5", { tier: "balanced" }),
      endpoint("haiku-4", { tier: "fast" }),
    ];
    const incumbent = endpoint("sonnet-4", { providerID: "a" });
    const base = route({ catalog, policy: { preset: "balanced" }, intent: { incumbent } });
    for (let i = 0; i < 100; i++) {
      const shuffled = [...catalog].sort(() => Math.random() - 0.5);
      const res = route({ catalog: shuffled, policy: { preset: "balanced" }, intent: { incumbent } });
      expect(keyOf(res.model)).toBe(keyOf(base.model));
    }
  });

  it("partitions by model: a cheaper weaker model never displaces a stronger one under balanced", () => {
    const strong = endpoint("strong", { tier: "balanced", score: 0.6, providerID: "a", cost: { input: 100, output: 100, cacheRead: 50, cacheWrite: 50 } });
    const weak = endpoint("weak", { tier: "balanced", score: 0.45, providerID: "b", cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 } });
    const res = route({ catalog: [weak, strong], policy: { preset: "balanced" } });
    expect(res.model?.id).toBe("strong");
  });

  it("under economy the partition is flattened: the cheaper weaker model wins, and the reason says so", () => {
    const strong = endpoint("strong", { tier: "balanced", score: 0.6, providerID: "a", cost: { input: 100, output: 100, cacheRead: 50, cacheWrite: 50 } });
    const weak = endpoint("weak", { tier: "balanced", score: 0.45, providerID: "b", cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 } });
    const res = route({ catalog: [weak, strong], policy: { preset: "economy" } });
    expect(res.model?.id).toBe("weak");
    expect(res.reason.toLowerCase()).toContain("economy");
  });

  it("widening: an empty target band widens one band, never below the floor", () => {
    // general's floor is balanced; only a deep model is available -> widen up to deep.
    const deep = endpoint("deep", { tier: "deep", providerID: "a" });
    const res = route({ catalog: [deep], policy: { preset: "balanced" } });
    expect(res.model?.id).toBe("deep");
  });

  it("soft never empties: even when every endpoint is penalised, a winner is still returned", () => {
    const a = endpoint("m", { providerID: "a" });
    const b = endpoint("m", { providerID: "b" });
    const res = route({
      catalog: [a, b],
      policy: { preset: "balanced" },
      services: {
        reliability: {
          samples: { "a/m": { requests: 30, errored: 30, rate: 1 }, "b/m": { requests: 30, errored: 30, rate: 1 } },
          baseline: { m: { rate: 0.1, n: 100 } },
        },
      },
    });
    expect(res.model).toBeTruthy();
    expect(["a", "b"]).toContain(res.model?.providerID);
  });
});

describe("chooseModel — return shape", () => {
  it("alternatives are capped at 3 same-tier runners-up, ordered", () => {
    const a = endpoint("m", { providerID: "a", cost: { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.5 } });
    const b = endpoint("m", { providerID: "b", cost: { input: 2, output: 2, cacheRead: 1, cacheWrite: 1 } });
    const c = endpoint("m", { providerID: "c", cost: { input: 3, output: 3, cacheRead: 1.5, cacheWrite: 1.5 } });
    const d = endpoint("m", { providerID: "d", cost: { input: 4, output: 4, cacheRead: 2, cacheWrite: 2 } });
    const e = endpoint("m", { providerID: "e", cost: { input: 5, output: 5, cacheRead: 2.5, cacheWrite: 2.5 } });
    const res = route({ catalog: [a, b, c, d, e], policy: { preset: "balanced" } });
    expect(res.model?.providerID).toBe("a");
    expect(res.alternatives.map((x) => x.providerID)).toEqual(["b", "c", "d"]);
  });
});

describe("chooseModel — decision trace (BET-1265)", () => {
  it("on a winner, reports what it actually used: quality basis, cost, mix, reliability, telemetry", () => {
    const a = endpoint("sonnet", { providerID: "p", tier: "balanced" });
    const b = endpoint("haiku", { providerID: "p", tier: "fast" });
    const res = route({
      catalog: [a, b],
      policy: { preset: "balanced" },
      intent: { incumbent: endpoint("opus", { providerID: "p" }), contextTokens: 0, needs: { tools: true } },
      services: { telemetry: { "p/sonnet": { p50Ms: 120, p90Ms: 300, tokensPerSec: 80 } } },
    });
    expect(res.model?.id).toBe("sonnet");
    expect(res.trace.considered).toBe(2);
    expect(res.trace.dropped).toEqual([]);
    expect(res.trace.intent).toEqual({ contextTokens: 0, needs: { tools: true } });
    expect(res.trace.target.widened).toBe(false);
    const w = res.trace.winner!;
    expect(typeof w.quality.score).toBe("number");
    expect(["benchmark", "family", "structural"]).toContain(w.quality.basis);
    expect(w.quality.known).toBe(true);
    expect(typeof w.cost.value).toBe("number");
    expect(w.cost.mixSource).toBe("default");
    expect(w.cost.reference).toBe("absent");
    expect(w.reliability).toBe("unmeasured");
    expect(w.telemetry).toEqual({ p50Ms: 120, p90Ms: 300, tokensPerSec: 80 });
  });

  it("measured telemetry is read, with per-field null fallback when absent", () => {
    const res = route({
      catalog: [endpoint("m", { tier: "balanced" })],
      policy: { preset: "balanced" },
      services: { telemetry: { "p/m": { tokensPerSec: 40 } } },
    });
    const w = res.trace.winner!;
    expect(w.telemetry).toEqual({ p50Ms: null, p90Ms: null, tokensPerSec: 40 });
  });

  it("intent echoes the caller's contextTokens and needs verbatim", () => {
    const res = route({
      catalog: [endpoint("m", { tier: "balanced" })],
      policy: { preset: "balanced" },
      intent: { contextTokens: 0, needs: {} },
    });
    expect(res.trace.intent).toEqual({ contextTokens: 0, needs: {} });
  });

  it("no-survivor: winner is null and dropped names every stage/reason pair with counts", () => {
    // Three candidates dropped for three still-hard reasons: out-of-credit
    // (health), unknown identity, and no tool-calling. Status no longer drops
    // a model (BET-1267 3d), so no "no active model" here.
    const credit = endpoint("credit", { providerID: "p" });
    const opaque = endpoint("opaque", { providerID: "q" });
    const toolLess = endpoint("tool", { providerID: "p", capabilities: { toolcall: false, input: { image: true, pdf: true } } });
    const incumbent = endpoint("inc", { providerID: "x" });
    const res = route({
      catalog: [credit, opaque, toolLess],
      policy: { preset: "balanced" },
      intent: { incumbent, contextTokens: 0, needs: { tools: true } },
      services: { declared: defaultDeclared([credit, toolLess]), health: { p: "out-of-credit" } },
    });
    expect(res.model?.providerID).toBe("x"); // incumbent returned unchanged
    expect(res.trace.winner).toBeNull();
    expect(res.trace.considered).toBe(3);
    expect(res.trace.dropped).toHaveLength(3);
    expect(res.trace.dropped).toEqual(
      expect.arrayContaining([
        { stage: "capable", reason: "out-of-credit", n: 1 },
        { stage: "eligible", reason: "identity", n: 1 },
        { stage: "capable", reason: "tool calling", n: 1 },
      ]),
    );
    expect(res.trace.intent).toEqual({ contextTokens: 0, needs: { tools: true } });
  });
});
