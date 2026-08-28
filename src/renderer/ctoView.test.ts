import { describe, it, expect } from "vitest";
import {
  dotTone,
  badgeLabel,
  digestBusy,
  backfillCardView,
  formatEta,
  type CtoState,
} from "./ctoView";

const base: CtoState = {
  enabled: true,
  dot: "active",
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

describe("backfillCardView (§10.6-4 learning card)", () => {
  it("renders nothing when there is no backfill field (older bridge)", () => {
    expect(backfillCardView(base)).toBeNull();
  });
  it("shows an active running backfill with pct + ETA", () => {
    const startedAt = Date.now() - 60_000;
    const view = backfillCardView({
      ...base,
      backfill: { done: 2, total: 10, startedAt, stopped: false, reason: null, stoppedAtDepthDays: null, active: true },
    });
    expect(view?.show).toBe(true);
    expect(view?.done).toBe(2);
    expect(view?.total).toBe(10);
    expect(view?.pct).toBeCloseTo(0.2, 5);
    // 2 items over 60s → rate 30000ms/item, 8 left → 240000ms
    expect(view?.etaMs).toBe(240000);
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
