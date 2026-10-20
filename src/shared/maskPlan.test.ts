// Tests for src/shared/maskPlan.mjs — the pure sticky-trims planner (spec
// docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md §3.1, §4, C5).
// Vitest, like the sibling shared tests: no DOM, no fs, no network. The plugins
// inline a copy of this module; the same fixtures run through each copy
// (docs/opencode-plugins/manta-optimizer.test.ts, scripts/opencode-v2/optimizer.test.mjs).

import { describe, it, expect } from "vitest";
import {
  PLACEHOLDER_ARGS_MAX,
  PLACEHOLDER_PREFIX,
  MAX_MAP_ENTRIES,
  renderPlaceholder,
  estTokens,
  resolveRates,
  adaptV1,
  boundaryOf,
  appliedStats,
  planRequest,
} from "./maskPlan.mjs";
import {
  POLICY,
  PRICE_OPUS,
  PRICE_NO_PREMIUM,
  MODEL_KEY,
  PROVIDER,
  MODEL,
  ratesOf,
  emptyState,
  calls,
  toV1,
  applyV1,
  v1Outputs,
  boundaryV1,
} from "./maskPlan.fixtures.mjs";

const NOW = 1_100; // fresh: the fixtures' assistants completed at ~1000, TTL 5 min
const DEAD_NOW = 1_000 + 400_000;
const model = { providerID: PROVIDER, modelID: MODEL };

/** Plan one request over a V1 history with sensible defaults. */
function plan(over: Record<string, any> = {}) {
  const messages = over.messages ?? toV1(calls(60));
  const adapted = adaptV1(messages);
  const res = planRequest({
    messages: adapted,
    policy: over.policy ?? POLICY,
    authoritative: over.authoritative ?? true,
    rates: "rates" in over ? over.rates : ratesOf(PRICE_OPUS),
    state: over.state ?? emptyState({ reqCount: 1 }),
    boundary: "boundary" in over ? over.boundary : prevBoundary(messages),
    model: over.model ?? model,
    now: () => over.now ?? NOW,
    lastCompletedMs: "lastCompletedMs" in over ? over.lastCompletedMs : adapted.lastCompletedMs,
  });
  return { res, adapted, messages };
}
/** The boundary a plugin would have recorded after the PREVIOUS request (one call fewer). */
function prevBoundary(messages: any[]) {
  return boundaryV1(messages.slice(0, -1));
}

describe("estTokens / renderPlaceholder (unchanged contract)", () => {
  it("estimates tokens from string length only", () => {
    expect(estTokens("")).toBe(0);
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("x".repeat(10))).toBe(3);
    expect(estTokens(42)).toBe(0);
    expect(estTokens(null)).toBe(0);
  });
  it("names the tool and its arguments", () => {
    const ph = renderPlaceholder("bash", { echo: "hi" }, POLICY.placeholderFormat);
    expect(ph).toBe('[manta: trimmed — re-run `bash` with {"echo":"hi"} to see this again]');
    expect(ph.startsWith(PLACEHOLDER_PREFIX)).toBe(true);
  });
  it("falls back to 'tool', truncates args, survives circular input", () => {
    expect(renderPlaceholder(undefined, { a: 1 }, POLICY.placeholderFormat)).toContain("`tool`");
    const ph = renderPlaceholder("bash", { payload: "a".repeat(PLACEHOLDER_ARGS_MAX * 3) }, POLICY.placeholderFormat);
    expect(ph).toContain("…");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(renderPlaceholder("bash", circular, POLICY.placeholderFormat)).toContain(" with {}");
  });
});

describe("resolveRates (§3.1)", () => {
  const base = { input: 4, cacheRead: 0.2, cacheWrite: 5 };
  it("plain record → {cacheRead, cacheWrite}", () => {
    expect(resolveRates(base, 1000)).toEqual({ cacheRead: 0.2, cacheWrite: 5 });
  });
  it("a missing or zero cacheWrite means no write premium (cacheWrite := input)", () => {
    expect(resolveRates({ input: 1, cacheRead: 0.1 }, 0)).toEqual({ cacheRead: 0.1, cacheWrite: 1 });
    expect(resolveRates({ input: 1, cacheRead: 0.1, cacheWrite: 0 }, 0)).toEqual({ cacheRead: 0.1, cacheWrite: 1 });
  });
  it("unusable records are unpriced: input or cacheRead missing / zero", () => {
    expect(resolveRates({ input: 0, cacheRead: 0.1 }, 0)).toBeNull();
    expect(resolveRates({ input: 1, cacheRead: 0 }, 0)).toBeNull();
    expect(resolveRates({ input: 1 } as any, 0)).toBeNull();
    expect(resolveRates(null, 0)).toBeNull();
  });
  it("tiers apply on a STRICT > threshold; the highest applying tier wins; missing fields inherit", () => {
    const rec = {
      ...base,
      tiers: [
        { minPromptTokens: 200_000, input: 8, cacheRead: 0.4, cacheWrite: 10 },
        { minPromptTokens: 500_000, cacheRead: 0.8 }, // inherits input/cacheWrite from the BASE record
      ],
    };
    expect(resolveRates(rec, 200_000)).toEqual({ cacheRead: 0.2, cacheWrite: 5 }); // == size → not applied
    expect(resolveRates(rec, 200_001)).toEqual({ cacheRead: 0.4, cacheWrite: 10 });
    expect(resolveRates(rec, 600_000)).toEqual({ cacheRead: 0.8, cacheWrite: 5 });
  });
  it("tiers beat context_over_200k; context_over_200k alone is a single 200k tier", () => {
    const both = {
      ...base,
      tiers: [{ minPromptTokens: 100_000, cacheRead: 0.3, cacheWrite: 6 }],
      context_over_200k: { input: 99, cacheRead: 9, cacheWrite: 99 },
    };
    expect(resolveRates(both, 300_000)).toEqual({ cacheRead: 0.3, cacheWrite: 6 });
    const only = { ...base, context_over_200k: { cacheRead: 0.5, cacheWrite: 7 } };
    expect(resolveRates(only, 200_000)).toEqual({ cacheRead: 0.2, cacheWrite: 5 });
    expect(resolveRates(only, 200_001)).toEqual({ cacheRead: 0.5, cacheWrite: 7 });
  });
  it("raw models.dev names are tolerated (cache_read / tier.size)", () => {
    const raw = { input: 3, cache_read: 0.3, cache_write: 3.75, tiers: [{ tier: { type: "context", size: 200_000 }, cache_read: 0.6, cache_write: 7.5 }] };
    expect(resolveRates(raw as any, 10)).toEqual({ cacheRead: 0.3, cacheWrite: 3.75 });
    expect(resolveRates(raw as any, 300_000)).toEqual({ cacheRead: 0.6, cacheWrite: 7.5 });
  });
  it("1h write pricing only when asked AND the record carries a 1h price; else unpriced", () => {
    const rec = { ...base, cacheWrite1h: 8 };
    expect(resolveRates(rec, 0, { oneHour: true })).toEqual({ cacheRead: 0.2, cacheWrite: 8 });
    expect(resolveRates(rec, 0)).toEqual({ cacheRead: 0.2, cacheWrite: 5 });
    expect(resolveRates(base, 0, { oneHour: true })).toBeNull(); // never infer 2 × input
    const tiered = { ...rec, tiers: [{ minPromptTokens: 100, cacheWrite1h: 16 }] };
    expect(resolveRates(tiered, 1000, { oneHour: true })).toEqual({ cacheRead: 0.2, cacheWrite: 16 });
  });
});

describe("adaptV1", () => {
  it("units: completed tool parts carry their callID; no callID → id:null (never trimmed)", () => {
    const withId = adaptV1(toV1(calls(3)));
    expect(withId.units.filter((u) => u.kind === "tool").map((u) => u.id)).toEqual(["call_0", "call_1", "call_2"]);
    const noId = adaptV1(toV1(calls(3), { withId: false }));
    expect(noId.units.filter((u) => u.kind === "tool").every((u) => u.id === null)).toBe(true);
  });
  it("N counts completed non-summary assistant messages; lastCompletedMs is the newest completion", () => {
    const ms = toV1(calls(4), { completedAt: 5_000 });
    ms[2].info.summary = true;
    ms.push({ info: { id: "m_x", role: "assistant", time: { created: 99 } }, parts: [] }); // in flight
    const a = adaptV1(ms);
    expect(a.assistantCount).toBe(3);
    expect(a.lastCompletedMs).toBe(5_003);
  });
  it("boundary key is info.id; an id-less message has no boundary", () => {
    const ms = toV1(calls(2));
    expect(boundaryOf(adaptV1(ms))).toEqual({ messageCount: 3, lastMessageKey: "msg_acall_1" });
    delete ms[2].info.id;
    expect(boundaryOf(adaptV1(ms))).toBeNull();
  });
});

describe("planRequest — eligibility is unchanged (tail / recency / skills / placeholders)", () => {
  const eligibleIds = (messages: any[], policy = POLICY) => {
    const { res } = plan({ messages, policy, rates: ratesOf(PRICE_NO_PREMIUM), lastCompletedMs: 0 });
    return { res, ids: Object.keys(res.add) };
  };
  it("the newest maskAfterUses tool uses are never trimmed", () => {
    const { ids } = eligibleIds(toV1(calls(40)));
    expect(ids).not.toContain("call_39");
    expect(ids).not.toContain("call_38");
    expect(ids).toContain("call_37");
    expect(ids).toContain("call_0");
  });
  it("a part inside the protected tail is never trimmed", () => {
    const small = toV1(calls(40, { outTokens: 10 })); // 400 tokens total ≤ 1000 tail
    expect(plan({ messages: small }).res.R).toBe(0);
  });
  it("never trims a skill part, a callID-less part, or an already-placeholder output", () => {
    const list = calls(40);
    list[0].tool = "skill-do-thing";
    list[1].output = `${PLACEHOLDER_PREFIX} — already`;
    const ms = toV1(list);
    delete ms[3].parts[0].callID; // call_2 has no id
    const { ids } = eligibleIds(ms);
    expect(ids).not.toContain("call_0");
    expect(ids).not.toContain("call_1");
    expect(ids).not.toContain("call_2");
    expect(ids).toContain("call_3");
  });
  it("a candidate whose placeholder is not smaller than its output is skipped (R is NET)", () => {
    const list = calls(40);
    list[0].output = "tiny"; // 1 token < the placeholder
    const { ids } = eligibleIds(toV1(list));
    expect(ids).not.toContain("call_0");
    expect(ids).toContain("call_1");
  });
  it("R is net of the replacement tokens", () => {
    const { res } = plan({ messages: toV1(calls(40)), rates: ratesOf(PRICE_NO_PREMIUM), lastCompletedMs: 0 });
    const repl = estTokens(renderPlaceholder("bash", { n: 0 }, POLICY.placeholderFormat));
    expect(res.R).toBeGreaterThan(0);
    expect(res.R % 1).toBe(0);
    expect(res.R).toBeLessThan(Object.keys(res.add).length * 2000);
    expect(res.R).toBeGreaterThan(Object.keys(res.add).length * (2000 - repl - 1));
  });
});

describe("planRequest — the gate (§4.4)", () => {
  it("worked-example shape: breakEven = T·(w−r)/(R·r); grows iff min(N,200) ≥ margin·breakEven", () => {
    const { res } = plan({ messages: toV1(calls(60)) });
    const r = PRICE_OPUS.cacheRead as number;
    const w = PRICE_OPUS.cacheWrite as number;
    expect(res.R).toBeGreaterThan(0);
    expect(res.T).toBeGreaterThan(0);
    expect(res.breakEven).toBeCloseTo((res.T * (w - r)) / (res.R * r), 9);
    expect(res.N).toBe(60);
    expect(Math.min(res.N, 200)).toBeGreaterThanOrEqual(1.5 * res.breakEven);
    expect(res.decision).toBe("grow");
    expect(res.reason).toBe("live");
    expect(res.rewarmTokens).toBe(res.T);
  });
  it("a short session cannot pay back an expensive re-cache → no growth (payback)", () => {
    const { res } = plan({ messages: toV1(calls(30)) });
    expect(res.decision).toBe("none");
    expect(res.reason).toBe("payback");
    expect(res.breakEven).toBeGreaterThan(res.N / 1.5);
    expect(res.dirty).toBe(false);
  });
  it("margin is configurable; the default is 1.5", () => {
    const messages = toV1(calls(60));
    expect(plan({ messages, policy: { ...POLICY, margin: 100 } }).res.reason).toBe("payback");
    const noMargin: any = { ...POLICY };
    delete noMargin.margin;
    expect(plan({ messages, policy: noMargin }).res.decision).toBe("grow");
  });
  it("a provider with no write premium (cacheWrite missing) pays back almost immediately", () => {
    const { res } = plan({ messages: toV1(calls(30)), rates: ratesOf(PRICE_NO_PREMIUM) });
    expect(res.breakEven).toBeCloseTo((res.T * (1 - 0.1)) / (res.R * 0.1), 9);
    expect(res.decision).toBe("grow"); // 30 ≥ 1.5 × ~9
  });
  it("R below batchTokens → no growth", () => {
    const { res } = plan({ messages: toV1(calls(60)), policy: { ...POLICY, batchTokens: 10_000_000 } });
    expect(res.decision).toBe("none");
    expect(res.reason).toBe("below-batch");
  });
  it("unpriced (rates null) → no growth, even on a dead cache", () => {
    const messages = toV1(calls(60));
    const { res } = plan({ messages, rates: null });
    expect(res.decision).toBe("none");
    expect(res.reason).toBe("unpriced");
    expect(plan({ messages, rates: null, now: DEAD_NOW }).res.decision).toBe("none");
    expect(plan({ messages, rates: () => null }).res.reason).toBe("unpriced");
  });
  it("rates may be a function of the estimated prompt size (tier selection)", () => {
    const seen: number[] = [];
    const { res } = plan({
      messages: toV1(calls(60)),
      rates: (pt: number) => {
        seen.push(pt);
        return ratesOf(PRICE_OPUS);
      },
    });
    expect(seen.length).toBe(1); // memoized
    expect(seen[0]).toBeGreaterThan(120_000);
    expect(res.rates?.cacheRead).toBe(0.2);
  });
  it("no valid boundary → no LIVE-cache growth (first request in this process)", () => {
    const messages = toV1(calls(60));
    const { res } = plan({ messages, boundary: null });
    expect(res.decision).toBe("none");
    expect(res.reason).toBe("no-boundary");
    // a boundary whose key no longer matches (revert) is no boundary either
    const stale = { messageCount: 40, lastMessageKey: "msg_other" };
    expect(plan({ messages, boundary: stale }).res.reason).toBe("no-boundary");
  });
  it("cache known dead (V1 time.completed older than the TTL) → growth allowed without T or a boundary", () => {
    const messages = toV1(calls(30)); // too short to pay back a LIVE re-cache
    const { res } = plan({ messages, boundary: null, now: DEAD_NOW });
    expect(res.decision).toBe("grow");
    expect(res.reason).toBe("dead");
    expect(res.cacheDead).toBe(true);
    expect(res.rewarmTokens).toBe(0);
    expect(res.nextState.nextGrowthAllowedAt).toBe(1 + 1); // reqCount + 1
  });
  it("V2-style input (lastCompletedMs 0) is NEVER known dead; unknown freshness = live", () => {
    const { res } = plan({ messages: toV1(calls(30)), boundary: null, now: DEAD_NOW, lastCompletedMs: 0 });
    expect(res.cacheDead).toBe(false);
    expect(res.decision).toBe("none");
  });
  it("a model switch is known dead for the new model: grow without a boundary, nothing re-written", () => {
    const state = emptyState({ reqCount: 5, lastModel: "openai/gpt-6-sol" });
    const { res } = plan({ messages: toV1(calls(30)), state, boundary: null, lastCompletedMs: 0 });
    expect(res.cacheDead).toBe(true);
    expect(res.decision).toBe("grow");
    expect(res.rewarmTokens).toBe(0);
    expect(res.nextState.lastModel).toBe(MODEL_KEY);
    // the same model as last time is not a switch
    const same = plan({ messages: toV1(calls(30)), state: emptyState({ reqCount: 5, lastModel: MODEL_KEY }), boundary: null, lastCompletedMs: 0 });
    expect(same.res.cacheDead).toBe(false);
  });
  it("cooldown: nextGrowthAllowedAt = reqCount + ceil(breakEven of THAT growth); a cheap batch right after is refused", () => {
    const messages = toV1(calls(60));
    const first = plan({ messages, state: emptyState({ reqCount: 7 }) });
    expect(first.res.decision).toBe("grow");
    expect(first.res.nextState.nextGrowthAllowedAt).toBe(7 + Math.ceil(first.res.breakEven));
    // an attractive batch (no-premium prices) one request later still waits out the cooldown
    const committed = first.res.nextState;
    const next = plan({
      messages: toV1(calls(61)),
      rates: ratesOf(PRICE_NO_PREMIUM),
      state: { ...committed, reqCount: 8 },
      boundary: boundaryV1(messages),
    });
    expect(next.res.decision).toBe("none");
    expect(next.res.reason).toBe("cooldown");
    // …and is allowed once the first growth has had time to pay back
    const later = plan({
      messages: toV1(calls(61)),
      rates: ratesOf(PRICE_NO_PREMIUM),
      state: { ...committed, reqCount: committed.nextGrowthAllowedAt },
      boundary: boundaryV1(messages),
    });
    expect(later.res.decision).toBe("grow");
  });
  it("breakEven 0 (cacheWrite == cacheRead): live growth still leaves at least one request before the next growth", () => {
    const messages = toV1(calls(60));
    const free = { cacheRead: 0.2, cacheWrite: 0.2, source: "config", fetchedAt: 1 };
    const first = plan({ messages, rates: free, state: emptyState({ reqCount: 7 }) });
    expect(first.res.decision).toBe("grow");
    expect(first.res.reason).toBe("live");
    expect(first.res.breakEven).toBe(0);
    expect(first.res.nextState.nextGrowthAllowedAt).toBe(8); // reqCount + max(1, 0), never reqCount
    // the very next request is the one allowed to grow again; the same request is not
    const same = plan({
      messages: toV1(calls(61)),
      rates: free,
      state: { ...first.res.nextState, reqCount: 7 },
      boundary: boundaryV1(messages),
    });
    expect(same.res.decision).toBe("none");
    expect(same.res.reason).toBe("cooldown");
  });
  it("compaction (history shorter than the boundary) resets the cooldown and invalidates the boundary", () => {
    const messages = toV1(calls(40));
    const state = emptyState({ reqCount: 10, nextGrowthAllowedAt: 99 });
    const { res } = plan({ messages, state, boundary: { messageCount: 500, lastMessageKey: "msg_gone" }, now: DEAD_NOW });
    expect(res.compacted).toBe(true);
    expect(res.boundaryValid).toBe(false);
    expect(res.decision).toBe("grow"); // cooldown reset to reqCount → dead-cache growth allowed
  });
  it("entry cap: at cap, growth stops (a live replacement is never evicted)", () => {
    const real: Record<string, string> = {};
    for (let i = 0; i < MAX_MAP_ENTRIES; i++) real[`old_${i}`] = "[manta: trimmed]";
    const { res } = plan({ messages: toV1(calls(60)), state: emptyState({ reqCount: 1, real }) });
    expect(res.decision).toBe("none");
    expect(res.reason).toBe("cap");
  });
});

describe("planRequest — transitions (§4.3 table)", () => {
  const trimmed = () => {
    const first = plan({ messages: toV1(calls(60)) });
    return first.res.nextState; // a state with a non-empty real map
  };
  it("provisional policy: never grows, never clears; the committed map is applied as-is", () => {
    const state = trimmed();
    const messages = toV1(calls(61));
    const grow = plan({ messages, authoritative: false, state: { ...state, reqCount: 99 }, boundary: boundaryV1(messages.slice(0, -1)) });
    expect(grow.res.decision).toBe("none");
    expect(grow.res.dirty).toBe(false);
    expect(grow.res.nextState.real).toBe(state.real);
    expect(grow.res.applied.parts).toBe(Object.keys(state.real).length);
    expect(grow.res.applied.tokens).toBeGreaterThan(0);
    // a provisional DISABLED-looking policy does not clear either
    const off = plan({ messages, authoritative: false, policy: { ...POLICY, enabled: false }, state: { ...state, reqCount: 99 } });
    expect(off.res.decision).toBe("none");
    expect(off.res.nextState.real).toBe(state.real);
  });
  it("authoritative + disabled with trims live → CLEAR: untrimmed request, needs no prices", () => {
    const state = trimmed();
    const messages = toV1(calls(61));
    const { res } = plan({ messages, policy: { ...POLICY, enabled: false }, rates: null, state: { ...state, reqCount: 3 } });
    expect(res.decision).toBe("clear");
    expect(res.nextState.real).toEqual({});
    expect(res.applied).toEqual({ tokens: 0, parts: 0 });
    expect(res.dirty).toBe(true);
    expect(res.nextState.nextGrowthAllowedAt).toBe(3);
    expect(res.T).toBeGreaterThan(0);
    expect(res.rewarmTokens).toBe(res.T); // live cache: the whole cached span from the earliest trim re-writes
    expect(res.shadow.decision).toBe("none"); // shadow untouched on a clear request
  });
  it("clear when the cache is known dead re-writes nothing; without a boundary T_clear runs to the end of the history", () => {
    const state = trimmed();
    const messages = toV1(calls(61));
    const dead = plan({ messages, policy: { ...POLICY, enabled: false }, rates: null, state, now: DEAD_NOW });
    expect(dead.res.decision).toBe("clear");
    expect(dead.res.rewarmTokens).toBe(0);
    const noBoundary = plan({ messages, policy: { ...POLICY, enabled: false }, rates: null, state, boundary: null });
    const withBoundary = plan({ messages, policy: { ...POLICY, enabled: false }, rates: null, state });
    expect(noBoundary.res.T).toBeGreaterThan(withBoundary.res.T);
  });
  it("authoritative + disabled, nothing live → the SHADOW map may grow; nothing is applied", () => {
    const { res } = plan({ messages: toV1(calls(60)), policy: { ...POLICY, enabled: false } });
    expect(res.decision).toBe("none");
    expect(res.shadow.decision).toBe("grow");
    expect(res.shadowRewarmTokens).toBeGreaterThan(0);
    expect(Object.keys(res.nextState.shadow).length).toBeGreaterThan(0);
    expect(res.nextState.real).toEqual({});
    expect(res.applied).toEqual({ tokens: 0, parts: 0 });
    expect(res.shadow.parts).toBe(Object.keys(res.nextState.shadow).length);
    expect(res.dirty).toBe(true);
  });
  it("enabling starts with an EMPTY real map (shadow is not adopted) and clears the shadow", () => {
    const shadow = plan({ messages: toV1(calls(60)), policy: { ...POLICY, enabled: false } }).res.nextState;
    expect(Object.keys(shadow.shadow).length).toBeGreaterThan(0);
    const { res } = plan({ messages: toV1(calls(30)), state: { ...shadow, reqCount: 2 } }); // too short to grow
    expect(res.decision).toBe("none");
    expect(res.nextState.real).toEqual({});
    expect(res.nextState.shadow).toEqual({});
    expect(res.dirty).toBe(true);
    expect(res.shadow.decision).toBe("none");
  });
  it("unpriced + switch off: shadow never grows either", () => {
    const { res } = plan({ messages: toV1(calls(60)), policy: { ...POLICY, enabled: false }, rates: null });
    expect(res.shadow.decision).toBe("none");
    expect(res.dirty).toBe(false);
  });
  it("ids absent from the history are pruned at the next commit, not before", () => {
    const state = emptyState({ reqCount: 1, real: { ghost: "[manta: trimmed]" } });
    const idle = plan({ messages: toV1(calls(30)), state });
    expect(idle.res.dirty).toBe(false);
    expect(idle.res.nextState.real).toEqual({ ghost: "[manta: trimmed]" });
    const grew = plan({ messages: toV1(calls(60)), state });
    expect(grew.res.decision).toBe("grow");
    expect(grew.res.nextState.real).not.toHaveProperty("ghost");
  });
});

describe("planRequest — bail-outs apply to discovery, never to replay (§4.3)", () => {
  const state = () => plan({ messages: toV1(calls(60)) }).res.nextState;
  it("more parts than maxTransformParts: no growth, the committed map is still applied", () => {
    const s = state();
    const messages = toV1(calls(61));
    const { res } = plan({ messages, policy: { ...POLICY, maxTransformParts: 10 }, state: { ...s, reqCount: 500 } });
    expect(res.decision).toBe("none");
    expect(res.reason).toBe("parts");
    expect(res.nextState.real).toBe(s.real);
    expect(res.applied.parts).toBe(Object.keys(s.real).length);
  });
  it("time budget exhausted mid-scan: no growth, replacements kept", () => {
    const s = state();
    let t = 0;
    const messages = toV1(calls(300));
    const adapted = adaptV1(messages);
    const res = planRequest({
      messages: adapted,
      policy: POLICY,
      authoritative: true,
      rates: ratesOf(PRICE_OPUS),
      state: { ...s, reqCount: 500 },
      boundary: boundaryV1(messages.slice(0, -1)),
      model,
      now: () => (t += 100),
      lastCompletedMs: 0,
    });
    expect(res.reason).toBe("budget");
    expect(res.decision).toBe("none");
    expect(res.nextState.real).toBe(s.real);
  });
});

describe("planRequest — sticky: 30 synthetic requests, one new tool call each", () => {
  it("the sent history is identical between growths; growth only when the gate passes; cooldown honours the accepted growth's break-even", () => {
    const all = calls(120);
    let state = emptyState();
    let prevSent: string[] | null = null;
    let prevMessages: any[] | null = null;
    const grows: { at: number; be: number; allowedAt: number }[] = [];
    for (let n = 70; n < 100; n++) {
      const messages = toV1(all.slice(0, n));
      const adapted = adaptV1(messages);
      state = { ...state, reqCount: state.reqCount + 1 };
      const res = planRequest({
        messages: adapted,
        policy: POLICY,
        authoritative: true,
        rates: ratesOf(PRICE_OPUS),
        state,
        boundary: prevMessages ? boundaryV1(prevMessages) : null,
        model,
        now: () => NOW,
        lastCompletedMs: adapted.lastCompletedMs,
      });
      if (res.dirty) state = res.nextState;
      else state = { ...state, ...{ lastModel: res.nextState.lastModel, nextGrowthAllowedAt: res.nextState.nextGrowthAllowedAt } };
      applyV1(messages, state.real);
      const sent = v1Outputs(messages);
      if (res.decision === "grow") {
        grows.push({ at: state.reqCount, be: res.breakEven, allowedAt: res.nextState.nextGrowthAllowedAt });
        expect(Math.min(res.N, 200)).toBeGreaterThanOrEqual(1.5 * res.breakEven);
        expect(res.reason).toBe("live");
      } else if (prevSent) {
        // no growth: everything the previous request sent is a byte-identical prefix of this one
        expect(sent.slice(0, prevSent.length)).toEqual(prevSent);
      }
      prevSent = sent;
      prevMessages = toV1(all.slice(0, n)); // untouched copy: the boundary is recorded on the untouched input
    }
    expect(grows.length).toBeGreaterThan(0);
    for (let i = 1; i < grows.length; i++) {
      expect(grows[i].at).toBeGreaterThanOrEqual(grows[i - 1].allowedAt);
    }
    // far fewer growths than requests: that is the whole point
    expect(grows.length).toBeLessThanOrEqual(3);
  });
});

describe("appliedStats", () => {
  it("net tokens removed = original − replacement over units present in the map", () => {
    const adapted = adaptV1(toV1(calls(5)));
    const map = { call_0: "[manta: trimmed]", call_1: "[manta: trimmed]", nope: "x" };
    const s = appliedStats(adapted, map);
    expect(s.parts).toBe(2);
    expect(s.tokens).toBe(2 * (2000 - estTokens("[manta: trimmed]")));
    expect(appliedStats(adapted, {})).toEqual({ tokens: 0, parts: 0 });
  });
});
