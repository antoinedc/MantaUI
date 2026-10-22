// The optimizer plugin ships to EVERY box (sync_opencode_plugins), so what it
// does at its defaults matters: with the switch OFF it must stay observe-only
// (never touch the history), and a cold or provisional policy must never grow
// or clear the trim set. These tests drive the REAL plugin file against a fake
// manta-server (stubbed fetch) and a throwaway state dir (MANTA_STATE_HOME is
// sandboxed by vitest.config.ts; every test gets its own subdirectory).
//
// Spec: docs/superpowers/specs/2026-10-20-optimizer-sticky-trims.md (§4, §8).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync as readSource } from "node:fs";
import ts from "typescript";
import * as shared from "../../src/shared/maskPlan.mjs";
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
  boundaryV1,
} from "../../src/shared/maskPlan.fixtures.mjs";

const PLUGIN_FILE = join(__dirname, "manta-optimizer.ts");
const outputs = (ms: any[]) => ms.flatMap((m) => (m.parts ?? []).filter((p: any) => p.type === "tool").map((p: any) => p.state.output));
const isTrimmed = (o: string) => o.startsWith("[manta: trimmed");

let stateHome: string;
let reports: any[];
let askedUrls: string[];
let policies: Record<string, any>; // sessionID → policy body (absent → 503)
let pricesBody: any; // null → unreachable
let clock: { offset: number };
const realNow = Date.now.bind(Date);
const savedStateHome = process.env.MANTA_STATE_HOME;
const realFetch = globalThis.fetch;

const trimsDir = () => join(stateHome, ".manta", "optimizer-trims");
const readTrims = (sid: string) => JSON.parse(readFileSync(join(trimsDir(), `${sid}.json`), "utf-8"));
const pricesWith = (record: any, key = MODEL_KEY) => ({ fetchedAt: realNow(), models: { [key]: record } });

beforeEach(() => {
  vi.resetModules();
  stateHome = mkdtempSync(join(savedStateHome ?? "/tmp", "v1-opt-"));
  process.env.MANTA_STATE_HOME = stateHome;
  reports = [];
  askedUrls = [];
  policies = {};
  pricesBody = pricesWith(PRICE_OPUS);
  clock = { offset: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock.offset);
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    askedUrls.push(u);
    if (u.includes("/api/optimizer/counterfactual")) {
      reports.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    if (u.includes("/api/optimizer/policy")) {
      const sid = new URL(u).searchParams.get("sessionID") ?? "";
      return policies[sid] ? new Response(JSON.stringify(policies[sid]), { status: 200 }) : new Response("{}", { status: 503 });
    }
    if (u.includes("/api/optimizer/prices")) {
      return pricesBody ? new Response(JSON.stringify(pricesBody), { status: 200 }) : new Response("{}", { status: 503 });
    }
    return new Response("{}", { status: 404 });
  }) as any;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  if (savedStateHome === undefined) delete process.env.MANTA_STATE_HOME;
  else process.env.MANTA_STATE_HOME = savedStateHome;
});

const settle = () => new Promise((r) => setTimeout(r, 25));

async function boot(directory = "/proj/a") {
  const mod = await import("./manta-optimizer");
  const hooks: any = await (mod as any).MantaOptimizerMask({ directory });
  const run = async (messages: any[]) => {
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    await settle(); // let the un-awaited reports / refreshes land
  };
  return { run, hooks };
}
/** A fresh history for `sid`: n tool calls, assistants completed "now" (live cache). */
const hist = (sid: string, n: number) => toV1(calls(n), { sessionID: sid, completedAt: Date.now() });
const policyOn = { ...POLICY, enabled: true };
const policyOff = { ...POLICY, enabled: false };

describe("cold start / provisional policy", () => {
  it("a cold session: untouched, no report, and the first request triggers the policy + prices fetches (with directory)", async () => {
    const { run } = await boot("/proj/a");
    const ms = hist("ses_c", 80);
    const before = outputs(ms);
    await run(ms);
    expect(outputs(ms)).toEqual(before);
    expect(reports).toHaveLength(0);
    const policyReq = askedUrls.find((u) => u.includes("/api/optimizer/policy"))!;
    expect(new URL(policyReq).searchParams.get("sessionID")).toBe("ses_c");
    expect(new URL(policyReq).searchParams.get("directory")).toBe("/proj/a");
    expect(askedUrls.some((u) => u.includes("/api/optimizer/prices"))).toBe(true);
    expect(existsSync(trimsDir())).toBe(false);
  });

  it("an unreachable server never throws and never trims", async () => {
    pricesBody = null;
    const { run } = await boot();
    const ms = hist("ses_c", 80);
    const before = outputs(ms);
    await run(ms);
    await run(ms);
    expect(outputs(ms)).toEqual(before);
  });

  it("a policy that says enabled:false stays observe-only: the SHADOW map grows, the history is never touched", async () => {
    policies["ses_s"] = policyOff;
    const { run } = await boot();
    const ms = hist("ses_s", 80);
    const before = outputs(ms);
    await run(ms); // cold → provisional, fetches policy + prices
    expect(reports).toHaveLength(0);
    await run(ms); // authoritative + priced + a boundary now exists → shadow grows
    expect(outputs(ms)).toEqual(before);
    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r.v).toBe(3);
    expect(r.sessionID).toBe("ses_s");
    expect(r.providerID).toBe(PROVIDER);
    expect(r.modelID).toBe(MODEL);
    expect(r.applied).toEqual({ trimmedTokens: 0, trimmedParts: 0 });
    expect(r.shadow.trimmedTokens).toBeGreaterThan(0);
    expect(r.shadow.trimmedParts).toBeGreaterThan(0);
    expect(r.change).toBe("none");
    expect(r.shadowChange).toBe("grow");
    expect(r.shadowRewarmTokens).toBeGreaterThan(0);
    expect(r.rewarmTokens).toBe(0);
    expect(r.rates).toMatchObject({ cacheRead: 0.2, cacheWrite: 5, source: "catalog" });
    expect(typeof r.ts).toBe("number");
    const file = readTrims("ses_s");
    expect(Object.keys(file.shadow).length).toBe(r.shadow.trimmedParts);
    expect(file.real).toEqual({});
  });
});

describe("act mode: sticky trims", () => {
  it("grows once (priced), then replays byte-identical text on every later request; the file is 0600 in a 0700 dir", async () => {
    policies["ses_a"] = policyOn;
    const { run } = await boot();
    const m1 = hist("ses_a", 80);
    await run(m1); // cold
    const m2 = hist("ses_a", 80);
    await run(m2); // grows
    const trimmed2 = outputs(m2).filter(isTrimmed);
    expect(trimmed2.length).toBeGreaterThan(10);
    const grow = reports.at(-1);
    expect(grow.change).toBe("grow");
    expect(grow.rewarmTokens).toBeGreaterThan(0);
    expect(grow.applied.trimmedParts).toBe(trimmed2.length);
    expect(grow.applied.trimmedTokens).toBeGreaterThan(0);
    expect(grow.shadowChange).toBe("none");

    // three more requests, one new tool call each: the trimmed prefix never changes
    const sent: string[][] = [outputs(m2)];
    for (let n = 81; n <= 83; n++) {
      const m = hist("ses_a", n);
      await run(m);
      sent.push(outputs(m));
      const prev = sent[sent.length - 2];
      expect(sent[sent.length - 1].slice(0, prev.length)).toEqual(prev);
      expect(reports.at(-1).change).toBe("none");
      expect(reports.at(-1).applied.trimmedParts).toBeGreaterThanOrEqual(trimmed2.length);
    }
    expect(statSync(trimsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(trimsDir(), "ses_a.json")).mode & 0o777).toBe(0o600);
    const file = readTrims("ses_a");
    expect(file.version).toBe(1);
    expect(file.renderVersion).toBe(1);
    expect(file.lastModel).toBe(MODEL_KEY);
    expect(file.reqCount).toBeGreaterThanOrEqual(2);
    expect(Object.keys(file.real).length).toBe(trimmed2.length);
    expect(readdirSync(trimsDir()).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("an unpriced model is never trimmed (no growth), while existing replacements keep replaying", async () => {
    pricesBody = pricesWith(PRICE_OPUS, "anthropic/some-other-model");
    policies["ses_u"] = policyOn;
    const { run } = await boot();
    const ms = hist("ses_u", 80);
    const before = outputs(ms);
    await run(ms);
    await run(ms);
    expect(outputs(ms)).toEqual(before);
    expect(reports).toHaveLength(0);
  });

  it("a short session does not trim into a live cache it cannot pay back", async () => {
    policies["ses_short"] = policyOn;
    const { run } = await boot();
    const ms = hist("ses_short", 30);
    const before = outputs(ms);
    await run(ms);
    await run(ms);
    expect(outputs(ms)).toEqual(before);
  });

  it("a provider with no write premium pays back fast: trims even a short session", async () => {
    pricesBody = pricesWith(PRICE_NO_PREMIUM);
    policies["ses_np"] = policyOn;
    const { run } = await boot();
    await run(hist("ses_np", 30));
    const ms = hist("ses_np", 30);
    await run(ms);
    expect(outputs(ms).some(isTrimmed)).toBe(true);
    expect(reports.at(-1).rates).toMatchObject({ cacheRead: 0.1, cacheWrite: 1, source: "config" });
  });

  it("1h pricing only when the policy TTL is 1h AND the record carries a 1h write price", async () => {
    pricesBody = pricesWith({ ...PRICE_OPUS, cacheWrite1h: 8 });
    policies["ses_1h"] = { ...policyOn, cacheTtlMs: 3_600_000 };
    const { run } = await boot();
    await run(hist("ses_1h", 80));
    await run(hist("ses_1h", 80));
    expect(reports.at(-1).rates).toMatchObject({ cacheRead: 0.2, cacheWrite: 8 });

    // 1h TTL but no 1h price on the record → the 5-minute rates (documented in the plugin)
    reports.length = 0;
    pricesBody = pricesWith(PRICE_OPUS);
    policies["ses_1h2"] = { ...policyOn, cacheTtlMs: 3_600_000 };
    vi.resetModules();
    const b2 = await boot();
    await b2.run(hist("ses_1h2", 80));
    await b2.run(hist("ses_1h2", 80));
    expect(reports.at(-1).rates).toMatchObject({ cacheRead: 0.2, cacheWrite: 5 });
  });

  it("model switch: the first request on a NEW model has no cache to lose → trims right away, nothing re-written", async () => {
    const OTHER = "openai/gpt-6-sol";
    pricesBody = { fetchedAt: realNow(), models: { [MODEL_KEY]: PRICE_OPUS, [OTHER]: { ...PRICE_OPUS } } };
    policies["ses_m"] = policyOn;
    const onOther = (ms: any[]) => {
      for (const m of ms) {
        if (m.info.model) m.info.model = { providerID: "openai", modelID: "gpt-6-sol" };
        if (m.info.providerID) Object.assign(m.info, { providerID: "openai", modelID: "gpt-6-sol" });
      }
      return ms;
    };
    const { run } = await boot();
    await run(hist("ses_m", 30)); // cold
    const stay = hist("ses_m", 30);
    await run(stay);
    // 30 calls cannot pay back an Opus-priced LIVE cache → refused
    expect(outputs(stay).some(isTrimmed)).toBe(false);
    const switched = onOther(hist("ses_m", 30));
    await run(switched);
    expect(outputs(switched).some(isTrimmed)).toBe(true);
    const g = reports.find((r) => r.change === "grow")!;
    expect(g.modelID).toBe("gpt-6-sol");
    expect(g.rewarmTokens).toBe(0);
    expect(readTrims("ses_m").lastModel).toBe(OTHER);
  });
});

describe("per-session policy (D1)", () => {
  it("interleaved sessions A,B,A,B: each keeps its own authoritative policy — A trims, B (disabled) never does, neither flips", async () => {
    policies["ses_A"] = policyOn;
    policies["ses_B"] = policyOff;
    const { run } = await boot();
    const sentA: string[][] = [];
    let aTrimmed = 0;
    for (let i = 0; i < 6; i++) {
      const a = hist("ses_A", 80 + i);
      await run(a);
      sentA.push(outputs(a));
      const b = hist("ses_B", 80 + i);
      const bBefore = outputs(b);
      await run(b);
      expect(outputs(b)).toEqual(bBefore); // B's history is never trimmed, whatever A is doing
      if (i >= 2) {
        const prev = sentA[sentA.length - 2];
        expect(sentA[sentA.length - 1].slice(0, prev.length)).toEqual(prev); // A never flips back to untrimmed
        aTrimmed = Math.max(aTrimmed, outputs(a).filter(isTrimmed).length);
      }
    }
    expect(aTrimmed).toBeGreaterThan(10);
    expect(Object.keys(readTrims("ses_A").real).length).toBeGreaterThan(10);
    expect(Object.keys(readTrims("ses_B").real)).toEqual([]);
  });

  it("a brand-new session (provisional, even if another session's enabled policy is known) never grows or clears", async () => {
    policies["ses_A"] = policyOn;
    const { run } = await boot();
    await run(hist("ses_A", 80));
    await run(hist("ses_A", 80)); // A authoritative → lastAny = enabled
    policies["ses_new"] = policyOn;
    const fresh = hist("ses_new", 80);
    const before = outputs(fresh);
    await run(fresh); // cold → provisional (enabled policy, authoritative:false)
    expect(outputs(fresh)).toEqual(before);
    // and an existing trim file is replayed under a provisional policy, not cleared
    mkdirSync(trimsDir(), { recursive: true });
    const real = Object.fromEntries(calls(70).slice(0, 40).map((c) => [c.id, "[manta: trimmed — stored]"]));
    writeFileSync(join(trimsDir(), "ses_replay.json"), JSON.stringify(emptyState({ real })));
    const rp = hist("ses_replay", 80);
    await run(rp);
    expect(outputs(rp).filter((o) => o === "[manta: trimmed — stored]").length).toBe(40);
  });
});

describe("plan → commit → apply order", () => {
  it("a CLEAR (switch turned off) sends an UNTRIMMED request and reports change:clear with the re-warm", async () => {
    policies["ses_clr"] = policyOn;
    const { run } = await boot();
    await run(hist("ses_clr", 80));
    await run(hist("ses_clr", 80)); // grow
    expect(Object.keys(readTrims("ses_clr").real).length).toBeGreaterThan(10);
    policies["ses_clr"] = policyOff;
    clock.offset += 61_000; // the cached policy is stale → refetched in the background
    await run(hist("ses_clr", 81)); // still the stale (enabled) policy: replay
    clock.offset += 0;
    const ms = hist("ses_clr", 82);
    const before = outputs(ms);
    await run(ms); // the refetched disabled policy is authoritative → clear
    expect(outputs(ms)).toEqual(before); // untrimmed — the clear applied BEFORE this request went out
    const r = reports.at(-1);
    expect(r.change).toBe("clear");
    expect(r.rewarmTokens).toBeGreaterThan(0);
    expect(r.applied).toEqual({ trimmedTokens: 0, trimmedParts: 0 });
    expect(readTrims("ses_clr").real).toEqual({});
  });

  it("a failed write keeps the previous committed state, reports change:none and sends no new trim", async () => {
    policies["ses_w"] = policyOn;
    const { run } = await boot();
    await run(hist("ses_w", 80));
    await run(hist("ses_w", 80)); // grow, committed
    const committed = readTrims("ses_w").real;
    const nCommitted = Object.keys(committed).length;
    expect(nCommitted).toBeGreaterThan(10);
    // break the NEXT write (rename onto a directory fails), and make the gate want to grow again
    policies["ses_w"] = { ...policyOn, protectTailTokens: 500, maskAfterUses: 0 };
    const fs = await import("node:fs");
    fs.rmSync(join(trimsDir(), "ses_w.json"));
    mkdirSync(join(trimsDir(), "ses_w.json"));
    clock.offset += 61_000;
    await run(hist("ses_w", 85)); // stale → refresh
    reports.length = 0;
    const ms = hist("ses_w", 150);
    await run(ms);
    const r = reports.at(-1);
    expect(r.change).toBe("none");
    expect(r.rewarmTokens).toBe(0);
    expect(r.shadowRewarmTokens).toBe(0);
    // only the previously committed trims are in the request
    expect(outputs(ms).filter(isTrimmed).length).toBe(nCommitted);
    expect(r.applied.trimmedParts).toBe(nCommitted);
    expect(readdirSync(trimsDir()).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("restart (empty memory, file on disk)", () => {
  it("replays byte-identical, and does no live-cache growth until a boundary exists", async () => {
    policies["ses_r"] = policyOn;
    const first = await boot();
    await first.run(hist("ses_r", 80));
    const m2 = hist("ses_r", 80);
    await first.run(m2);
    const sent = outputs(m2);
    const stored = readTrims("ses_r");
    expect(Object.keys(stored.real).length).toBeGreaterThan(10);

    // "restart": fresh module state; the file survives
    vi.resetModules();
    const second = await boot();
    const m3 = hist("ses_r", 80);
    await second.run(m3); // policy cold (provisional) — replay from the file
    expect(outputs(m3)).toEqual(sent);
    const m4 = hist("ses_r", 80);
    await second.run(m4); // authoritative now
    expect(outputs(m4)).toEqual(sent);
    expect(readTrims("ses_r").real).toEqual(stored.real);

    // a bigger session on restart: the gate would allow growth, but there is no boundary on the FIRST request
    policies["ses_r2"] = policyOn;
    const seed = calls(120);
    mkdirSync(trimsDir(), { recursive: true });
    writeFileSync(join(trimsDir(), "ses_r2.json"), JSON.stringify(emptyState({ reqCount: 9, lastModel: MODEL_KEY })));
    vi.resetModules();
    const third = await boot();
    await third.run(toV1(seed, { sessionID: "ses_r2", completedAt: Date.now() })); // provisional + no boundary
    expect(readTrims("ses_r2").real).toEqual({});
    const m5 = toV1(seed, { sessionID: "ses_r2", completedAt: Date.now() });
    await third.run(m5); // authoritative + boundary recorded by the first request
    expect(outputs(m5).some(isTrimmed)).toBe(true);
  });

  it("bail-outs (too many parts) keep existing replacements", async () => {
    policies["ses_b"] = { ...policyOn, maxTransformParts: 10 };
    mkdirSync(trimsDir(), { recursive: true });
    const real = Object.fromEntries(calls(80).slice(0, 30).map((c) => [c.id, "[manta: trimmed — kept]"]));
    writeFileSync(join(trimsDir(), "ses_b.json"), JSON.stringify(emptyState({ real })));
    const { run } = await boot();
    await run(hist("ses_b", 80));
    const ms = hist("ses_b", 80);
    await run(ms);
    expect(outputs(ms).filter((o) => o === "[manta: trimmed — kept]").length).toBe(30);
    expect(reports.at(-1).change).toBe("none");
  });
});

describe("persistence safety (C4)", () => {
  it("a sessionID that is not a safe file name is never trimmed and never touches the disk", async () => {
    policies["../x"] = policyOn;
    const { run } = await boot();
    const ms = hist("../x", 80);
    const before = outputs(ms);
    await run(ms);
    await run(ms);
    expect(outputs(ms)).toEqual(before);
    expect(existsSync(trimsDir())).toBe(false);
    expect(existsSync(join(stateHome, ".manta", "x.json"))).toBe(false);
  });

  it("an oversized or corrupt file is treated as empty (and never crashes the request)", async () => {
    policies["ses_big"] = policyOff;
    policies["ses_bad"] = policyOff;
    mkdirSync(trimsDir(), { recursive: true });
    writeFileSync(join(trimsDir(), "ses_big.json"), "x".repeat(4 * 1024 * 1024 + 10));
    writeFileSync(join(trimsDir(), "ses_bad.json"), "{not json");
    const { run } = await boot();
    for (const sid of ["ses_big", "ses_bad"]) {
      const ms = hist(sid, 80);
      const before = outputs(ms);
      await expect(run(ms)).resolves.toBeUndefined();
      expect(outputs(ms)).toEqual(before);
    }
  });

  it("files untouched for > 14 days are pruned; a session in use gets its mtime touched", async () => {
    mkdirSync(trimsDir(), { recursive: true });
    const old = join(trimsDir(), "ses_old.json");
    writeFileSync(old, JSON.stringify(emptyState()));
    const longAgo = (realNow() - 15 * 24 * 3_600_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    const mine = join(trimsDir(), "ses_mine.json");
    writeFileSync(mine, JSON.stringify(emptyState()));
    const twoHoursAgo = (realNow() - 2 * 3_600_000) / 1000;
    utimesSync(mine, twoHoursAgo, twoHoursAgo);
    const { run } = await boot();
    await run(hist("ses_mine", 10));
    expect(existsSync(old)).toBe(false);
    expect(Date.now() - statSync(mine).mtimeMs).toBeLessThan(60_000);
  });
});

// ---------------------------------------------------------------------------
// C5 parity: the plugin INLINES the planner; it must be the shared module,
// byte for byte, and behave identically on shared fixtures.
// ---------------------------------------------------------------------------

function extractInlinedBlock(): string {
  const src = readSource(PLUGIN_FILE, "utf-8");
  const begin = src.indexOf("// <<maskPlan:begin>>\n");
  const end = src.indexOf("// <<maskPlan:end>>");
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  return src.slice(begin + "// <<maskPlan:begin>>\n".length, end);
}

describe("C5 parity: the inlined planner is src/shared/maskPlan.mjs", () => {
  it("the inlined block is the shared module's body, `export` stripped (no drift)", () => {
    const shared_src = readSource(join(__dirname, "..", "..", "src", "shared", "maskPlan.mjs"), "utf-8");
    const body = shared_src.slice(shared_src.indexOf("export const PLACEHOLDER_ARGS_MAX")).replace(/^export /gm, "");
    expect(extractInlinedBlock()).toBe(body);
  });

  const inlined = () => {
    const js = ts.transpileModule(extractInlinedBlock(), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return new Function(`${js}\nreturn { resolveRates, planRequest, adaptV1, boundaryOf, appliedStats, renderPlaceholder };`)() as typeof shared;
  };
  const strip = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (k === "ref" ? undefined : v)));
  const NOW = 1_100;

  it("resolveRates / adaptV1 / boundaryOf agree", () => {
    const copy = inlined();
    for (const [rec, pt, o] of [
      [{ input: 4, cacheRead: 0.2, cacheWrite: 5, tiers: [{ minPromptTokens: 100, cacheRead: 0.3 }] }, 150, {}],
      [{ input: 1, cacheRead: 0.1 }, 0, {}],
      [{ input: 4, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }, 0, { oneHour: true }],
      [{ input: 4, cacheRead: 0.2, cacheWrite: 5 }, 0, { oneHour: true }],
      [{ input: 4, cacheRead: 0.2, context_over_200k: { cacheRead: 1 } }, 200_001, {}],
    ] as const) {
      expect(copy.resolveRates(rec as any, pt, o as any)).toEqual(shared.resolveRates(rec as any, pt, o as any));
    }
    const ms = toV1(calls(12), { sessionID: "s" });
    expect(strip(copy.adaptV1(ms).units)).toEqual(strip(shared.adaptV1(ms).units));
    expect(copy.boundaryOf(copy.adaptV1(ms))).toEqual(shared.boundaryOf(shared.adaptV1(ms)));
  });

  it("planRequest agrees on a spread of states, boundaries, policies and prices", () => {
    const copy = inlined();
    const scenarios: Array<Record<string, any>> = [];
    for (const n of [30, 60, 100]) {
      const ms = toV1(calls(n));
      for (const policy of [POLICY, { ...POLICY, enabled: false }, { ...POLICY, margin: 100 }]) {
        for (const authoritative of [true, false]) {
          for (const rate of [ratesOf(PRICE_OPUS), ratesOf(PRICE_NO_PREMIUM), null]) {
            for (const boundary of [boundaryV1(ms.slice(0, -1)), null, { messageCount: 500, lastMessageKey: "gone" }]) {
              for (const now of [NOW, 1_000 + 400_000]) {
                scenarios.push({ ms, policy, authoritative, rate, boundary, now });
              }
            }
          }
        }
      }
    }
    const states = [
      emptyState({ reqCount: 3 }),
      emptyState({ reqCount: 3, lastModel: "openai/x" }),
      emptyState({ reqCount: 3, real: { call_1: "[manta: trimmed — a]", call_5: "[manta: trimmed — b]", ghost: "[manta: trimmed]" } }),
      emptyState({ reqCount: 3, nextGrowthAllowedAt: 50, shadow: { call_2: "[manta: trimmed — c]" } }),
    ];
    let checked = 0;
    for (const s of scenarios) {
      for (const state of states) {
        const run = (mod: typeof shared) => {
          const adapted = mod.adaptV1(s.ms);
          return strip(
            mod.planRequest({
              messages: adapted,
              policy: s.policy,
              authoritative: s.authoritative,
              rates: s.rate,
              state,
              boundary: s.boundary,
              model: { providerID: PROVIDER, modelID: MODEL },
              now: () => s.now,
              lastCompletedMs: adapted.lastCompletedMs,
            }),
          );
        };
        expect(run(copy)).toEqual(run(shared));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
