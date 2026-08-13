import { describe, it, expect } from "vitest";
import {
  usageAlertLevel,
  buildUsageLevels,
  shouldFireUsageAlert,
  shouldWarnStaleCache,
  formatResetClock,
  describeResetDistance,
  buildWarnMessage,
  buildLimitMessage,
} from "./usageEscalation";
import type { UsageSnapshot } from "../shared/types";

function snap(
  provider: string,
  windows: Array<{ kind: string; label: string; pct: number; resetsAt?: number }>,
): UsageSnapshot {
  return {
    provider,
    providerIDs: [provider],
    fetchedAt: 0,
    windows: windows.map((w) => ({ kind: w.kind, label: w.label, pct: w.pct, resetsAt: w.resetsAt })),
  };
}

// Constants so the "resets" clause renders deterministically.
const RESET = new Date(2026, 7, 18, 9, 0, 0).getTime(); // Tue 2026-08-18 09:00

describe("usageAlertLevel", () => {
  it("classifies the three levels with exact 90 and 100 boundaries", () => {
    expect(usageAlertLevel(0)).toBe("none");
    expect(usageAlertLevel(50)).toBe("none");
    expect(usageAlertLevel(89.9)).toBe("none");
    expect(usageAlertLevel(90)).toBe("warn"); // exact 90 → warn
    expect(usageAlertLevel(93)).toBe("warn");
    expect(usageAlertLevel(99)).toBe("warn");
    expect(usageAlertLevel(100)).toBe("limit"); // exact 100 → limit
    expect(usageAlertLevel(101)).toBe("limit");
  });
});

describe("buildUsageLevels", () => {
  it("maps each present provider:window to its current level and drops absent keys", () => {
    const levels = buildUsageLevels([
      snap("claude", [{ kind: "session", label: "S", pct: 95 }, { kind: "weekly", label: "W", pct: 100 }]),
      snap("codex", [{ kind: "session", label: "S", pct: 40 }]),
    ]);
    expect(levels).toEqual({
      "claude:session": "warn",
      "claude:weekly": "limit",
      "codex:session": "none",
    });
  });

  it("returns an empty map for no snapshots", () => {
    expect(buildUsageLevels(null)).toEqual({});
    expect(buildUsageLevels(undefined)).toEqual({});
    expect(buildUsageLevels([])).toEqual({});
  });
});

describe("shouldFireUsageAlert — fire-once semantics", () => {
  it("fires on the transition upward (none → warn) and NOT while the level holds", () => {
    let prev: Record<string, ReturnType<typeof usageAlertLevel>> = {};
    // Cross into warn.
    const step1 = [snap("claude", [{ kind: "session", label: "Session", pct: 93, resetsAt: RESET }])];
    let fired = shouldFireUsageAlert(prev, step1);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ key: "claude:session", level: "warn", provider: "claude" });
    // Subscriber writes the current levels back — the hold case.
    prev = buildUsageLevels(step1);
    fired = shouldFireUsageAlert(prev, step1);
    expect(fired).toHaveLength(0);
  });

  it("escalates warn → limit but does not re-fire at a held limit", () => {
    let prev: Record<string, ReturnType<typeof usageAlertLevel>> = {};
    const atWarn = [snap("claude", [{ kind: "session", label: "Session", pct: 93 }])];
    prev = buildUsageLevels(atWarn);
    const atLimit = [snap("claude", [{ kind: "session", label: "Session", pct: 100, resetsAt: RESET }])];
    let fired = shouldFireUsageAlert(prev, atLimit);
    expect(fired).toHaveLength(1);
    expect(fired[0].level).toBe("limit");
    prev = buildUsageLevels(atLimit);
    fired = shouldFireUsageAlert(prev, atLimit);
    expect(fired).toHaveLength(0);
  });

  it("re-arms after the level drops (the window reset)", () => {
    // At limit, held.
    let prev = buildUsageLevels([snap("claude", [{ kind: "weekly", label: "Weekly", pct: 100 }])]);
    expect(shouldFireUsageAlert(prev, [snap("claude", [{ kind: "weekly", label: "Weekly", pct: 100 }])])).toHaveLength(0);
    // Reset: provider stops reporting the window (or drops pct).
    prev = buildUsageLevels([snap("claude", [{ kind: "weekly", label: "Weekly", pct: 10 }])]);
    const afterReset = [snap("claude", [{ kind: "weekly", label: "Weekly", pct: 12 }])];
    expect(shouldFireUsageAlert(prev, afterReset)).toHaveLength(0);
    // Cross up again → fires once more.
    prev = buildUsageLevels(afterReset);
    const crossing = [snap("claude", [{ kind: "weekly", label: "Weekly", pct: 100, resetsAt: RESET }])];
    const fired = shouldFireUsageAlert(prev, crossing);
    expect(fired).toHaveLength(1);
    expect(fired[0].key).toBe("claude:weekly");
    expect(fired[0].level).toBe("limit");
  });

  it("also re-arms when the window disappears from the snapshot entirely", () => {
    const present = [snap("claude", [{ kind: "weekly", label: "Weekly", pct: 100 }])];
    let prev = buildUsageLevels(present);
    expect(shouldFireUsageAlert(prev, present)).toHaveLength(0);
    // Window gone → prev has no key (buildUsageLevels drops it).
    prev = buildUsageLevels([]);
    const fired = shouldFireUsageAlert(prev, present);
    expect(fired).toHaveLength(1);
  });

  it("tracks two windows of the same provider independently", () => {
    let prev: Record<string, ReturnType<typeof usageAlertLevel>> = {};
    const both = [
      snap("claude", [
        { kind: "session", label: "Session (5h)", pct: 95, resetsAt: RESET },
        { kind: "weekly", label: "Weekly", pct: 30 },
      ]),
    ];
    expect(shouldFireUsageAlert(prev, both)).toHaveLength(1); // only session fires
    prev = buildUsageLevels(both);
    // weekly crosses up now.
    const weeklyUp = [
      snap("claude", [
        { kind: "session", label: "Session (5h)", pct: 95 },
        { kind: "weekly", label: "Weekly", pct: 100, resetsAt: RESET },
      ]),
    ];
    const fired = shouldFireUsageAlert(prev, weeklyUp);
    expect(fired).toHaveLength(1);
    expect(fired[0].key).toBe("claude:weekly");
  });

  it("tracks two providers independently", () => {
    let prev: Record<string, ReturnType<typeof usageAlertLevel>> = {};
    const both = [
      snap("claude", [{ kind: "session", label: "S", pct: 95, resetsAt: RESET }]),
      snap("codex", [{ kind: "session", label: "S", pct: 95, resetsAt: RESET }]),
    ];
    expect(shouldFireUsageAlert(prev, both)).toHaveLength(2);
    prev = buildUsageLevels(both);
    expect(shouldFireUsageAlert(prev, both)).toHaveLength(0);
    // Only claude holds; codex resets (drops to none) and later re-crosses.
    prev = buildUsageLevels([
      snap("claude", [{ kind: "session", label: "S", pct: 95 }]),
      snap("codex", [{ kind: "session", label: "S", pct: 40 }]),
    ]);
    const reCross = [
      snap("claude", [{ kind: "session", label: "S", pct: 95 }]),
      snap("codex", [{ kind: "session", label: "S", pct: 100, resetsAt: RESET }]),
    ];
    const fired = shouldFireUsageAlert(prev, reCross);
    expect(fired).toHaveLength(1);
    expect(fired[0].provider).toBe("codex");
  });
});

describe("shouldWarnStaleCache", () => {
  const now = Date.now();
  it("is true beyond the 5m TTL and false within it", () => {
    expect(shouldWarnStaleCache(now + 6 * 60_000, now, "5m")).toBe(true);
    expect(shouldWarnStaleCache(now + 4 * 60_000, now, "5m")).toBe(false);
    expect(shouldWarnStaleCache(now + 90_000, now, "5m")).toBe(false);
  });

  it("is true beyond the 1h TTL and false within it", () => {
    expect(shouldWarnStaleCache(now + 61 * 60_000, now, "1h")).toBe(true);
    expect(shouldWarnStaleCache(now + 59 * 60_000, now, "1h")).toBe(false);
  });
});

describe("formatResetClock", () => {
  it("renders 12-hour time, optionally with a weekday", () => {
    // 2026-08-18 09:00 local → "Tue 9:00 am" / "9:00 am"
    const d = new Date(2026, 7, 18, 9, 0).getTime();
    expect(formatResetClock(d, true)).toBe("Tue 9:00 am");
    expect(formatResetClock(d, false)).toBe("9:00 am");
  });

  it("renders afternoon times with pm and no leading zero on the hour", () => {
    const d = new Date(2026, 7, 18, 15, 5).getTime();
    expect(formatResetClock(d, false)).toBe("3:05 pm");
  });

  it("returns '' for a missing or invalid timestamp", () => {
    expect(formatResetClock(undefined, false)).toBe("");
    expect(formatResetClock(null, true)).toBe("");
    expect(formatResetClock(Number.NaN, false)).toBe("");
  });
});

describe("message builders", () => {
  it("buildWarnMessage matches the spec copy", () => {
    expect(buildWarnMessage("Claude", "Session (5h)", 93, RESET)).toBe(
      "Claude Session (5h) 93% used — resets " + formatResetClock(RESET, false) + ".",
    );
  });

  it("buildLimitMessage matches the spec copy (weekday form)", () => {
    expect(buildLimitMessage("Claude", "Weekly", RESET)).toBe(
      "Weekly limit reached on Claude — resets " + formatResetClock(RESET, true) + ".",
    );
  });

  it("message builders omit the resets clause when resetsAt is missing", () => {
    expect(buildWarnMessage("Claude", "Session (5h)", 93, undefined)).toBe("Claude Session (5h) 93% used.");
    expect(buildLimitMessage("Claude", "Weekly", undefined)).toBe("Weekly limit reached on Claude.");
  });
});

describe("describeResetDistance", () => {
  it("uses the coarsest whole unit", () => {
    expect(describeResetDistance(4 * 86_400_000)).toBe("4 days");
    expect(describeResetDistance(2 * 3_600_000)).toBe("2 hours");
    expect(describeResetDistance(45 * 60_000)).toBe("45 minutes");
    expect(describeResetDistance(30_000)).toBe("less than a minute");
  });
});
