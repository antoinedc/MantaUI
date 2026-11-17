// A background-work-budget status for renderer tests: one Claude plan with a weekly window, no refusals.
import type { BudgetStatus } from "../shared/api";

export const budgetStatus = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  level: "normal",
  runWhenBusy: false,
  dailyCapUsd: 5,
  payg: { providers: [], usdToday: 0, usdMonth: 0 },
  plans: [
    {
      adapter: "claude",
      fallback: false,
      windows: [{ key: "claude:weekly", kind: "weekly", label: "Week", pct: 40, bgPct: 2, cap: 5, projectedPct: 60, resetsAt: null, windowStart: null, spanMs: null }],
      paused: null,
    },
  ],
  waitingBatch: [],
  byWork: [],
  ...over,
});
