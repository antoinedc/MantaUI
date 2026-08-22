import { describe, it, expect } from "vitest";
import { chooseModel, incumbentStillEligible, AGENT_TIER, PRESETS, type RoutingServices } from "./modelRouter.mjs";
import { endpointKey } from "./endpointKey.mjs";
import { tierRank } from "./modelGuide.mjs";
import { AGENT_FLOOR_SCORE } from "./modelQuality.mjs";
// Per standing rule 9, candidates below are built with the REAL normaliser,
// not a hand-written fixture — a fixture that disagreed with production is how
// these defects survived a green suite. The services context is likewise built
// through the REAL box-side assembly (buildRoutingServices) so the
// declared-catalogId behaviour of catalogEntryFor is the shipped one.
// The two server .mjs modules have no bundled type declarations (they are
// consumed from node:test .test.mjs). The seams below are exercised through
// the real modules — the fixtures are deliberately not hand-typed.
// The tests import real server .mjs (normaliser, services wiring, adapters) so
// fixtures and account shapes cannot quietly disagree with production (BET-1269
// standing rule 9). Those modules have no bundled .d.mts, hence the directives.
// @ts-expect-error — server .mjs has no bundled declarations.
import { _normalizeProviderModel } from "../server/opencode.mjs";
// @ts-expect-error — server .mjs has no bundled declarations.
import { buildRoutingServices, accountsFromSnapshots } from "../server/routingServices.mjs";
// @ts-expect-error — server .mjs has no bundled declarations.
import { claudeAdapter } from "../server/usageAdapters/claude.mjs";
// @ts-expect-error — server .mjs has no bundled declarations.
import { codexAdapter } from "../server/usageAdapters/codex.mjs";

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

// A fetch-shaped Response for the real adapters — never the network.
function fakeRes(status: number, body: unknown) {
  return { ok: status < 300, status, headers: { get: () => null }, json: async () => body };
}

async function claudeSnapshot(body: unknown) {
  return claudeAdapter.fetch({
    readCredentials: async () => ({ accessToken: "x" }),
    fetchImpl: async () => fakeRes(200, body),
  });
}

async function codexSnapshot(body: unknown) {
  return codexAdapter.fetch({
    readToken: async () => "x",
    fetchImpl: async () => fakeRes(200, body),
    now: () => 0,
  });
}

// The real adapters' fetch() does not carry providerIDs — the usage poller adds
// them from adapter.providerIDs. Mirror that so accountsFromSnapshots keys by
// opencode providerID exactly as production does.
function accountFor(adapter: { providerIDs: string[] }, snapshot: Record<string, unknown>) {
  return accountsFromSnapshots([{ ...snapshot, providerIDs: adapter.providerIDs }] as any);
}

// Real services for a catalogue-driven scenario: reference prices, benchmarks,
// accounts and a ledger mix all built through buildRoutingServices.
async function catalogueServices(opts: {
  declaredModels: Record<string, unknown>;
  entries: Record<string, unknown>;
  endpoints: Array<Record<string, unknown>>;
  snapshots?: Array<Record<string, unknown>>;
  endpointSummary?: () => Promise<Record<string, unknown>>;
}) {
  return (await buildRoutingServices(
    { modelRouting: { preset: "balanced", declaredModels: opts.declaredModels } },
    {
      catalogIndex: {
        lookupModel: (id: string) => (opts.entries[id] ? opts.entries[id] : null),
        matchModel: () => ({ kind: "none", candidates: [] }),
        allModels: () => Object.values(opts.entries),
      },
      endpoints: opts.endpoints as any,
      snapshots: (opts.snapshots as any) ?? [],
      providerHealthState: () => undefined,
      endpointSummary: opts.endpointSummary ?? (async () => ({})),
    },
  )) as RoutingServices;
}

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

  it("7d: a measured-reliable endpoint beats an unmeasured one at identical cost", () => {
    // Provider ids are chosen OPPOSITE the rank order so a main-branch key
    // tie-break would pick the wrong one — this test fails on main where an
    // unmeasured endpoint was treated as good (identical to measured).
    const measured = endpoint("m", { providerID: "z" });
    const unmeasured = endpoint("m", { providerID: "a" });
    const res = route({
      catalog: [unmeasured, measured],
      policy: { preset: "balanced" },
      services: {
        reliability: {
          samples: { "z/m": { requests: 50, errored: 5, rate: 0.1 } },
          baseline: { m: { rate: 0.1, n: 1000 } },
        },
      },
    });
    expect(res.model?.providerID).toBe("z");
  });

  it("7d: an unmeasured endpoint beats a deranked one", () => {
    const unmeasured = endpoint("m", { providerID: "a" });
    const deranked = endpoint("m", { providerID: "y" });
    const res = route({
      catalog: [deranked, unmeasured],
      policy: { preset: "balanced" },
      services: {
        reliability: {
          samples: { "y/m": { requests: 50, errored: 25, rate: 0.5 } },
          baseline: { m: { rate: 0.1, n: 1000 } },
        },
      },
    });
    expect(res.model?.providerID).toBe("a");
  });

  it("two endpoints differing only in p50TokensPerSec are ordered by it", () => {
    const fast = endpoint("m", { providerID: "a" });
    const slow = endpoint("m", { providerID: "z" });
    const res = route({
      catalog: [slow, fast],
      policy: { preset: "balanced" },
      services: {
        telemetry: { "a/m": { tokensPerSec: 100 }, "z/m": { tokensPerSec: 40 } },
      },
    });
    expect(res.model?.providerID).toBe("a");
  });

  it("7e: two endpoints differing only in p90TokensPerSec are ordered by it (throughput p50 ties)", () => {
    // Keys tilt the other way so a main-branch tie-break (which discarded the
    // p90 throughput) would pick the slower endpoint — fails on main, fixed here.
    const fast = endpoint("m", { providerID: "z" });
    const slow = endpoint("m", { providerID: "a" });
    const res = route({
      catalog: [slow, fast],
      policy: { preset: "balanced" },
      services: {
        telemetry: {
          "z/m": { tokensPerSec: 100, p90TokensPerSec: 90 },
          "a/m": { tokensPerSec: 100, p90TokensPerSec: 60 },
        },
      },
    });
    expect(res.model?.providerID).toBe("z");
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

describe("chooseModel — judge the resolved endpoint, not the provider's raw claims (BET-1268)", () => {
  // The two false "claims" modelIdentity exists to refute: an empty cost bag
  // and a context limit of 0. A provider reporting these is not saying
  // "unknown" — it is guessing, and both guesses are wrong.
  const HALLUCINATING = { cost: {}, limit: { context: 0 } };

  // The catalogue's real facts for the model the user declares this endpoint
  // to be.
  const DECLARED = {
    id: "declared-sonnet",
    family: "sonnet",
    limit: { context: 262000 },
    benchmarks: [{ name: "SWE-Bench Verified", score: 0.85 }],
  };
  // The entry a fuzzy match on an opaque endpoint id would WRONGLY resolve to.
  const FUZZY = { id: "fuzzy", family: "haiku", limit: { context: 128000 } };

  const matchModel = (id: string) =>
    id === "fuzzyable"
      ? { kind: "exact", candidates: [FUZZY] }
      : { kind: "none", candidates: [] };

  async   function realServices(declaredModels: Record<string, unknown>): Promise<RoutingServices> {
    return (await buildRoutingServices(
      { modelRouting: { preset: "balanced", declaredModels } },
      {
        catalogIndex: {
          lookupModel: (id: string) => (id === "declared-sonnet" ? DECLARED : null),
          matchModel,
          allModels: () => [DECLARED],
        },
        endpoints: [{ providerID: "p", id: "declared-sonnet" }],
        snapshots: [],
        providerHealthState: () => undefined,
        endpointSummary: async () => ({}),
      },
    )) as RoutingServices;
  }

  it("1. the catalogue's real context limit reaches the headroom filter — a conversation that fits 262k is not dropped", async () => {
    const services = await realServices({
      "p/declared-sonnet": { catalogId: "declared-sonnet", price: { input: 2, output: 8 }, caches: false },
    });
    const candidate = _normalizeProviderModel("p", "declared-sonnet", HALLUCINATING)!;
    const res = chooseModel({
      intent: { kind: "start", agent: "general", needs: {}, contextTokens: 150000 },
      catalog: [candidate],
      policy: { preset: "balanced" },
      services,
    });
    // The provider claimed `context: 0`; the catalogue's 262k is what governs.
    // 150k tokens fit 262k, so the endpoint survives — it is not dropped for
    // "context headroom".
    expect(res.model).not.toBeNull();
    expect(res.model?.id).toBe("declared-sonnet");
    expect(res.trace.dropped.find((d) => d.reason === "context headroom")).toBeUndefined();
  });

  it("2. a declared price reaches the cost — trace.winner.cost.value reflects it, not 0", async () => {
    const services = await realServices({
      "p/declared-sonnet": { catalogId: "declared-sonnet", price: { input: 2, output: 8 }, caches: false },
    });
    const candidate = _normalizeProviderModel("p", "declared-sonnet", HALLUCINATING)!;
    const res = chooseModel({
      intent: { kind: "start", agent: "general", needs: {}, contextTokens: 150000 },
      catalog: [candidate],
      policy: { preset: "balanced" },
      services,
    });
    const w = res.trace.winner!;
    expect(w).not.toBeNull();
    // input 2 / output 8, missing cache rates bill at the input rate under the
    // default mix: 2*0.08 + 8*0.05 + 2*0.8 + 2*0.07 = 2.30.
    expect(w.cost.value).toBeGreaterThan(0);
    expect(w.cost.value).toBeCloseTo(2.3, 9);
  });

  it("3. a declared catalogId wins over a fuzzy match — quality comes from the declared entry", async () => {
    const services = await realServices({
      // `fuzzyable` WOULD fuzzy-match to the haiku entry, but the user declared
      // it is really the sonnet model.
      "p/fuzzyable": { catalogId: "declared-sonnet", price: { input: 2, output: 8 }, caches: false },
    });
    const candidate = _normalizeProviderModel("p", "fuzzyable", HALLUCINATING)!;
    const res = chooseModel({
      intent: { kind: "start", agent: "general", needs: {}, contextTokens: 1000 },
      catalog: [candidate],
      policy: { preset: "balanced" },
      services,
    });
    const w = res.trace.winner!;
    expect(w).not.toBeNull();
    // The declared catalogue entry carries the benchmark; the fuzzy haiku entry
    // has none (it would place the endpoint by family instead).
    expect(w.quality.basis).toBe("benchmark");
    expect(w.quality.known).toBe(true);
  });
});

describe("chooseModel — the cost stage (BET-1269): measured mix, catalogue reference, subscription pricing", () => {
  // --- Test 2: mix is measured ---------------------------------------------
  // Two endpoints, identical capability (same model, same band), differing only
  // in cache discount. Under a cache-heavy MEASURED mix the caching endpoint
  // wins; under a cache-light measured mix the cheap-fresh one wins. On main
  // the per-endpoint mix never arrives, so mixSource stays "default".
  const CACHE_HEAVY = { input: 0.08, output: 0.05, cacheRead: 0.8, cacheWrite: 0.07 };
  const CACHE_LIGHT = { input: 0.45, output: 0.45, cacheRead: 0.05, cacheWrite: 0.05 };

  it("2. mix is measured: the winner flips with a cache-heavy vs cache-light ledger mix", () => {
    const cachey = endpoint("m", { providerID: "a", cost: { input: 2, output: 2, cacheRead: 0.1, cacheWrite: 0.1 } });
    const fresh = endpoint("m", { providerID: "b", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
    const heavy = route({
      catalog: [fresh, cachey],
      policy: { preset: "balanced" },
      services: { mix: { "a/m": CACHE_HEAVY, "b/m": CACHE_HEAVY }, mixDefault: CACHE_HEAVY },
    });
    expect(heavy.model?.providerID).toBe("a");
    expect(heavy.trace.winner!.cost.mixSource).toBe("measured");
    const light = route({
      catalog: [fresh, cachey],
      policy: { preset: "balanced" },
      services: { mix: { "a/m": CACHE_LIGHT, "b/m": CACHE_LIGHT }, mixDefault: CACHE_LIGHT },
    });
    expect(light.model?.providerID).toBe("b");
    expect(light.trace.winner!.cost.mixSource).toBe("measured");
  });

  it("2b. an endpoint with no ledger history is priced on the box's overall mixDefault", () => {
    // Both mixDefault entries are the same per-endpoint value in 2; here the
    // winner's cost is computed with mixDefault alone (no per-endpoint mix).
    const cachey = endpoint("m", { providerID: "a", cost: { input: 2, output: 2, cacheRead: 0.1, cacheWrite: 0.1 } });
    const fresh = endpoint("m", { providerID: "b", cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } });
    const res = route({
      catalog: [fresh, cachey],
      policy: { preset: "balanced" },
      services: { mixDefault: CACHE_HEAVY },
    });
    expect(res.trace.winner!.cost.mixSource).toBe("measured");
    expect(res.model?.providerID).toBe("a");
  });

  // --- Test 3: implausible zero loses (catalogue reference wired) ----------
  const ORIG_SONNET = {
    id: "declared-sonnet",
    family: "sonnet",
    limit: { context: 262000 },
    benchmarks: [{ name: "SWE-Bench Verified", score: 0.85 }],
    cost: { input: 3, output: 15 },
  };

  it("3. a reseller quoting 0/0 for a model the catalogue prices in dollars loses", async () => {
    const services = await catalogueServices({
      declaredModels: { "b/declared-sonnet": { catalogId: "declared-sonnet", caches: false }, "a/declared-sonnet": { catalogId: "declared-sonnet", caches: false } },
      entries: { "declared-sonnet": ORIG_SONNET },
      endpoints: [{ providerID: "b", id: "declared-sonnet" }, { providerID: "a", id: "declared-sonnet" }],
    });
    const reseller = _normalizeProviderModel("b", "declared-sonnet", { id: "declared-sonnet", status: "active", cost: { input: 0, output: 0 }, capabilities: { toolcall: true } })!;
    const firstParty = _normalizeProviderModel("a", "declared-sonnet", { id: "declared-sonnet", status: "active", cost: { input: 3, output: 15 }, capabilities: { toolcall: true } })!;
    const res = chooseModel({
      intent: { kind: "start", agent: "general", needs: {}, contextTokens: 1000 },
      catalog: [reseller, firstParty],
      policy: { preset: "balanced" },
      services,
    });
    // The reseller's 0/0 is judged against the catalogue's real rate (it is NOT
    // a gift) — so the first party, quoting the real rate, wins within the
    // model's own cost contest.
    expect(res.model?.providerID).toBe("a");
  });

  it("3b. a declared-free endpoint still wins", async () => {
    const services = await catalogueServices({
      declaredModels: { "b/declared-sonnet": { catalogId: "declared-sonnet", price: "free", caches: false }, "a/declared-sonnet": { catalogId: "declared-sonnet", caches: false } },
      entries: { "declared-sonnet": ORIG_SONNET },
      endpoints: [{ providerID: "b", id: "declared-sonnet" }, { providerID: "a", id: "declared-sonnet" }],
    });
    const declaredFree = _normalizeProviderModel("b", "declared-sonnet", { id: "declared-sonnet", status: "active", cost: { input: 3, output: 15 }, capabilities: { toolcall: true } })!;
    const firstParty = _normalizeProviderModel("a", "declared-sonnet", { id: "declared-sonnet", status: "active", cost: { input: 3, output: 15 }, capabilities: { toolcall: true } })!;
    const res = chooseModel({
      intent: { kind: "start", agent: "general", needs: {}, contextTokens: 1000 },
      catalog: [declaredFree, firstParty],
      policy: { preset: "balanced" },
      services,
    });
    // A user-declared "free" is AUTHORITATIVE — the catalogue reference does not
    // re-classify it as implausible zero. The free endpoint wins.
    expect(res.model?.providerID).toBe("b");
  });

  // --- Test 5: subscription beats free (real codex subscription) -----------
  it("5. a well-paced subscription outranks a free model of equal task capability (5e)", async () => {
    // The real codex adapter: a *subscription* (kind) that also reports a credit
    // balance. On main the balance inference misclassifies it as credit.
    const snap: any = await codexSnapshot({
      rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 18000, reset_at: 2000 } },
      plan_type: "plus",
      credits: { balance: 14.2 },
    });
    // Position the session window ON PACE (consumed 0.6 / elapsed 0.6) so the
    // cost basis is the pace curve, not the gauge.
    const win = snap.windows[0];
    win.startedAt = 1000;
    win.resetsAt = 2000;
    const onPaceNow = 1000 + 0.6 * (2000 - 1000);
    const accounts = accountFor(codexAdapter, snap as any); // { openai: { kind: "subscription", balance: 14.2, windows: [...] } }
    const codexModel = endpoint("gpt", { providerID: "openai", tier: "balanced" });
    const freeModel = endpoint("free", { providerID: "f", tier: "fast", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const res = route({
      catalog: [freeModel, codexModel],
      policy: { preset: "balanced" },
      nowMs: onPaceNow,
      services: {
        accounts: { openai: (accounts as any).openai },
        declared: { ...defaultDeclared([codexModel, freeModel]), "f/free": { catalogId: "free", price: "free" } },
      },
    });
    expect(res.model?.providerID).toBe("openai");
    expect(res.trace.winner!.cost.basis.startsWith("subscription")).toBe(true);
    expect(res.trace.winner!.cost.basis).toBe("subscription-pace");
  });

  // --- Test 6: exhausted is excluded, not expensive -------------------------
  it("6. an exhausted provider is unselectable even as the only candidate; the incumbent is kept", async () => {
    // The real claude adapter reporting a 100% session window → exhausted.
    const snap: any = await claudeSnapshot({
      five_hour: { utilization: 100, resets_at: 2000 },
      seven_day: { utilization: 30, resets_at: 2000 + 86400000 },
    });
    const accounts = accountFor(claudeAdapter, snap as any); // { anthropic: { kind: "subscription", windows: [pct 100], exhausted: true } }
    const only = endpoint("m", { providerID: "anthropic" });
    const incumbent = endpoint("inc", { providerID: "x" });
    const res = route({
      catalog: [only],
      policy: { preset: "balanced" },
      intent: { incumbent },
      services: { accounts: { anthropic: (accounts as any).anthropic } },
    });
    expect(res.model?.providerID).toBe("x");
    expect(res.changed).toBe(false);
    expect(res.reason.toLowerCase()).toContain("no general model passes constraints");
  });

  // --- Test 7: stale never excludes -----------------------------------------
  // A stale 100% window (set by the usage poller the moment a reset passes) must
  // not escalate: it contributes neither exhaustion nor pace. On main the
  // exhaustion check ignores `stale` and drops the provider.
  it("7. a stale 100% window leaves the provider selectable", () => {
    const a = endpoint("m", { providerID: "a" });
    const res = route({
      catalog: [a],
      policy: { preset: "balanced" },
      services: { accounts: { a: { kind: "subscription", windows: [{ pct: 100, stale: true }] } } },
    });
    expect(res.model?.providerID).toBe("a");
  });

  it("7b. if every window is stale the account is priced as if it had none (no-window), not exhausted", () => {
    const a = endpoint("m", { providerID: "a" });
    const res = route({
      catalog: [a],
      policy: { preset: "balanced" },
      services: { accounts: { a: { kind: "subscription", windows: [{ pct: 100, stale: true }] } } },
    });
    expect(res.model?.providerID).toBe("a");
    expect(res.trace.winner!.cost.basis).toBe("subscription-no-window");
  });
});

describe("provider health in routing (BET-1270 6a)", () => {
  // Two endpoints of the SAME model with IDENTICAL cost/quality — the only
  // differing signal is provider health. Under economy the set is flattened and
  // ordered by cmpWithinModel, so a soft `failing` health must sort the failing
  // endpoint BEHIND the healthy one (placed after reliability, before cost).
  it("softly deprioritises a failing provider behind a healthy one", () => {
    const healthy = endpoint("claude-sonnet-4", { providerID: "healthy", tier: "deep", cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0.5 } });
    const failing = endpoint("claude-sonnet-4", { providerID: "failing", tier: "deep", cost: { input: 3, output: 15, cacheRead: 0.5, cacheWrite: 0.5 } });
    const res = route({
      catalog: [failing, healthy],
      policy: { preset: "economy" },
      services: { health: { failing: "failing", healthy: "ok" } },
    });
    expect(res.model?.providerID).toBe("healthy");
    expect(res.alternatives.map((a: any) => a.providerID)).toContain("failing");
    expect(res.trace.considered).toBe(2);
  });

  it("NEVER drops a failing provider — only failing candidates still route", () => {
    const a = endpoint("claude-haiku", { providerID: "x", tier: "deep", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 } });
    const b = endpoint("claude-haiku", { providerID: "y", tier: "deep", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 } });
    const res = route({
      catalog: [a, b],
      policy: { preset: "economy" },
      services: { health: { x: "failing", y: "failing" } },
    });
    expect(res.model).toBeTruthy();
    expect(res.trace.dropped.length).toBe(0);
  });

  it("out-of-credit and rate-limited still EXCLUDE (hard), not deprioritise", () => {
    for (const state of ["out-of-credit", "rate-limited"]) {
      const res = route({
        catalog: [endpoint("m", { providerID: "p" })],
        policy: { preset: "balanced" },
        services: { health: { p: state } },
      });
      expect(res.model).toBeNull();
      expect(res.reason).toContain("no general model passes constraints");
    }
  });
});

describe("incumbentStillEligible (BET-1270 6e)", () => {
  it("returns true for a describable incumbent (declared catalogue identity)", () => {
    const incumbent = endpoint("claude-sonnet-4", { providerID: "anthropic", tier: "deep" });
    const services = {
      declared: { "anthropic/claude-sonnet-4": { catalogId: "claude-sonnet-4" } },
    };
    expect(incumbentStillEligible(incumbent, services)).toBe(true);
  });

  it("returns false for an incumbent Auto can no longer describe", () => {
    const incumbent = endpoint("opaque", { providerID: "custom" });
    expect(
      incumbentStillEligible(incumbent, {
        declared: {},
        catalogMatcher: { lookupModel: () => null, matchModel: () => ({ kind: "none", candidates: [] }) },
        catalogEntryFor: () => null,
      }),
    ).toBe(false);
  });

  it("returns true for a null / absent incumbent", () => {
    expect(incumbentStillEligible(null, undefined)).toBe(true);
  });
});
