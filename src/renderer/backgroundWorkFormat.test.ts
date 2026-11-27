import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BudgetPaused, BudgetPlanStatus, BudgetStatus, BudgetWindow } from "../shared/api";
import {
  runWhenBusyHelp,
  batchPausedCopy,
  fallbackText,
  formatElapsed,
  formatPct,
  formatResumes,
  formatUsd,
  formatUsdShort,
  isBudgetStatus,
  isWeeklyKind,
  isWeeklyWindow,
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
  AGENT_WORK_TYPES,
  waitingBatchText,
  workTypeLabel,
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
  windowStart: null,
  spanMs: null,
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
  windowStart: null,
  spanMs: null,
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
  runWhenBusy: false,
  dailyCapUsd: 5,
  payg: { providers: [], usdToday: 0, usdMonth: 0 },
  plans: [plan()],
  waitingBatch: [],
  byWork: [],
  ...over,
});
const ctx = (p?: BudgetPlanStatus, subject?: string) => ({ plan: p ?? plan(), dailyCapUsd: 5, now: NOW, fmt: FMT, subject });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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
  it("weekly-window: by kind or by a window of two days or more", () => {
    expect(isWeeklyWindow({ kind: "weekly", spanMs: null })).toBe(true);
    expect(isWeeklyWindow({ kind: "session", spanMs: null })).toBe(false);
    expect(isWeeklyWindow({ kind: "session", spanMs: 5 * HOUR })).toBe(false);
    expect(isWeeklyWindow({ kind: "session", spanMs: 7 * DAY })).toBe(true);
    expect(isWeeklyWindow({ kind: "session", spanMs: 2 * DAY })).toBe(true);
  });
  it("plan names", () => {
    expect(planName({ adapter: "claude" })).toBe("Claude");
    expect(planName({ adapter: "codex" })).toBe("ChatGPT");
    expect(planName({ adapter: "kimi" })).toBe("Kimi");
    expect(planName({ adapter: "zed" })).toBe("Zed");
    expect(planName({ adapter: "claude", planLabel: "Claude Max" })).toBe("Claude Max");
  });
});

describe("formatElapsed", () => {
  it("half days from a day on, hours under a day", () => {
    expect(formatElapsed(30 * 60_000)).toBe("under an hour");
    expect(formatElapsed(HOUR)).toBe("1 hour");
    expect(formatElapsed(5 * HOUR + 10 * 60_000)).toBe("5 hours");
    expect(formatElapsed(DAY)).toBe("1 day");
    expect(formatElapsed(1.5 * DAY)).toBe("1½ days");
    expect(formatElapsed(2.4 * DAY)).toBe("2½ days");
    expect(formatElapsed(2.2 * DAY)).toBe("2 days");
    expect(formatElapsed(5.9 * DAY)).toBe("6 days");
    expect(formatElapsed(23.8 * HOUR)).toBe("1 day");
  });
  it("is empty for nonsense", () => {
    expect(formatElapsed(-1)).toBe("");
    expect(formatElapsed(Number.NaN)).toBe("");
  });
});

// The owner's 2026-11-17 case: 47% of the Claude week used 2½ days in, on pace for 132%.
const busyWeek = (over: Partial<BudgetWindow> = {}) =>
  week({ pct: 47, projectedPct: 132, resetsAt: at(21, 8), windowStart: NOW - 2.5 * DAY, spanMs: 7 * DAY, ...over });

describe("pausedCopy — every reason, with a subject", () => {
  it("projected-high: what is waiting, why, the figure, and both resume times", () => {
    const c = ctx(plan({ windows: [busyWeek(), session()] }), "Knowledge");
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly", value: 132, resumesAt: at(19, 10, 40) }), c)).toBe(
      "Knowledge is waiting so it doesn't use up your Claude week: you've used 47% in 2½ days, on pace for more than the whole week. " +
        "It resumes Thu 10:40 if your usage slows, or Sat 08:00 when the week resets.",
    );
  });
  it("projected-high that ends below 100% says where it ends", () => {
    const c = ctx(plan({ windows: [busyWeek({ projectedPct: 86 })] }), "The CTO");
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly", value: 86, resumesAt: at(19, 10, 40) }), c)).toBe(
      "The CTO is waiting so it doesn't use up your Claude week: you've used 47% in 2½ days, on pace to end at 86%. " +
        "It resumes Thu 10:40 if your usage slows, or Sat 08:00 when the week resets.",
    );
  });
  it("projected-high near the reset (no earlier resume) just says when the week resets", () => {
    const c = ctx(plan({ windows: [busyWeek()] }), "Knowledge");
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly", value: 132, resumesAt: at(21, 8) }), c)).toBe(
      "Knowledge is waiting so it doesn't use up your Claude week: you've used 47% in 2½ days, on pace for more than the whole week. It resumes Sat 08:00 when the week resets.",
    );
  });
  it("projected-high with no window start still reads, and falls back to the window's projection", () => {
    const c = ctx(plan({ windows: [week({ pct: 47, projectedPct: 91, resetsAt: at(21, 8) })] }), "Knowledge");
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:weekly" }), c)).toBe(
      "Knowledge is waiting so it doesn't use up your Claude week: you've used 47% so far, on pace to end at 91%. It resumes Sat 08:00 when the week resets.",
    );
  });
  it("projected-high on an hours-long window counts hours", () => {
    const c = ctx(plan({ windows: [session({ pct: 60, projectedPct: 140, windowStart: NOW - 3 * HOUR, spanMs: 5 * HOUR })] }), "Knowledge");
    expect(pausedCopy(paused({ reason: "projected-high", windowKey: "claude:session", value: 140, resumesAt: at(17, 14) }), c)).toBe(
      "Knowledge is waiting so it doesn't use up your 5-hour window: you've used 60% in 3 hours, on pace for more than the whole 5-hour window. It resumes at 14:00 when that window resets.",
    );
  });
  it("window-busy, short window", () => {
    expect(pausedCopy(paused({ reason: "window-busy", windowKey: "claude:session", value: 74, resumesAt: at(17, 14) }), ctx(undefined, "Knowledge"))).toBe(
      "Knowledge is waiting while you're using Claude heavily: your 5-hour window is 74% used. It resumes at 14:00 when that window resets.",
    );
  });
  it("window-busy, weekly window", () => {
    expect(pausedCopy(paused({ reason: "window-busy", windowKey: "claude:weekly", value: 74, resumesAt: at(21, 8) }), ctx(undefined, "Knowledge"))).toBe(
      "Knowledge is waiting while you're using Claude heavily: your Claude week is 74% used. It resumes Sat 08:00 when the week resets.",
    );
  });
  it("window-busy without a figure still reads, and the plan is named for the user", () => {
    const codex = plan({ adapter: "codex", windows: [week({ key: "codex:weekly" })] });
    expect(pausedCopy(paused({ reason: "window-busy", windowKey: "codex:weekly", value: undefined }), { plan: codex, dailyCapUsd: 5, now: NOW, fmt: FMT, subject: "The CTO" })).toBe(
      "The CTO is waiting while you're using ChatGPT heavily: your ChatGPT week is 40% used.",
    );
  });
  it("level-cap, weekly and short", () => {
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:weekly", value: 5, resumesAt: at(21, 8) }), ctx(undefined, "Knowledge"))).toBe(
      "Knowledge has used its share of your Claude week (5%). It resumes Sat 08:00 when the week resets.",
    );
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:session", resumesAt: at(17, 14) }), ctx(undefined, "Knowledge"))).toBe(
      "Knowledge has used its share of your 5-hour window (10%). It resumes at 14:00 when that window resets.",
    );
  });
  it("level-cap with no known resume time still reads as a sentence", () => {
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:weekly", value: 5 }), ctx(undefined, "Knowledge"))).toBe(
      "Knowledge has used its share of your Claude week (5%).",
    );
  });
  it("exhausted", () => {
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:weekly", resumesAt: at(21, 8) }), ctx(undefined, "Knowledge"))).toBe(
      "Your Claude week is used up. Knowledge resumes Sat 08:00.",
    );
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:session", resumesAt: at(17, 14) }), ctx(undefined, "The CTO"))).toBe(
      "Your 5-hour window is used up. The CTO resumes at 14:00.",
    );
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:weekly" }), ctx(undefined, "Knowledge"))).toBe(
      "Your Claude week is used up. Knowledge resumes when it resets.",
    );
  });
  it("usd-cap", () => {
    expect(pausedCopy(paused({ reason: "usd-cap", resumesAt: at(18, 0) }), { dailyCapUsd: 5, now: NOW, fmt: FMT, subject: "Knowledge" })).toBe(
      "Knowledge reached today's $5.00 API-key limit. It resumes at midnight.",
    );
    expect(pausedCopy(paused({ reason: "usd-cap" }), { dailyCapUsd: 5, now: NOW, fmt: FMT, subject: "Knowledge" })).toBe("Knowledge reached today's $5.00 API-key limit.");
  });
  it("off ignores the subject: it is off for every plan", () => {
    expect(pausedCopy(paused({ reason: "off" }), ctx(undefined, "Knowledge"))).toBe("Background work is off for your plans.");
    expect(pausedCopy(paused({ reason: "off" }), ctx())).toBe("Background work is off for your plans.");
  });
  it("unavailable", () => {
    expect(pausedCopy(paused({ reason: "unavailable" }), ctx(undefined, "Knowledge"))).toBe("Knowledge is waiting: the budget couldn't be read. It will retry.");
  });
  it("the default subject is Background work, and a plural subject agrees", () => {
    expect(pausedCopy(paused({ reason: "unavailable" }), ctx())).toBe("Background work is waiting: the budget couldn't be read. It will retry.");
    expect(pausedCopy(paused({ reason: "unavailable" }), { ...ctx(), subject: "Larger jobs", plural: true })).toBe(
      "Larger jobs are waiting: the budget couldn't be read. They will retry.",
    );
  });
  it.each(["Knowledge", "The CTO", "Background work"])("every reason names %s (or says it is off for all plans)", (subject) => {
    const reasons = ["level-cap", "window-busy", "projected-high", "exhausted", "usd-cap", "unavailable"] as const;
    for (const reason of reasons) {
      const text = pausedCopy(paused({ reason, windowKey: "claude:weekly", value: 50, resumesAt: at(21, 8) }), ctx(plan({ windows: [busyWeek()] }), subject));
      expect(text, reason).toContain(subject);
      expect(text.endsWith("."), reason).toBe(true);
    }
  });
});

describe("window nouns come from the window's length (spec §6)", () => {
  it("a 7-day window an adapter calls a session is a week; a 5-hour one is a 5-hour window", () => {
    const chatgptWeek = plan({ adapter: "codex", windows: [session({ key: "codex:session", pct: 70, spanMs: 7 * DAY, resetsAt: at(21, 8) })] });
    expect(pausedCopy(paused({ reason: "window-busy", windowKey: "codex:session", value: 70, resumesAt: at(21, 8) }), ctx(chatgptWeek, "Knowledge"))).toBe(
      "Knowledge is waiting while you're using ChatGPT heavily: your ChatGPT week is 70% used. It resumes Sat 08:00 when the week resets.",
    );
    expect(planUsageText(chatgptWeek)).toBe("Background work used 4% of your ChatGPT week");
    const short = plan({ windows: [week({ kind: "weekly", spanMs: 5 * HOUR })] });
    expect(pausedCopy(paused({ reason: "level-cap", windowKey: "claude:weekly", value: 10, resumesAt: at(17, 14) }), ctx(short, "Knowledge"))).toContain("your 5-hour window");
  });
  it("any other length is named from the window's label", () => {
    const odd = plan({ windows: [session({ key: "claude:session", label: "Opus", spanMs: 3 * DAY, kind: "weekly_scoped:opus" })] });
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:session", resumesAt: at(18, 0) }), ctx(odd, "Knowledge"))).toBe(
      "Your Opus window is used up. Knowledge resumes at midnight.",
    );
  });
  it("without a length the kind decides, as before", () => {
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:weekly", resumesAt: at(21, 8) }), ctx(plan({ windows: [week({ spanMs: null })] }), "Knowledge"))).toContain("Your Claude week");
    expect(pausedCopy(paused({ reason: "exhausted", windowKey: "claude:session", resumesAt: at(17, 14) }), ctx(undefined, "Knowledge"))).toContain("Your 5-hour window");
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
    expect(workTypeLabel("knowledge-actions")).toBe("Project action pages");
    expect(waitingBatchText("knowledge-actions")).toBe("Project action pages waiting for a quiet moment");
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
  it("another batch reason is said with Larger jobs as the subject", () => {
    expect(batchPausedCopy(paused({ reason: "unavailable" }), ctx())).toBe("Larger jobs are waiting: the budget couldn't be read. They will retry.");
    expect(batchPausedCopy(paused({ reason: "off" }), ctx())).toBe("Background work is off for your plans.");
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
      "Background work has used its share of your Claude week (5%). It resumes Thu 09:00 when the week resets.",
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
    expect(rows.map((r) => r.text)).toEqual(["Background work reached today's $5.00 API-key limit. It resumes at midnight."]);
  });
  it("nothing to say → no rows", () => {
    expect(statusRows(status({ plans: [] }), NOW, FMT)).toEqual([]);
  });
});

describe("summaryLine", () => {
  it("prefers the first refusal", () => {
    const s = status({ plans: [plan({ paused: paused({ reason: "off" }) })] });
    expect(summaryLine(s, "Knowledge", NOW, FMT)).toEqual({ id: "plan-claude-paused", tone: "warn", text: "Background work is off for your plans." });
  });
  it("speaks for the subject that asks", () => {
    const s = status({ plans: [plan({ paused: paused({ reason: "unavailable" }) })] });
    expect(summaryLine(s, "Knowledge", NOW, FMT)?.text).toBe("Knowledge is waiting: the budget couldn't be read. It will retry.");
    expect(summaryLine(s, "The CTO", NOW, FMT)?.text).toBe("The CTO is waiting: the budget couldn't be read. It will retry.");
    expect(summaryLine(s, undefined, NOW, FMT)?.text).toBe("Background work is waiting: the budget couldn't be read. It will retry.");
  });
  it("API-key refusal when no plan refuses", () => {
    const s = status({ payg: { providers: ["x"], usdToday: 5, usdMonth: 5, paused: paused({ reason: "usd-cap", resumesAt: at(18, 0) }) } });
    expect(summaryLine(s, "Knowledge", NOW, FMT)?.text).toBe("Knowledge reached today's $5.00 API-key limit. It resumes at midnight.");
  });
  it("fallback", () => {
    expect(summaryLine(status({ plans: [plan({ fallback: true })] }), "Knowledge", NOW, FMT)?.text).toContain("usage unavailable");
  });
  it("usage in plan and dollar terms", () => {
    const s = status({ payg: { providers: ["x"], usdToday: 1.2, usdMonth: 9 } });
    expect(summaryLine(s, "Knowledge", NOW, FMT)).toEqual({
      id: "usage",
      tone: "info",
      text: "Background work used 2% of your Claude week · 4% of this 5-hour window · $1.20 of $5.00 today on API keys",
    });
  });
  it("no providers → null", () => {
    expect(summaryLine(status({ plans: [] }), "Knowledge", NOW, FMT)).toBeNull();
  });
});

describe("thriftyReasonText", () => {
  it("names the cap refusal in words", () => {
    const s = status({
      payg: { providers: ["x"], usdToday: 5, usdMonth: 5, paused: paused({ reason: "usd-cap", resumesAt: at(18, 0) }) },
    });
    expect(thriftyReasonText(s, "The CTO", NOW, FMT)).toBe("The CTO reached today's $5.00 API-key limit. It resumes at midnight.");
  });
  it("prefers a cap refusal over another one", () => {
    const s = status({
      plans: [
        plan({ paused: paused({ reason: "window-busy", windowKey: "claude:session", value: 80, resumesAt: at(17, 14) }) }),
        plan({ adapter: "codex", windows: [week({ key: "codex:weekly" })], paused: paused({ reason: "level-cap", windowKey: "codex:weekly", value: 5, resumesAt: at(19, 9) }) }),
      ],
    });
    expect(thriftyReasonText(s, "The CTO", NOW, FMT)).toBe("The CTO has used its share of your ChatGPT week (5%). It resumes Thu 09:00 when the week resets.");
  });
  it("null when nothing refuses or there is no status", () => {
    expect(thriftyReasonText(status(), "The CTO", NOW, FMT)).toBeNull();
    expect(thriftyReasonText(null)).toBeNull();
  });
});

describe("thriftyBannerText", () => {
  const refusing = () => status({ payg: { providers: ["openrouter"], usdToday: 5, usdMonth: 5, paused: { reason: "usd-cap", resumesAt: new Date(2026, 10, 18, 0, 0, 0).getTime() } } });
  const GENERIC = "The CTO is limiting background work to stay inside its budget.";
  it("quotes the budget only for a cap-hit thrifty whose refusal still stands", () => {
    expect(thriftyBannerText("cap_hit", refusing(), "The CTO", NOW, FMT)).toBe(thriftyReasonText(refusing(), "The CTO", NOW, FMT));
    expect(thriftyBannerText("cap_hit", refusing(), "The CTO", NOW, FMT)).toContain("The CTO reached today's $5.00 API-key limit.");
    expect(thriftyBannerText("cap_hit", status(), "The CTO", NOW, FMT)).toBe(GENERIC);
    expect(thriftyBannerText("cap_hit", null, "The CTO", NOW, FMT)).toBe(GENERIC);
  });
  it("is generic for the watchdog, for no reason and for an older box", () => {
    expect(thriftyBannerText("watchdog", refusing(), "The CTO", NOW, FMT)).toBe(GENERIC);
    expect(thriftyBannerText(null, refusing(), "The CTO", NOW, FMT)).toBe(GENERIC);
    expect(thriftyBannerText(undefined, refusing(), "The CTO", NOW, FMT)).toBe(GENERIC);
  });
});

describe("work type lists", () => {
  it("cover exactly the server's work types, each in one subsystem (the list drifts when a type is added there)", () => {
    const src = readFileSync(new URL("../server/backgroundBudget.mjs", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("export const WORK_CLASS"), src.indexOf("export const WORK_TYPES"));
    const serverTypes = [...block.matchAll(/"([a-z-]+)":\s*CLASS\./g)].map((m) => m[1]).sort();
    expect(serverTypes.length).toBeGreaterThan(5);
    expect([...KNOWLEDGE_WORK_TYPES, ...CTO_WORK_TYPES, ...AGENT_WORK_TYPES].sort()).toEqual(serverTypes);
    expect(KNOWLEDGE_WORK_TYPES.filter((t) => CTO_WORK_TYPES.includes(t) || AGENT_WORK_TYPES.includes(t))).toEqual([]);
    expect(CTO_WORK_TYPES.filter((t) => AGENT_WORK_TYPES.includes(t))).toEqual([]);
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

describe("runWhenBusyHelp", () => {
  it("quotes the level's own shares", () => {
    expect(runWhenBusyHelp("light")).toContain("(2% of a week and 5% of a 5-hour window on Light)");
    expect(runWhenBusyHelp("normal")).toContain("(5% of a week and 10% of a 5-hour window on Normal)");
  });
});
