import { describe, it, expect } from "vitest";
import {
  describeSeatLine,
  formatLastMove,
  hasSeatChoice,
  isMoveComing,
  isSameOrgMove,
  needsSecondAccountNote,
  nextSeatHint,
  orderOtherSeats,
  otherSubscriptionLines,
  providerViewOrError,
  seatBarWindows,
  seatDialSnapshot,
  seatLoad,
  seatResetHint,
  selectConversationSeat,
  selectProviderView,
  findSeat,
} from "./chatUtils";
import { NOW, claudeSnapshot, codexSnapshot, oneSeatView, seat, threeSeatView, win } from "./seatFixtures";
import { leastLoadedSeat } from "../shared/seatChoice.mjs";

describe("seatLoad (re-exported from seatChoice)", () => {
  it("is the highest active, fresh window; null with no reading", () => {
    expect(seatLoad(seat("x", "X", 30, 70))).toBe(70);
    expect(seatLoad({ windows: [win("session", 80, { stale: true }), win("weekly", 10)] })).toBe(10);
    expect(seatLoad(seat("x", "X", null))).toBeNull();
  });
});

describe("selectProviderView", () => {
  it("finds the provider through the usage snapshot's providerIDs", () => {
    const v = threeSeatView();
    expect(selectProviderView([v], [claudeSnapshot], "anthropic")).toBe(v);
    expect(selectProviderView([v], [claudeSnapshot, codexSnapshot], "openai")).toBeNull();
  });
  it("falls back to the adapter table when no snapshot exists yet", () => {
    const v = threeSeatView();
    expect(selectProviderView([v], [], "anthropic")).toBe(v);
  });
  it("null with no providers / no provider id", () => {
    expect(selectProviderView([], [claudeSnapshot], "anthropic")).toBeNull();
    expect(selectProviderView([threeSeatView()], [claudeSnapshot], null)).toBeNull();
  });
});

describe("hasSeatChoice", () => {
  it("is true only with >= 2 seats in the whole provider", () => {
    expect(hasSeatChoice(oneSeatView())).toBe(false);
    expect(hasSeatChoice(threeSeatView())).toBe(true);
    expect(hasSeatChoice(null)).toBe(false);
  });
});

describe("selectConversationSeat", () => {
  const sessionSeat = { provider: "claude" as const, seatId: "s3", seatLabel: "Seat 1", accountLabel: "Personal" };
  it("auto: the conversation's assignment", () => {
    const r = selectConversationSeat(threeSeatView(), sessionSeat);
    expect(r?.seat.id).toBe("s3");
    expect(r?.account.label).toBe("Personal");
  });
  it("manual: the active seat wins over any stored assignment", () => {
    const r = selectConversationSeat(threeSeatView({ mode: "manual", activeSeatId: "s2" }), sessionSeat);
    expect(r?.seat.id).toBe("s2");
  });
  it("null when there is no assignment / the seat is gone", () => {
    expect(selectConversationSeat(threeSeatView(), null)).toBeNull();
    expect(selectConversationSeat(threeSeatView(), { ...sessionSeat, seatId: "gone" })).toBeNull();
  });
});

describe("nextSeatHint", () => {
  it("prefers the server-provided nextSeatId", () => {
    expect(nextSeatHint(threeSeatView({ nextSeatId: "s3" }), "s1")).toBe("s3");
  });
  it("when nextSeatId is the current seat or absent, uses seatChoice's leastLoadedSeat", () => {
    const v = threeSeatView({ nextSeatId: null });
    const expected = leastLoadedSeat(
      [
        { seatId: "s2", windows: v.accounts[0].seats[1].windows },
        { seatId: "s3", windows: v.accounts[1].seats[0].windows },
      ],
      { activeSeatId: v.activeSeatId },
    )?.seatId;
    expect(nextSeatHint(v, "s1")).toBe(expected);
    expect(nextSeatHint(v, "s1")).toBe("s2");
    expect(nextSeatHint(threeSeatView({ nextSeatId: "s1" }), "s1")).toBe("s2");
  });
  it("skips a signed-out seat and is null with nowhere to go", () => {
    const v = threeSeatView({ nextSeatId: "s2" });
    v.accounts[0].seats[1].status = "signed-out";
    expect(nextSeatHint(v, "s1")).toBe("s3");
    expect(nextSeatHint(oneSeatView(), "s1")).toBeNull();
  });
});

describe("isMoveComing", () => {
  it("auto + >=90% + a seat under 70% exists", () => {
    const v = threeSeatView();
    expect(isMoveComing(v, findSeat(v, "s1"))).toBe(true);
  });
  it("not below 90%, not in manual mode", () => {
    const v = threeSeatView();
    expect(isMoveComing(v, findSeat(v, "s3"))).toBe(false);
    const m = threeSeatView({ mode: "manual" });
    expect(isMoveComing(m, findSeat(m, "s1"))).toBe(false);
  });
  it("93% with every other seat 70%+ stays; 100% moves to any seat with room", () => {
    const v = threeSeatView({ nextSeatId: "s2" });
    v.accounts[0].seats[1] = seat("s2", "Seat 2", 75, 20);
    expect(isMoveComing(v, findSeat(v, "s1"))).toBe(false);
    v.accounts[0].seats[0] = seat("s1", "Seat 1", 100, 20);
    expect(isMoveComing(v, findSeat(v, "s1"))).toBe(true);
  });
});

describe("seatDialSnapshot", () => {
  it("carries the seat's windows + plan + freshness over the provider snapshot", () => {
    const v = threeSeatView();
    const snap = seatDialSnapshot(claudeSnapshot, findSeat(v, "s3"));
    expect(snap.windows[0].pct).toBe(55);
    expect(snap.planLabel).toBe("Pro");
  });
  it("a seat with no reading, or no seat, yields the base untouched", () => {
    const v = threeSeatView();
    v.accounts[1].seats[0] = seat("s3", "Seat 1", null);
    expect(seatDialSnapshot(claudeSnapshot, findSeat(v, "s3"))).toBe(claudeSnapshot);
    expect(seatDialSnapshot(claudeSnapshot, null)).toBe(claudeSnapshot);
  });
});

describe("orderOtherSeats", () => {
  it("excludes the current seat, groups by account, headings only with >= 2 accounts", () => {
    const g = orderOtherSeats(threeSeatView(), "s1");
    expect(g.map((x) => [x.label, x.showHeading, x.seats.map((s) => s.id)])).toEqual([
      ["Work", true, ["s2"]],
      ["Personal", true, ["s3"]],
    ]);
  });
  it("one account: no heading; signed-out sinks to the end; empty groups dropped", () => {
    const v = threeSeatView();
    v.accounts = [
      {
        ...v.accounts[0],
        seats: [seat("s1", "Seat 1", 10), { ...seat("s2", "Seat 2", 20), status: "expired" }, seat("s4", "Seat 3", 30)],
      },
    ];
    const g = orderOtherSeats(v, "s1");
    expect(g).toHaveLength(1);
    expect(g[0].showHeading).toBe(false);
    expect(g[0].seats.map((s) => s.id)).toEqual(["s4", "s2"]);
    expect(orderOtherSeats(oneSeatView(), "s1")).toEqual([]);
  });
});

describe("isSameOrgMove", () => {
  it("same account = same org; different account = cross-org", () => {
    const v = threeSeatView();
    expect(isSameOrgMove(v, "s1", "s2")).toBe(true);
    expect(isSameOrgMove(v, "s1", "s3")).toBe(false);
  });
});

describe("formatLastMove", () => {
  it("names the origin, reason and age; hides after 5h", () => {
    const m = { from: "s1", fromLabel: "Seat 1", at: NOW - 2 * 3_600_000, reason: "was at 93%" };
    expect(formatLastMove(m, NOW)?.line).toBe("Moved from Seat 1 · was at 93% · 2h ago");
    expect(formatLastMove({ ...m, at: NOW - 6 * 3_600_000 }, NOW)).toBeNull();
    expect(formatLastMove(null, NOW)).toBeNull();
  });
  it("a cross-org move adds the re-sent history", () => {
    const r = formatLastMove(
      { from: "s1", fromLabel: "Seat 1", at: NOW - 60_000, reason: "full", crossOrg: true, resentTokens: 128_000 },
      NOW,
    );
    expect(r?.resent).toBe("history re-sent: 128k");
  });
});

describe("otherSubscriptionLines", () => {
  it("one line per OTHER provider with seats", () => {
    const codex = { ...threeSeatView(), provider: "codex" as const, mode: "auto" as const };
    const lines = otherSubscriptionLines([threeSeatView(), codex], "claude");
    expect(lines).toHaveLength(1);
    expect(lines[0].provider).toBe("codex");
    expect(lines[0].text).toMatch(/^best seat 20% of /);
  });
  it("a single-seat provider reads without 'best seat'; none for the current provider alone", () => {
    const one = { ...oneSeatView(), provider: "codex" as const };
    expect(otherSubscriptionLines([one], "claude")[0].text).toMatch(/^42%/);
    expect(otherSubscriptionLines([oneSeatView()], "claude")).toEqual([]);
  });
});

describe("misc", () => {
  it("seatBarWindows: session + unscoped weekly", () => {
    expect(seatBarWindows([win("weekly", 5), win("session", 9)]).map((w) => w.kind)).toEqual(["session", "weekly"]);
    expect(seatBarWindows([win("session", 9)])).toHaveLength(1);
    expect(seatBarWindows([])).toEqual([]);
  });
  it("seatResetHint only at/over the move line", () => {
    expect(seatResetHint(seat("a", "A", 50), NOW)).toBeNull();
    expect(seatResetHint(seat("a", "A", 95), NOW)).toMatch(/^resets /);
  });
  it("describeSeatLine prefers the live view's names", () => {
    const v = threeSeatView();
    const ss = { provider: "claude" as const, seatId: "s2", seatLabel: "old", accountLabel: "old" };
    expect(describeSeatLine([v], ss)).toBe("Seat: Work · Seat 2");
    expect(describeSeatLine([], ss)).toBe("Seat: old · old");
    expect(describeSeatLine([v], null)).toBeNull();
    expect(describeSeatLine([oneSeatView()], { ...ss, seatId: "s1" })).toBe("Seat: Work");
  });
  it("providerViewOrError maps codes to sentences", () => {
    expect(providerViewOrError({ error: "live-seat" })).toEqual({ error: expect.stringContaining("can't be removed") });
    expect("view" in providerViewOrError(oneSeatView())).toBe(true);
    expect("error" in providerViewOrError(undefined)).toBe(true);
  });
  it("second-account note: once, only when an account already exists", () => {
    expect(needsSecondAccountNote(oneSeatView(), false)).toBe(true);
    expect(needsSecondAccountNote(oneSeatView(), true)).toBe(false);
    expect(needsSecondAccountNote({ ...oneSeatView(), accounts: [] }, false)).toBe(false);
  });
});
