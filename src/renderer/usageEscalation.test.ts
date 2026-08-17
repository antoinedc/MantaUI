import { describe, it, expect } from "vitest";
import {
  usageAlertLevel,
  buildUsageLevels,
  shouldFireUsageAlert,
  shouldWarnStaleCache,
  buildWarnMessage,
  buildLimitMessage,
} from "./usageEscalation";
import { formatResetDistance } from "./chatUtils";
import type { UsageSnapshot } from "../shared/types";

function snap(
  provider: string,
  windows: Array<{ kind: string; label: string; pct: number; resetsAt?: number; stale?: boolean }>,
): UsageSnapshot {
  return {
    provider,
    providerIDs: [provider],
    fetchedAt: 0,
    windows: windows.map((w) => {
      const base = { kind: w.kind, label: w.label, pct: w.pct, resetsAt: w.resetsAt };
      return w.stale ? { ...base, stale: true } : base;
    }),
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

  it("fires nothing for a stale window even at 100%", () => {
    const prev = buildUsageLevels([snap("claude", [{ kind: "session", label: "S", pct: 40 }])]);
    const stale = [snap("claude", [{ kind: "session", label: "S", pct: 100, stale: true }])];
    expect(shouldFireUsageAlert(prev, stale)).toHaveLength(0);
  });

  it("never fires or re-arms across a stale boundary (100 → stale 100 → 0 → 100)", () => {
    let prev: Record<string, ReturnType<typeof usageAlertLevel>> = {};
    const atLimit = [snap("claude", [{ kind: "session", label: "S", pct: 100 }])];

    let fired = shouldFireUsageAlert(prev, atLimit);
    expect(fired).toHaveLength(1);
    expect(fired[0].level).toBe("limit");
    prev = buildUsageLevels(atLimit); // { "claude:session": "limit" }

    const stale = [snap("claude", [{ kind: "session", label: "S", pct: 100, stale: true }])];
    expect(shouldFireUsageAlert(prev, stale)).toHaveLength(0);
    prev = buildUsageLevels(stale);
    expect(prev["claude:session"]).toBe("limit");

    const reset = [snap("claude", [{ kind: "session", label: "S", pct: 0 }])];
    expect(shouldFireUsageAlert(prev, reset)).toHaveLength(0);
    prev = buildUsageLevels(reset);
    expect(prev["claude:session"]).toBe("none");

    fired = shouldFireUsageAlert(prev, atLimit);
    expect(fired).toHaveLength(1);
    expect(fired[0].level).toBe("limit");
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

describe("reset boundary", () => {
  const snap = (pct: number, resetsAt: number, stale?: boolean) =>
    [
      {
        provider: "claude",
        providerIDs: ["anthropic"],
        fetchedAt: 0,
        windows: [
          {
            kind: "session",
            label: "Session (5h)",
            pct,
            resetsAt,
            ...(stale ? { stale: true } : {}),
          },
        ],
      },
    ] as any;

  it("app open across the boundary stays silent", () => {
    let prev = buildUsageLevels(snap(100, 2000));
    expect(shouldFireUsageAlert(prev, snap(100, 2000, true))).toEqual([]);
    prev = buildUsageLevels(snap(100, 2000, true));
    expect(shouldFireUsageAlert(prev, snap(100, 20000))).toEqual([]);
  });

  it("REGRESSION: cold start during the stale window, counts still high, stays silent", () => {
    // The rolling 5h window does not drop to zero at its reset instant, so this
    // is the ordinary case, not a corner case. Before the fix this fired "limit".
    const prev = buildUsageLevels(snap(100, 2000, true));
    expect(shouldFireUsageAlert(prev, snap(100, 20000))).toEqual([]);
  });

  it("cold start during the stale window, counts truly reset, stays silent", () => {
    const prev = buildUsageLevels(snap(100, 2000, true));
    expect(shouldFireUsageAlert(prev, snap(2, 20000))).toEqual([]);
  });

  it("still re-arms: after a real reset a later climb fires exactly once", () => {
    let prev = buildUsageLevels(snap(100, 2000));
    prev = buildUsageLevels(snap(2, 20000));
    expect(shouldFireUsageAlert(prev, snap(100, 20000)).map((x) => x.level)).toEqual(["limit"]);
    prev = buildUsageLevels(snap(100, 20000));
    expect(shouldFireUsageAlert(prev, snap(100, 20000))).toEqual([]);
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

describe("message builders", () => {
  // 2026-08-18 06:00 local — same calendar day as RESET, three hours earlier,
  // so formatWindowReset yields a pure relative distance ("resets in 3h").
  const NOW = new Date(2026, 7, 18, 6, 0, 0).getTime();

  it("buildWarnMessage carries the formatWindowReset distance (shape, not a literal clock)", () => {
    const msg = buildWarnMessage("Claude", "Session (5h)", 93, RESET, NOW);
    expect(msg).toMatch(/^Claude Session \(5h\) 93% used — resets in /);
    expect(msg).toContain(formatResetDistance(RESET - NOW));
  });

  it("buildLimitMessage carries the formatWindowReset distance (shape, not a literal clock)", () => {
    const msg = buildLimitMessage("Claude", "Weekly", RESET, NOW);
    expect(msg).toMatch(/^Weekly limit reached on Claude — resets in /);
    expect(msg).toContain(formatResetDistance(RESET - NOW));
  });

  it("message builders omit the resets clause when resetsAt is missing", () => {
    expect(buildWarnMessage("Claude", "Session (5h)", 93, undefined, NOW)).toBe("Claude Session (5h) 93% used.");
    expect(buildLimitMessage("Claude", "Weekly", undefined, NOW)).toBe("Weekly limit reached on Claude.");
  });
});
