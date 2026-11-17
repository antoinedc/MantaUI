import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BudgetPaused, BudgetPlanStatus, BudgetStatus, BudgetWindow } from "../shared/api";
import {
  batchPausedCopy,
  fallbackText,
  formatPct,
  formatResumes,
  formatUsd,
  formatUsdShort,
  isBudgetStatus,
  isWeeklyKind,
  pausedCopy,
  paygUsageText,
  parseApiKeyCap,
  planName,
  planUsageText,
  shareLine,
  showCapControl,
  showLevelControl,
  statusRows,
  summaryLine,
  thriftyReasonText,
  thriftyBannerText,
  KNOWLEDGE_WORK_TYPES,
  CTO_WORK_TYPES,
  waitingBatchText,
} from "./backgroundWorkFormat";

// Tue 17 Nov 2026 12:00 UTC; every instant below is read back in UTC so the suite doesn't depend on the machine.
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const FMT = { locale: "en-GB", timeZone: "UTC" };
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h, m, 0);

const week = (over: Partial<BudgetWindow> = {}): BudgetWindow => ({
  key: "claude:weekly",
  kind: "weekly",
  label: "Week",
  pct: 40,
  bgPct: 2,
  cap: 5,
  projectedPct: 60,
  resetsAt: at(23, 9),
  ...over,
});
const session = (over: Partial<BudgetWindow> = {}): BudgetWindow => ({
  key: "claude:session",
  kind: "session",
  label: "5-hour",
  pct: 30,
  bgPct: 4,
  cap: 10,
  projectedPct: null,
  resetsAt: at(17, 14),
  ...over,
});
const plan = (over: Partial<BudgetPlanStatus> = {}): BudgetPlanStatus => ({
  adapter: "claude",
  fallback: false,
  windows: [week(), session()],
  paused: null,
  ...over,
});
const status = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  level: "normal",
  dailyCapUsd: 5,
  payg: { providers: [], usdToday: 0, usdMonth: 0 },
  plans: [plan()],
  waitingBatch: [],
  byWork: [],
  ...over,
});
const ctx = (p?: BudgetPlanStatus) => ({ plan: p ?? plan(), dailyCapUsd: 5, now: NOW, fmt: FMT });
const paused = (over: Partial<BudgetPaused>): BudgetPaused => ({ reason: "level-cap", resumesAt: null, ...over });

describe("parseApiKeyCap", () => {
  it("accepts dollars and cents from 0 to 100", () => {
    expect(parseApiKeyCap("5")).toEqual({ ok: true, value: 5 });
    expect(parseApiKeyCap(" $2.50 ")).toEqual({ ok: true, value: 2.5 });
    expect(parseApiKeyCap("0")).toEqual({ ok: true, value: 0 });
    expect(parseApiKeyCap("100")).toEqual({ ok: true, value: 100 });
  });
  it.each(["", " ", "abc", "-1", "1.234", "1,5", "1e3", ".5"])("rejects %j with a sentence", (t) => {
    const r = parseApiKeyCap(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
  });
  it("rejects above 100", () => {
    expect(parseApiKeyCap("100.01")).toEqual({ ok: false, error: "The cap can't be more than $100." });
  });
});

describe("money and percent", () => {
  it("formats", () => {
    expect(formatUsd(5)).toBe("$5.00");
    expect(formatUsd(0.1 + 0.2)).toBe("$0.30");
    expect(formatUsdShort(5)).toBe("$5");
    expect(formatUsdShort(5.5)).toBe("$5.50");
    expect(formatPct(2.4)).toBe("2%");
    expect(formatPct(0.3)).toBe("<1%");
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(null)).toBe("0%");
  });
});

describe("formatResumes (the user's local time)", () => {
  it("today → at HH:MM", () => expect(formatResumes(at(17, 14), NOW, FMT)).toBe("at 14:00"));
  it("a local midnight → at midnight", () => expect(formatResumes(at(18, 0), NOW, FMT)).toBe("at midnight"));
  it("within a week → weekday + time", () => expect(formatResumes(at(19, 9), NOW, FMT)).toBe("Thu 09:00"));
  it("further out → weekday, date and time", () => expect(formatResumes(at(30, 9), NOW, FMT)).toBe("Mon 30 Nov 09:00"));
  it("unknown → empty", () => {
    expect(formatResumes(null, NOW, FMT)).toBe("");
    expect(formatResumes(undefined, NOW, FMT)).toBe("");
  });
  it("honours the time zone", () => {
    expect(formatResumes(at(17, 14), NOW, { locale: "en-GB", timeZone: "Asia/Tokyo" })).toBe("at 23:00");
  });
});

describe("window kinds and names", () => {
  it("weekly-kind", () => {
    expect(isWeeklyKind("weekly")).toBe(true);
    expect(isWeeklyKind("weekly_scoped:opus")).toBe(true);
    expect(isWeeklyKind("session")).toBe(false);
    expect(isWeeklyKind(undefined)).toBe(false);
  });
  it("plan names", () => {
    expect(planName({ adapter: "claude" })).toBe("Claude");
    expect(planName({ adapter: "codex" })).toBe("ChatGPT");
    expect(planName({ adapter: "kimi" })).toBe("Kimi");
    expect(planName({ adapter: "zed" })).toBe("Zed");
    expect(planName({ adapter: "claude", planLabel: "Claude Max" })).toBe("Claude Max");
  });
});

describe("pausedCopy — every reason", () => {
  it("level-cap, weekly", () => {
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:weekly", value: 5, resumesAt: at(19, 9) }), ctx())).toBe(
      "Reached this week's background limit (5%) — resumes Thu 09:00",
    );
  });
  it("level-cap, short window, quoting the window's cap when the box sent no value", () => {
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:session", resumesAt: at(17, 14) }), ctx())).toBe(
      "Reached this 5-hour window's background limit (10%) — resumes at 14:00",
    );
  });
  it("window-busy, short window (§17.21)", () => {
    expect(pausedCopy(paused({ reason: "window-busy", windowKey: "claude:session", value: 74, resumesAt: at(17, 14) }), ctx())).toBe(
      "Paused — your 5-hour window is 74% used. Resumes at 14:00, when it resets.",
    );
  });
  it("window-busy, weekly fallback (§17.21)", () => {
    expect(pausedCopy(paused({ reason: "window-busy", windowKey: "claude:weekly", value: 74, resumesAt: at(19, 9) }), ctx())).toBe(
      "Paused — this week is 74% used. Resumes Thu 09:00, when it resets.",
    );
  });
  it("projected-high says when it resumes if usage stays flat (§17.21)", () => {
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly", value: 86, resumesAt: at(21, 6) }), ctx())).toBe(
      "Paused — this week is on track to end at 86% — resumes around Sat 06:00 if usage stays flat",
    );
  });
  it("projected-high above 100 reads as running out before the reset (§17.21)", () => {
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly", value: 130, resumesAt: at(21, 6) }), ctx())).toBe(
      "Paused — this week is on track to run out before the reset — resumes around Sat 06:00 if usage stays flat",
    );
  });
  it("projected-high falls back to the window's projection", () => {
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly" }), ctx(plan({ windows: [week({ projectedPct: 91 })] })))).toBe(
      "Paused — this week is on track to end at 91%",
    );
  });
  it("exhausted", () => {
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:weekly", resumesAt: at(23, 9) }), ctx())).toBe(
      "Your Claude week is used up — resumes Mon 09:00",
    );
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:session", resumesAt: at(17, 14) }), ctx())).toBe(
      "Your 5-hour window is used up — resumes at 14:00",
    );
  });
  it("off, usd-cap, unavailable", () => {
    expect(pausedCopy(paused({ reason: "off" }), ctx())).toBe("Off on plans");
    expect(pausedCopy(paused({ reason: "usd-cap", resumesAt: at(18, 0) }), { dailyCapUsd: 5, now: NOW, fmt: FMT })).toBe(
      "Reached today's $5.00 API-key cap — resumes at midnight",
    );
    expect(pausedCopy(paused({ reason: "unavailable" }), ctx())).toBe("Background work is waiting — the budget couldn't be read");
  });
  it("a refusal with no known resume time still reads as a sentence", () => {
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:weekly", value: 5 }), ctx())).toBe("Reached this week's background limit (5%)");
  });
});

describe("fallback, waiting batch jobs and batch refusals", () => {
  it("fallback names the plan and the dollar cap", () => {
    expect(fallbackText({ adapter: "claude" }, 5)).toBe("Claude usage unavailable — limited by the $5 daily cap until it returns");
  });
  it("waiting batch job", () => {
    expect(waitingBatchText("knowledge-tidy")).toBe("Weekly tidy waiting for a quiet moment");
    expect(waitingBatchText("cto-overnight")).toBe("Overnight work waiting for a quiet moment");
    expect(waitingBatchText("something-new")).toBe("Something new waiting for a quiet moment");
  });
  it("larger jobs that used their share (§17.20)", () => {
    expect(batchPausedCopy(paused({ reason: "level-cap", windowKey: "claude:weekly", value: 3 }), ctx())).toBe(
      "Larger jobs paused — they've used their share of this week (3%); capture continues.",
    );
    expect(batchPausedCopy(paused({ reason: "usd-cap" }), { dailyCapUsd: 5, now: NOW, fmt: FMT })).toBe(
      "Larger jobs paused — they've used their share of today's API-key cap; capture continues.",
    );
  });
  it("says nothing extra when continuous work is paused for the same reason", () => {
    const p = paused({ reason: "window-busy", windowKey: "claude:session", value: 74 });
    expect(batchPausedCopy(p, ctx(), p)).toBeNull();
  });
  it("another batch reason is quoted with its own words", () => {
    expect(batchPausedCopy(paused({ reason: "off" }), ctx())).toBe("Larger jobs: off on plans");
  });
});

describe("usage text", () => {
  it("plan usage: weekly first, short window after", () => {
    expect(planUsageText(plan({ windows: [session(), week()] }))).toBe("Background work used 2% of your Claude week · 4% of this 5-hour window");
  });
  it("a plan with no windows has no usage line", () => {
    expect(planUsageText(plan({ windows: [] }))).toBeNull();
  });
  it("payg line carries today and the month", () => {
    expect(paygUsageText(status({ payg: { providers: ["openrouter"], usdToday: 1.2, usdMonth: 18.4 } }))).toBe("$1.20 of $5.00 today · $18.40 this month");
  });
});

describe("statusRows", () => {
  it("a plan with usage, a refusal, and a waiting batch job", () => {
    const rows = statusRows(
      status({
        plans: [plan({ paused: paused({ reason: "level-cap", windowKey: "claude:weekly", value: 5, resumesAt: at(19, 9) }) })],
        waitingBatch: [{ workType: "knowledge-tidy", dueSince: NOW - 1000 }],
      }),
      NOW,
      FMT,
    );
    expect(rows.map((r) => r.text)).toEqual([
      "Background work used 2% of your Claude week · 4% of this 5-hour window",
      "Reached this week's background limit (5%) — resumes Thu 09:00",
      "Weekly tidy waiting for a quiet moment",
    ]);
    expect(rows.map((r) => r.tone)).toEqual(["info", "warn", "info"]);
  });
  it("larger jobs that used their share are listed while continuous work still runs; the same refusal is not said twice", () => {
    const batch = paused({ reason: "level-cap", windowKey: "claude:weekly", value: 3 });
    const only = statusRows(status({ plans: [plan({ batchPaused: batch })] }), NOW, FMT);
    expect(only.map((r) => r.text)).toEqual([
      "Background work used 2% of your Claude week · 4% of this 5-hour window",
      "Larger jobs paused — they've used their share of this week (3%); capture continues.",
    ]);
    const both = statusRows(status({ plans: [plan({ paused: batch, batchPaused: batch })] }), NOW, FMT);
    expect(both.filter((r) => r.text.startsWith("Larger jobs"))).toEqual([]);
  });
  it("a plan in fallback says so instead of showing quota usage", () => {
    const rows = statusRows(status({ plans: [plan({ fallback: true })] }), NOW, FMT);
    expect(rows.map((r) => r.text)).toEqual(["Claude usage unavailable — limited by the $5 daily cap until it returns"]);
  });
  it("the API-key refusal", () => {
    const rows = statusRows(
      status({ plans: [], payg: { providers: ["openrouter"], usdToday: 5, usdMonth: 9, paused: paused({ reason: "usd-cap", resumesAt: at(18, 0) }) } }),
      NOW,
      FMT,
    );
    expect(rows.map((r) => r.text)).toEqual(["Reached today's $5.00 API-key cap — resumes at midnight"]);
  });
  it("nothing to say → no rows", () => {
    expect(statusRows(status({ plans: [] }), NOW, FMT)).toEqual([]);
  });
});

describe("summaryLine", () => {
  it("prefers the first refusal", () => {
    const s = status({ plans: [plan({ paused: paused({ reason: "off" }) })] });
    expect(summaryLine(s, NOW, FMT)).toEqual({ id: "plan-claude-paused", tone: "warn", text: "Off on plans" });
  });
  it("API-key refusal when no plan refuses", () => {
    const s = status({ payg: { providers: ["x"], usdToday: 5, usdMonth: 5, paused: paused({ reason: "usd-cap", resumesAt: at(18, 0) }) } });
    expect(summaryLine(s, NOW, FMT)?.text).toBe("Reached today's $5.00 API-key cap — resumes at midnight");
  });
  it("fallback", () => {
    expect(summaryLine(status({ plans: [plan({ fallback: true })] }), NOW, FMT)?.text).toContain("usage unavailable");
  });
  it("usage in plan and dollar terms", () => {
    const s = status({ payg: { providers: ["x"], usdToday: 1.2, usdMonth: 9 } });
    expect(summaryLine(s, NOW, FMT)).toEqual({
      id: "usage",
      tone: "info",
      text: "Background work used 2% of your Claude week · 4% of this 5-hour window · $1.20 of $5.00 today on API keys",
    });
  });
  it("no providers → null", () => {
    expect(summaryLine(status({ plans: [] }), NOW, FMT)).toBeNull();
  });
});

describe("thriftyReasonText", () => {
  it("names the cap refusal in words", () => {
    const s = status({
      payg: { providers: ["x"], usdToday: 5, usdMonth: 5, paused: paused({ reason: "usd-cap", resumesAt: at(18, 0) }) },
    });
    expect(thriftyReasonText(s, NOW, FMT)).toBe("Reached today's $5.00 API-key cap — resumes at midnight");
  });
  it("prefers a cap refusal over another one", () => {
    const s = status({
      plans: [
        plan({ paused: paused({ reason: "window-busy", windowKey: "claude:session", value: 80, resumesAt: at(17, 14) }) }),
        plan({ adapter: "codex", windows: [week({ key: "codex:weekly" })], paused: paused({ reason: "level-cap", windowKey: "codex:weekly", value: 5, resumesAt: at(19, 9) }) }),
      ],
    });
    expect(thriftyReasonText(s, NOW, FMT)).toBe("Reached this week's background limit (5%) — resumes Thu 09:00");
  });
  it("null when nothing refuses or there is no status", () => {
    expect(thriftyReasonText(status(), NOW, FMT)).toBeNull();
    expect(thriftyReasonText(null)).toBeNull();
  });
});

describe("thriftyBannerText", () => {
  const refusing = () => status({ payg: { providers: ["openrouter"], usdToday: 5, usdMonth: 5, paused: { reason: "usd-cap", resumesAt: new Date(2026, 10, 18, 0, 0, 0).getTime() } } });
  const GENERIC = "The CTO is limiting background work to stay inside its budget.";
  it("quotes the budget only for a cap-hit thrifty whose refusal still stands", () => {
    expect(thriftyBannerText("cap_hit", refusing(), NOW, FMT)).toBe(thriftyReasonText(refusing(), NOW, FMT));
    expect(thriftyBannerText("cap_hit", status(), NOW, FMT)).toBe(GENERIC);
    expect(thriftyBannerText("cap_hit", null, NOW, FMT)).toBe(GENERIC);
  });
  it("is generic for the watchdog, for no reason and for an older box", () => {
    expect(thriftyBannerText("watchdog", refusing(), NOW, FMT)).toBe(GENERIC);
    expect(thriftyBannerText(null, refusing(), NOW, FMT)).toBe(GENERIC);
    expect(thriftyBannerText(undefined, refusing(), NOW, FMT)).toBe(GENERIC);
  });
});

describe("work type lists", () => {
  it("cover exactly the server's work types, each in one subsystem (the list drifts when a type is added there)", () => {
    const src = readFileSync(new URL("../server/backgroundBudget.mjs", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("export const WORK_CLASS"), src.indexOf("export const WORK_TYPES"));
    const serverTypes = [...block.matchAll(/"([a-z-]+)":\s*CLASS\./g)].map((m) => m[1]).sort();
    expect(serverTypes.length).toBeGreaterThan(5);
    expect([...KNOWLEDGE_WORK_TYPES, ...CTO_WORK_TYPES].sort()).toEqual(serverTypes);
    expect(KNOWLEDGE_WORK_TYPES.filter((t) => CTO_WORK_TYPES.includes(t))).toEqual([]);
  });
});

describe("shareLine", () => {
  const s = status({
    byWork: [
      { workType: "knowledge-capture", calls: 10, usd: 0.1, tokens: 120_000 },
      { workType: "knowledge-tidy", calls: 1, usd: 0.2, tokens: 80_000 },
      { workType: "cto-ambient", calls: 99, usd: 1, tokens: 9_000_000 },
    ],
  });
  it("sums one subsystem's work types", () => {
    expect(shareLine(s, KNOWLEDGE_WORK_TYPES, "Knowledge work")).toBe("Knowledge work today: 11 calls · 200k tokens");
    expect(shareLine(s, CTO_WORK_TYPES, "CTO work")).toBe("CTO work today: 99 calls · 9000k tokens");
  });
  it("counts the curator and skills work types, which do not carry the knowledge- prefix", () => {
    const k = status({
      byWork: [
        { workType: "curator-notes", calls: 3, usd: 0, tokens: 3000 },
        { workType: "curator-rules", calls: 2, usd: 0, tokens: 2000 },
        { workType: "curator-skills", calls: 1, usd: 0, tokens: 1000 },
        { workType: "knowledge-capture", calls: 4, usd: 0, tokens: 4000 },
      ],
    });
    expect(shareLine(k, KNOWLEDGE_WORK_TYPES, "Knowledge work")).toBe("Knowledge work today: 10 calls · 10k tokens");
    expect(shareLine(k, CTO_WORK_TYPES, "CTO work")).toBeNull();
  });
  it("singular call, and nothing when the subsystem did nothing", () => {
    expect(shareLine(status({ byWork: [{ workType: "cto-ambient", calls: 1, usd: 0, tokens: 500 }] }), CTO_WORK_TYPES, "CTO work")).toBe("CTO work today: 1 call · 500 tokens");
    expect(shareLine(status(), CTO_WORK_TYPES, "CTO work")).toBeNull();
  });
});

describe("visibility rules", () => {
  it("the level control shows only when a plan exists", () => {
    expect(showLevelControl(status())).toBe(true);
    expect(showLevelControl(status({ plans: [] }))).toBe(false);
  });
  it("the cap shows for API-key providers or a plan in fallback", () => {
    expect(showCapControl(status())).toBe(false);
    expect(showCapControl(status({ payg: { providers: ["x"], usdToday: 0, usdMonth: 0 } }))).toBe(true);
    expect(showCapControl(status({ plans: [plan({ fallback: true })] }))).toBe(true);
    expect(showCapControl(status({ plans: [] }))).toBe(false);
  });
});

describe("isBudgetStatus", () => {
  it("accepts a status and rejects anything else", () => {
    expect(isBudgetStatus(status())).toBe(true);
    expect(isBudgetStatus(null)).toBe(false);
    expect(isBudgetStatus(undefined)).toBe(false);
    expect(isBudgetStatus({})).toBe(false);
    expect(isBudgetStatus({ plans: [], payg: {} })).toBe(false);
  });
});
