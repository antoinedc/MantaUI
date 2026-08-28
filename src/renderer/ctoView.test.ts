import { describe, it, expect } from "vitest";
import {
  dotTone,
  badgeLabel,
  digestBusy,
  statDisplay,
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
