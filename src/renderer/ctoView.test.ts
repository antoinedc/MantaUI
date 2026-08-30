import { describe, it, expect, vi } from "vitest";
import {
  dotTone,
  badgeLabel,
  digestBusy,
  statDisplay,
  showPausedBanner,
  backfillCardView,
  formatEta,
  relativeTime,
  blockerTarget,
  probeSecretKey,
  finishedVariant,
  digestTone,
  digestExpandable,
  resting,
  stateTone,
  nowCostLabel,
  nowRailMeta,
  type CtoState,
  type CtoHealthStat,
} from "./ctoView";

const base: CtoState = {
  enabled: true,
  dot: "active",
  pausedAt: null,
  needsYouCount: 0,
  generationInFlight: false,
  tonightCount: 0,
};

describe("dotTone (§10.1 state dot)", () => {
  it("maps active → ok", () => {
    expect(dotTone("active")).toBe("ok");
  });
  it("maps thrifty → warn", () => {
    expect(dotTone("thrifty")).toBe("warn");
  });
  it("maps paused → danger (error)", () => {
    expect(dotTone("paused")).toBe("error");
  });
  it("maps disabled → idle (tx4 grey)", () => {
    expect(dotTone("disabled")).toBe("idle");
  });
  it("defaults an unknown/undefined dot to idle", () => {
    expect(dotTone(undefined)).toBe("idle");
  });
});

describe("badgeLabel (§10.1 needs-you badge)", () => {
  it("hides at zero", () => {
    expect(badgeLabel(base)).toBeNull();
  });
  it("shows the count when open needs-you items exist", () => {
    expect(badgeLabel({ ...base, needsYouCount: 3 })).toBe(3);
  });
  it("treats a null state as zero (hidden)", () => {
    expect(badgeLabel(null)).toBeNull();
  });
  it("never shows zero even when the count is negative", () => {
    expect(badgeLabel({ ...base, needsYouCount: -1 })).toBeNull();
  });
});

describe("digestBusy (§10.2 Digest-now single-flight spinner)", () => {
  it("is idle when the server is not generating", () => {
    expect(digestBusy(base)).toBe(false);
  });
  it("is busy while the server generation is in flight", () => {
    expect(digestBusy({ ...base, generationInFlight: true })).toBe(true);
  });
  it("treats null state as idle", () => {
    expect(digestBusy(null)).toBe(false);
  });
});

describe("statDisplay (§10.5 stat min-sample collecting)", () => {
  const stat = (over: Partial<CtoHealthStat>): CtoHealthStat => ({
    id: "digestOpens",
    label: "Digest opens · 7d",
    value: null,
    n: 0,
    min: 7,
    ...over,
  });

  it("renders collecting (n/k) below the minimum sample size", () => {
    const out = statDisplay(stat({ n: 3, value: "$0.42 of $2.50 / day" }));
    expect(out.ready).toBe(false);
    expect(out.text).toBe("collecting (3 / 7)");
  });

  it("renders the value once the minimum sample size is reached", () => {
    const out = statDisplay(stat({ n: 7, value: "7 opens · median 09:00" }));
    expect(out.ready).toBe(true);
    expect(out.text).toBe("7 opens · median 09:00");
  });

  it("never shows a value for a stat with a sample count but no value", () => {
    const out = statDisplay(stat({ n: 10, value: null }));
    expect(out.ready).toBe(false);
    expect(out.text).toBe("collecting (10 / 7)");
  });

  it("tolerates a malformed/missing stat row", () => {
    const out = statDisplay(undefined as unknown as CtoHealthStat);
    expect(out.ready).toBe(false);
    expect(out.text).toBe("collecting (0 / 0)");
  });
});

describe("showPausedBanner (§10.6-5 kill switch → banner)", () => {
  it("shows the banner exactly when the dot is paused", () => {
    expect(showPausedBanner({ ...base, dot: "paused", pausedAt: 1234 })).toBe(true);
  });
  it("does NOT show it for active / thrifty / disabled states", () => {
    expect(showPausedBanner({ ...base, dot: "active" })).toBe(false);
    expect(showPausedBanner({ ...base, dot: "thrifty" })).toBe(false);
    expect(showPausedBanner({ ...base, dot: "disabled" })).toBe(false);
  });
  it("treats a null / not-yet-loaded state as not paused", () => {
    expect(showPausedBanner(null)).toBe(false);
  });
  it("carries the paused-at timestamp through the state", () => {
    const s = { ...base, dot: "paused" as const, pausedAt: 1_700_000_000_000 };
    expect(showPausedBanner(s)).toBe(true);
    expect(s.pausedAt).toBe(1_700_000_000_000);
  });
});

describe("backfillCardView (§10.6-4 learning card)", () => {
  it("renders nothing when there is no backfill field (older bridge)", () => {
    expect(backfillCardView(base)).toBeNull();
  });
  it("shows an active running backfill with pct + ETA", () => {
    // BET-1418: backfillCardView reads Date.now() twice (guard + elapsed), the
    // test reads it once for startedAt — a real ms tick between reads shifted
    // the exact ETA assertion. Freeze the clock so every read sees one instant.
    vi.useFakeTimers();
    try {
      const startedAt = Date.now() - 60_000;
      const view = backfillCardView({
        ...base,
        backfill: { done: 2, total: 10, startedAt, stopped: false, reason: null, stoppedAtDepthDays: null, active: true },
      });
      expect(view?.show).toBe(true);
      expect(view?.done).toBe(2);
      expect(view?.total).toBe(10);
      expect(view?.pct).toBeCloseTo(0.2, 5);
      // 2 items over exactly 60s → rate 30000ms/item, 8 left → exactly 240000ms
      expect(view?.etaMs).toBe(240000);
    } finally {
      vi.useRealTimers();
    }
  });
  it("still shows a budget-stopped backfill with the reason", () => {
    const view = backfillCardView({
      ...base,
      backfill: { done: 5, total: 200, startedAt: null, stopped: true, reason: "budget", stoppedAtDepthDays: 12, active: false },
    });
    expect(view?.show).toBe(true);
    expect(view?.stopped).toBe(true);
    expect(view?.reason).toBe("budget");
    expect(view?.stoppedAtDepthDays).toBe(12);
  });
  it("hides a cleanly completed backfill", () => {
    const view = backfillCardView({
      ...base,
      backfill: { done: 10, total: 10, startedAt: null, stopped: false, reason: null, stoppedAtDepthDays: null, active: false },
    });
    expect(view?.show).toBe(false);
  });
});

describe("formatEta (§10.6-4 ETA label)", () => {
  it("formats minutes", () => {
    expect(formatEta(120_000)).toBe("~2m");
  });
  it("formats hours + minutes", () => {
    expect(formatEta(4_500_000)).toBe("~1h 15m");
  });
  it("returns null for null/zero/NaN", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0)).toBeNull();
    expect(formatEta(NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BET-1385 overview sections (§10.3/§10.4/§10.6)
// ---------------------------------------------------------------------------

const card = (over = {}) => ({
  id: "c1",
  title: "Question waiting",
  body: "which approach?",
  sourceKind: "question",
  sourceId: "ask-1",
  sessionID: "s1",
  pendingSince: 1000,
  refs: [] as string[],
  ...over,
});

describe("relativeTime (§10.3 age stamps / §10.4 relative time)", () => {
  const now = 1_000_000;
  it("shows <1m immediately", () => {
    expect(relativeTime(now - 1000, now)).toBe("<1m");
  });
  it("shows minutes below the hour", () => {
    expect(relativeTime(now - 3 * 60_000, now)).toBe("<3m");
  });
  it("shows hours below the day", () => {
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("<2h");
  });
  it("shows days beyond", () => {
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5d");
  });
  it("never goes negative and handles junk", () => {
    expect(relativeTime(now + 99, now)).toBe("<1m");
    expect(relativeTime(NaN, now)).toBe("");
  });
});

describe("blockerTarget (§10.3 Answer-now routing)", () => {
  it("question source → opens the owning session when it exists", () => {
    expect(blockerTarget(card(), new Set(["s1"]))).toEqual({
      action: "session",
      sessionID: "s1",
    });
  });
  it("question source with a missing session → falls back to the ledger", () => {
    expect(blockerTarget(card(), new Set([]))).toEqual({ action: "ledger" });
  });
  it("permission source sessions behave like questions", () => {
    expect(blockerTarget(card({ sourceKind: "permission" }), new Set(["s1"]))).toEqual({
      action: "session",
      sessionID: "s1",
    });
  });
  it("inbox/health source → ledger fallback (no fix-surface nav in the renderer yet)", () => {
    expect(blockerTarget(card({ sourceKind: "health", refs: ["seg-1"] }), new Set(["s1"]))).toEqual({
      action: "ledger",
    });
  });
  it("inbox/health source without a ref → ledger fallback", () => {
    expect(blockerTarget(card({ sourceKind: "inbox", refs: [] }), new Set(["s1"]))).toEqual({
      action: "ledger",
    });
  });
  it("a null/absent session with an unknown kind → ledger", () => {
    expect(blockerTarget({ ...card(), sessionID: null }, new Set(["s1"]))).toEqual({ action: "ledger" });
  });
  it("probe source → secrets action with the key named in the body (BET-1437)", () => {
    const probe = card({
      sourceKind: "probe",
      sourceId: "github/repo_events",
      sessionID: null,
      body: 'The "repo_events" probe for github failed auth 3 times in a row (HTTP 401/403 or the credential is gone), so the digest\'s view of github is degraded. If the key was rotated, update "GITHUB_PAT" on the secrets surface (⚙ Settings → Secrets).',
    });
    expect(blockerTarget(probe, new Set([]))).toEqual({ action: "secrets", key: "GITHUB_PAT" });
  });
  it("probe source without a named key → secrets action with a null key", () => {
    const probe = card({
      sourceKind: "probe",
      sessionID: null,
      body: 'The "tool_ping" probe for tool failed auth 3 times in a row (HTTP 401/403 or the credential is gone), so the digest\'s view of tool is degraded. Check the tool\'s credential on the secrets surface (⚙ Settings → Secrets).',
    });
    expect(blockerTarget(probe, new Set(["s1"]))).toEqual({ action: "secrets", key: null });
  });
  it("probe key extraction tolerates an absent body", () => {
    const probe = card({ sourceKind: "probe", sessionID: null, body: "" });
    expect(blockerTarget(probe, new Set([]))).toEqual({ action: "secrets", key: null });
  });
  it("a quoted phrase elsewhere in the body is not mistaken for the key", () => {
    expect(probeSecretKey('The "repo_events" probe failed. Check the credential on the secrets surface.')).toBeNull();
  });
});

describe("finishedVariant (§10.4 Just-finished actions)", () => {
  it("turn → open", () => {
    expect(finishedVariant({ kind: "turn" })).toEqual({ action: "open" });
  });
  it("done job → none (no branch/PR surface merged yet — no dead button)", () => {
    expect(finishedVariant({ kind: "job", status: "done" })).toEqual({ action: "none" });
  });
  it("failed job → logs (gate-failed detail)", () => {
    expect(finishedVariant({ kind: "job", status: "failed" })).toEqual({ action: "logs" });
  });
});

describe("digestTone / digestExpandable (§10.4 tier chips + deep expander)", () => {
  it("maps blocker-ish tiers to danger", () => {
    expect(digestTone("need")).toBe("danger");
  });
  it("maps progress tiers to ok", () => {
    expect(digestTone("great")).toBe("ok");
  });
  it("maps plan/tonight to warn", () => {
    expect(digestTone("tonight")).toBe("warn");
  });
  it("maps awareness tiers to info", () => {
    expect(digestTone("aware")).toBe("info");
  });
  it("defaults unknown/empty to idle", () => {
    expect(digestTone("")).toBe("idle");
    expect(digestTone(undefined)).toBe("idle");
  });
  it("is expandable only when deep is a non-blank string", () => {
    expect(digestExpandable({ deep: "all the detail" })).toBe(true);
    expect(digestExpandable({ deep: "  " })).toBe(false);
    expect(digestExpandable({})).toBe(false);
    expect(digestExpandable(null)).toBe(false);
  });
});

describe("resting (§10.6-1 Nothing needs you state)", () => {
  it("is resting when everything is empty", () => {
    expect(resting()).toBe(true);
  });
  it("is NOT resting when a blocker card exists", () => {
    expect(resting({ cards: [card()] })).toBe(false);
  });
  it("is NOT resting when the Now rail has sessions", () => {
    expect(resting({ nowActive: [{ id: "x" }] })).toBe(false);
  });
  it("is NOT resting when the finished rail has entries", () => {
    expect(resting({ finished: [{ id: "y" }] })).toBe(false);
  });
  it("is NOT resting when the digest has items", () => {
    expect(resting({ digestHasItems: true })).toBe(false);
  });
  it("null rails are treated as empty", () => {
    expect(resting({ cards: null, nowActive: null, finished: null, digestHasItems: false })).toBe(true);
  });
});

describe("stateTone (§10.4 Now blocked chip)", () => {
  it("blocked → warn", () => {
    expect(stateTone("blocked")).toBe("warn");
  });
  it("working → ok", () => {
    expect(stateTone("working")).toBe("ok");
  });
});

describe("nowCostLabel (§10.4 Now cost format)", () => {
  it("formats a positive cost to two decimals", () => {
    expect(nowCostLabel(1.5)).toBe("$1.50");
    expect(nowCostLabel(0.42)).toBe("$0.42");
    expect(nowCostLabel(12)).toBe("$12.00");
  });
  it("returns null when absent", () => {
    expect(nowCostLabel(undefined)).toBeNull();
    expect(nowCostLabel(null)).toBeNull();
  });
  it("returns null for zero or NaN", () => {
    expect(nowCostLabel(0)).toBeNull();
    expect(nowCostLabel(Number.NaN)).toBeNull();
  });
});

describe("nowRailMeta (§10.4 project · cost · elapsed)", () => {
  it("places cost between project and elapsed", () => {
    expect(nowRailMeta("bui", "$1.50", "5m")).toBe("bui · $1.50 · 5m");
  });
  it("drops the cost segment when absent (no double separator)", () => {
    expect(nowRailMeta("bui", null, "5m")).toBe("bui · 5m");
    expect(nowRailMeta("bui", null, null)).toBe("bui");
  });
  it("drops empty-string segments", () => {
    expect(nowRailMeta("bui", "", "5m")).toBe("bui · 5m");
  });
});

// ---------------------------------------------------------------------------
// BET-1392 — decision cards + silence audit (§9.1)
// ---------------------------------------------------------------------------

import {
  decisionCards,
  executeSuggestionOption,
  runnableSuggestionOption,
  suggestionConfidence,
  vetoCards,
  countdownRemaining,
  tonightVisible,
} from "./ctoView";

it("decisionCards: selects decision-variant cards only", () => {
  const cards = [
    { id: "b1", variant: "blocker", title: "blk" },
    { id: "d1", variant: "decision", title: "dec", options: [] },
    { id: "c1", variant: "connect", title: "con" },
  ];
  const out = decisionCards(cards as unknown as Record<string, unknown>[]);
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("d1");
});

it("runnableSuggestionOption: BET-1419 runs config-change/start-job/record-decision/queue-tonight; not tool-write", () => {
  expect(runnableSuggestionOption({ action: { type: "config-change" } })).toBe(true);
  expect(runnableSuggestionOption({ action: { type: "start-job" } })).toBe(true);
  expect(runnableSuggestionOption({ action: { type: "record-decision" } })).toBe(true);
  expect(runnableSuggestionOption({ action: { type: "queue-tonight" } })).toBe(true);
  expect(runnableSuggestionOption({ action: { type: "tool-write" } })).toBe(false);
  expect(runnableSuggestionOption(null)).toBe(false);
  expect(runnableSuggestionOption({ action: { type: "bogus" } })).toBe(false);
});

it("suggestionConfidence: exposes the worthiness probability or null", () => {
  const card = { id: "x", variant: "decision", title: "t" } as const;
  expect(suggestionConfidence({ ...card, score: 0.7 })).toBe(0.7);
  expect(suggestionConfidence({ ...card, score: NaN })).toBeNull();
  expect(suggestionConfidence(card)).toBeNull();
});

it("executeSuggestionOption: config-change calls configUpdate with the patch", async () => {
  let got: unknown = null;
  const api = { configUpdate: async (p: unknown) => { got = p; return {}; } };
  const r = await executeSuggestionOption({
    option: { action: { type: "config-change", payload: { patch: { ctoTier: "high" } } } },
    api: api as never,
  });
  expect(r.ok).toBe(true);
  expect(got).toEqual({ ctoTier: "high" });
});

it("executeSuggestionOption: start-job calls delegateStart with prompt/sessionID/directory", async () => {
  let got: unknown = null;
  const api = { delegateStart: async (input: unknown) => { got = input; return { ok: true }; } };
  const r = await executeSuggestionOption({
    option: { action: { type: "start-job", payload: { prompt: "investigate", sessionID: "s1", directory: "/work" } } },
    api: api as never,
  });
  expect(r.ok).toBe(true);
  expect(got).toEqual({ prompt: "investigate", sessionID: "s1", directory: "/work" });
});

it("executeSuggestionOption: start-job without a target fails closed", async () => {
  const api = { delegateStart: async () => ({ ok: true }) } as never;
  const r = await executeSuggestionOption({ option: { action: { type: "start-job", payload: { prompt: "p" } } }, api });
  expect(r.ok).toBe(false);
  expect(r.error ?? "").toMatch(/sessionID/);
});

it("executeSuggestionOption: record-decision posts a decision fact", async () => {
  let got: unknown = null;
  const api = { ctoFact: async (input: unknown) => { got = input; return { ok: true }; } };
  const r = await executeSuggestionOption({
    option: { action: { type: "record-decision", payload: { statement: "Ship it", refs: ["BET-1"] } } },
    api: api as never,
  });
  expect(r.ok).toBe(true);
  expect(got).toEqual({ kind: "decision", statement: "Ship it", refs: ["BET-1"] });
});

it("executeSuggestionOption: non-runnable type fails closed", async () => {
  const api = { configUpdate: async () => ({}) } as never;
  const r = await executeSuggestionOption({ option: { action: { type: "tool-write", payload: {} } }, api });
  expect(r.ok).toBe(false);
  expect(r.error ?? "").toMatch(/unsupported/);
});

it("executeSuggestionOption: queue-tonight queues the task with the card's context (BET-1419)", async () => {
  let got: unknown = null;
  const api = { ctoTonightAct: async (input: unknown) => { got = input; return { ok: true }; } };
  const r = await executeSuggestionOption({
    option: {
      label: "Queue: reconcile ledger",
      action: { type: "queue-tonight", payload: { name: "Reconcile ledger", prompt: "do it", refs: ["BET-9"] } },
    },
    api: api as never,
  });
  expect(r.ok).toBe(true);
  expect(got).toEqual({
    action: "add",
    task: {
      name: "Reconcile ledger",
      prompt: "do it",
      project: null,
      value: undefined,
      confidence: undefined,
      predictedCost: undefined,
      refs: ["BET-9"],
      cls: "queue-tonight",
    },
  });
});

it("executeSuggestionOption: queue-tonight falls back to the label and fails closed without a name", async () => {
  let got: unknown = null;
  const api = { ctoTonightAct: async (input: unknown) => { got = input; return { ok: true }; } };
  const r = await executeSuggestionOption({
    option: { label: "Queue the sweep", action: { type: "queue-tonight", payload: {} } },
    api: api as never,
  });
  expect(r.ok).toBe(true);
  expect((got as { task: { name: string } }).task.name).toBe("Queue the sweep");

  const r2 = await executeSuggestionOption({
    option: { label: "", action: { type: "queue-tonight", payload: {} } },
    api: api as never,
  });
  expect(r2.ok).toBe(false);
  expect(r2.error ?? "").toMatch(/name/);
});

it("vetoCards: selects veto-variant cards with the countdown fields", () => {
  const cards = [
    { id: "b1", variant: "blocker", title: "blk" },
    { id: "overnight:veto", variant: "veto", title: "Overnight run planned", body: "3 tasks", dueMs: 5000, options: [{ label: "Cancel tonight", action: { type: "veto-cancel", payload: {} } }] },
  ];
  const out = vetoCards(cards as unknown as ReadonlyArray<Record<string, unknown>>);
  expect(out.length).toBe(1);
  expect(out[0].id).toBe("overnight:veto");
  expect(out[0].dueMs).toBe(5000);
  expect(out[0].options[0].action.type).toBe("veto-cancel");
});

it("countdownRemaining: ms left, null once due or without a dueMs", () => {
  expect(countdownRemaining(10_000, 4_000)).toBe(6_000);
  expect(countdownRemaining(4_000, 4_000)).toBeNull();
  expect(countdownRemaining(3_000, 4_000)).toBeNull();
  expect(countdownRemaining(null, 4_000)).toBeNull();
  expect(countdownRemaining(Number.NaN, 4_000)).toBeNull();
});

it("tonightVisible: hidden when zero or tier below high", () => {
  expect(tonightVisible(0, "high")).toBe(false);
  expect(tonightVisible(3, "high")).toBe(true);
  expect(tonightVisible(3, "medium")).toBe(false);
  expect(tonightVisible(3, undefined)).toBe(false);
  expect(tonightVisible(undefined, "high")).toBe(false);
});

it("executeSuggestionOption: failure is reported (not swallowed)", async () => {
  const api = { configUpdate: async () => { throw new Error("boom"); } } as never;
  const r = await executeSuggestionOption({ option: { action: { type: "config-change", payload: { patch: {} } } }, api });
  expect(r.ok).toBe(false);
  expect(r.error ?? "").toMatch(/boom/);
});

// --- BET-1405: Tonight's-budget card selectors (§10.5 card 3) --------------

import {
  tonightBudgetMode,
  nightGauge,
  budgetTodayUsd,
  bindingReserveFrac,
  providerWindowNotes,
  forecastAccuracyRows,
} from "./ctoView";

describe("tonightBudgetMode", () => {
  it("is full only at High with Overnight on", () => {
    expect(tonightBudgetMode({ tier: "high", overnightOn: true })).toBe("full");
    expect(tonightBudgetMode({ tier: "high", overnightOn: false })).toBe("ambient");
    expect(tonightBudgetMode({ tier: "medium", overnightOn: true })).toBe("ambient");
    expect(tonightBudgetMode({ tier: "low", overnightOn: true })).toBe("ambient");
    expect(tonightBudgetMode(null)).toBe("ambient");
    expect(tonightBudgetMode({ tier: null, overnightOn: true })).toBe("ambient");
  });
});

describe("nightGauge", () => {
  it("clamps segments into the pool and places the reserve line", () => {
    const g = nightGauge({ nightCapUsd: 5, usedTodayUsd: 1.5, plannedTonightUsd: 2, reserveFrac: 0.95 });
    expect(g.poolUsd).toBe(5);
    expect(g.usedUsd).toBe(1.5);
    expect(g.plannedUsd).toBe(2);
    expect(g.reserveLineUsd).toBeCloseTo(4.75);
    expect(g.overflow).toBe(false);
  });

  it("flags overflow instead of silently truncating", () => {
    const g = nightGauge({ nightCapUsd: 5, usedTodayUsd: 4.5, plannedTonightUsd: 2, reserveFrac: null });
    expect(g.overflow).toBe(true);
    expect(g.usedUsd).toBe(4.5);
    expect(g.plannedUsd).toBe(0.5); // clamped to what remains
  });

  it("handles a zero pool and absent inputs honestly", () => {
    const g = nightGauge({ nightCapUsd: 0, usedTodayUsd: 3, plannedTonightUsd: null, reserveFrac: null });
    expect(g.poolUsd).toBe(0);
    expect(g.usedUsd).toBe(0);
    expect(g.reserveLineUsd).toBe(null);
    expect(g.overflow).toBe(true);
  });
});

describe("budgetTodayUsd", () => {
  it("reads today's local-midnight bucket", () => {
    const d = new Date(2026, 7, 28, 15, 30);
    const key = String(new Date(2026, 7, 28).getTime());
    expect(
      budgetTodayUsd({ days: { [key]: { usd: 1.25 } } }, d.getTime()),
    ).toBe(1.25);
    expect(budgetTodayUsd({ days: {} }, d.getTime())).toBe(0);
    expect(budgetTodayUsd(null, d.getTime())).toBe(0);
  });
});

describe("bindingReserveFrac", () => {
  it("takes the largest windowed reserve and ignores windowless rows", () => {
    expect(
      bindingReserveFrac({
        a: { provider: "a", mode: "forecast", reserve: 0.9 },
        b: { provider: "b", mode: "forecast", reserve: 0.99 },
        c: { provider: "c", mode: "windowless", reserve: 1.5 },
      }),
    ).toBe(0.99);
    expect(bindingReserveFrac({ c: { provider: "c", mode: "windowless", reserve: 1.5 } })).toBe(null);
    expect(bindingReserveFrac(null)).toBe(null);
  });
});

describe("providerWindowNotes", () => {
  it("flattens windows with labels and resets, capped", () => {
    const notes = providerWindowNotes(
      [
        { provider: "claude", windows: [{ kind: "session", label: "5h", resetsAt: 123 }, { kind: "weekly", label: "7d" }] },
        { provider: "kimi", windows: null },
        { provider: "", windows: [{ label: "x" }] },
      ],
      2,
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toEqual({ provider: "claude", label: "5h", resetsAt: 123 });
    expect(notes[1]).toEqual({ provider: "claude", label: "7d", resetsAt: null });
  });
});

describe("forecastAccuracyRows", () => {
  it("emits only providers with a numeric MAPE", () => {
    expect(
      forecastAccuracyRows({
        a: { provider: "a", mape14: 0.23 },
        b: { provider: "b", mape14: null },
        c: { provider: "c" },
      }),
    ).toEqual([{ provider: "a", mape14: 0.23 }]);
    expect(forecastAccuracyRows(null)).toEqual([]);
  });
});
