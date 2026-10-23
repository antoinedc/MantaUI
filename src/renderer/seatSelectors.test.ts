import { describe, it, expect } from "vitest";
import {
  combinedSeatWindows,
  describeSeatLine,
  formatLastMove,
  hasSeatChoice,
  isMoveComing,
  isSameOrgMove,
  needsSecondAccountNote,
  nextSeatHint,
  orderOtherSeats,
  liveSeatReplacement,
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
import type { ProviderView } from "../shared/types";
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
  it("auto + >=95% + a seat under 70% exists", () => {
    const v = threeSeatView();
    expect(isMoveComing(v, findSeat(v, "s1"))).toBe(true);
  });
  it("not below 95%, not in manual mode", () => {
    const v = threeSeatView();
    expect(isMoveComing(v, findSeat(v, "s3"))).toBe(false);
    const m = threeSeatView({ mode: "manual" });
    expect(isMoveComing(m, findSeat(m, "s1"))).toBe(false);
  });
  it("96% with every other seat 70%+ stays; 100% moves to any seat with room", () => {
    const v = threeSeatView({ nextSeatId: "s2" });
    v.accounts[0].seats[1] = seat("s2", "Seat 2", 75, 20);
    expect(isMoveComing(v, findSeat(v, "s1"))).toBe(false);
    v.accounts[0].seats[0] = seat("s1", "Seat 1", 100, 20);
    expect(isMoveComing(v, findSeat(v, "s1"))).toBe(true);
  });
  it("regression: 94% does not move, 95% does (the line is 95)", () => {
    const at = (pct: number) => {
      const v = threeSeatView();
      v.accounts[0].seats[0] = seat("s1", "Seat 1", pct, 20, { live: true });
      return v;
    };
    expect(isMoveComing(at(94), findSeat(at(94), "s1"))).toBe(false);
    expect(isMoveComing(at(95), findSeat(at(95), "s1"))).toBe(true);
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
    const m = { from: "s1", fromLabel: "Seat 1", at: NOW - 2 * 3_600_000, reason: "was at 96%" };
    expect(formatLastMove(m, NOW)?.line).toBe("Moved from Seat 1 · was at 96% · 2h ago");
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

describe("misc", () => {
  it("seatBarWindows: session + unscoped weekly", () => {
    expect(seatBarWindows([win("weekly", 5), win("session", 9)]).map((w) => w.kind)).toEqual(["session", "weekly"]);
    expect(seatBarWindows([win("session", 9)])).toHaveLength(1);
    expect(seatBarWindows([])).toEqual([]);
  });
  it("seatResetHint shows the time remaining, with the local date/time only when not today", () => {
    const base = new Date(2026, 9, 9, 10, 0, 0).getTime(); // local 10:00
    const at = (ms: number) => seat("a", "A", 96, 10, {
      windows: [{ kind: "session", label: "5h", pct: 96, resetsAt: base + ms }, { kind: "weekly", label: "7d", pct: 10, resetsAt: null }],
    } as never);
    expect(seatResetHint(at(2 * 3_600_000 + 10 * 60_000), base)).toBe("resets in 2h10m");
    expect(seatResetHint(at(45 * 60_000), base)).toBe("resets in 45m");
    // Tomorrow (local): the remaining time plus the local anchor.
    expect(seatResetHint(at(20 * 3_600_000), base)).toMatch(/^resets in 20h0?m? \(.+\)$/);
    expect(seatResetHint(at(-1000), base)).toBe("resetting…");
  });

  it("seatResetHint only at/over the move line", () => {
    expect(seatResetHint(seat("a", "A", 50), NOW)).toBeNull();
    expect(seatResetHint(seat("a", "A", 95), NOW)).toMatch(/^resets in \d/);
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
    expect(providerViewOrError({ error: "last-seat" })).toEqual({ error: "This is the only login on this box — use Disconnect instead." });
    expect(providerViewOrError({ error: "no-replacement" })).toEqual({ error: expect.stringContaining("ready to take over") });
    expect("view" in providerViewOrError(oneSeatView())).toBe(true);
    expect("error" in providerViewOrError(undefined)).toBe(true);
  });
  it("liveSeatReplacement: the active seat if usable, else the least-loaded usable one, else null", () => {
    const v = threeSeatView(); // s1 live+active (96%), s2 20%, s3 55%
    expect(liveSeatReplacement(v, "s1")?.id).toBe("s2");
    expect(liveSeatReplacement({ ...v, activeSeatId: "s3" }, "s1")?.id).toBe("s3");
    const down = threeSeatView();
    down.accounts[0].seats[1].status = "expired";
    expect(liveSeatReplacement(down, "s1")?.id).toBe("s3");
    down.accounts[1].seats[0].status = "signed-out";
    expect(liveSeatReplacement(down, "s1")).toBeNull();
    expect(liveSeatReplacement(oneSeatView(), "s1")).toBeNull();
  });
  it("second-account note: once, only when an account already exists", () => {
    expect(needsSecondAccountNote(oneSeatView(), false)).toBe(true);
    expect(needsSecondAccountNote(oneSeatView(), true)).toBe(false);
    expect(needsSecondAccountNote({ ...oneSeatView(), accounts: [] }, false)).toBe(false);
  });
});

describe("combinedSeatWindows (automatic-mode ring)", () => {
  const view = (plans: (string | null)[], seats: ReturnType<typeof seat>[]): ProviderView => ({
    ...threeSeatView(),
    accounts: seats.map((s, i) => ({ id: `a${i}`, label: `A${i}`, orgName: null, plan: plans[i], seats: [s] })),
  });
  const byKind = (r: ReturnType<typeof combinedSeatWindows>, kind: string) => r!.windows.find((w) => w.kind === kind)!;

  it("equal weights when plans are unknown: plain mean, rounded, session before weekly", () => {
    const r = combinedSeatWindows(view([null, null], [seat("a", "A", 10, 30), seat("b", "B", 21, 41)]));
    expect(r!.seatCount).toBe(2);
    expect(r!.windows.map((w) => w.kind)).toEqual(["session", "weekly"]);
    expect(byKind(r, "session").pct).toBe(16); // 15.5 → 16
    expect(byKind(r, "weekly").pct).toBe(36);
    expect(byKind(r, "session").label).toBe("5h");
  });

  it("weights by plan: Pro 1 + Max 20x 20; Max 5x 5; matches inside 'Team · Max 5x'", () => {
    const pro20 = combinedSeatWindows(view(["Pro", "Max 20x"], [seat("a", "A", 100, 0), seat("b", "B", 0, 0)]));
    expect(byKind(pro20, "session").pct).toBe(5); // 100·1 / 21
    const five = combinedSeatWindows(view(["Team · Max 5x", "Pro"], [seat("a", "A", 60, 0), seat("b", "B", 0, 0)]));
    expect(byKind(five, "session").pct).toBe(50); // 60·5 / 6
  });

  it("one unknown plan (or null / plain Team) makes every seat weigh 1", () => {
    const r = combinedSeatWindows(view(["Max 20x", "Team"], [seat("a", "A", 100, 0), seat("b", "B", 0, 0)]));
    expect(byKind(r, "session").pct).toBe(50);
    expect(byKind(combinedSeatWindows(view(["Max 20x", null], [seat("a", "A", 100, 0), seat("b", "B", 0, 0)])), "session").pct).toBe(50);
  });

  it("leaves out signed-out / expired seats and seats with no reading", () => {
    const r = combinedSeatWindows(
      view(
        [null, null, null, null],
        [
          seat("a", "A", 40),
          { ...seat("b", "B", 90), status: "signed-out" },
          { ...seat("c", "C", 90), status: "expired" },
          seat("d", "D", null),
        ],
      ),
    );
    expect(r!.seatCount).toBe(1);
    expect(byKind(r, "session").pct).toBe(40);
    expect(combinedSeatWindows(view([null], [{ ...seat("e", "E", 10), status: "unknown" }]))!.seatCount).toBe(1);
  });

  it("a stale window counts as 0%; reset is the earliest non-stale; all-stale → stale, no reset", () => {
    const stale = seat("a", "A", 80, 0, { windows: [win("session", 80, { stale: true, resetsAt: NOW - 1000 }), win("weekly", 0)] });
    const live = seat("b", "B", 40, 0);
    live.windows[0] = win("session", 40, { resetsAt: NOW + 7_200_000 });
    const r = combinedSeatWindows(view([null, null], [stale, live]));
    expect(byKind(r, "session").pct).toBe(20); // (0 + 40) / 2
    expect(byKind(r, "session").resetsAt).toBe(NOW + 7_200_000);
    expect(byKind(r, "session").stale).toBeUndefined();

    const s1 = seat("c", "C", 0, 0, { windows: [win("session", 70, { stale: true })] });
    const s2 = seat("d", "D", 0, 0, { windows: [win("session", 90, { stale: true })] });
    const all = combinedSeatWindows(view([null, null], [s1, s2]));
    expect(byKind(all, "session").stale).toBe(true);
    expect(byKind(all, "session").pct).toBe(0);
    expect(byKind(all, "session").resetsAt).toBeUndefined();
  });

  it("a kind reported by only some seats averages over just those seats", () => {
    const a = seat("a", "A", 20, 0, { windows: [win("session", 20)] });
    const b = seat("b", "B", 40, 60);
    const r = combinedSeatWindows(view([null, null], [a, b]));
    expect(byKind(r, "session").pct).toBe(30);
    expect(byKind(r, "weekly").pct).toBe(60);
  });

  it("ignores inactive windows; drops used/limit/binding detail", () => {
    const a = seat("a", "A", 0, 0, {
      windows: [win("session", 50, { used: 5, limit: 10, binding: true }), win("weekly", 95, { active: false })],
    });
    const r = combinedSeatWindows(view([null], [a]));
    expect(r!.windows.map((w) => w.kind)).toEqual(["session"]);
    expect(byKind(r, "session")).not.toHaveProperty("used");
    expect(byKind(r, "session")).not.toHaveProperty("binding");
  });

  it("null when nothing qualifies", () => {
    expect(combinedSeatWindows(null)).toBeNull();
    expect(combinedSeatWindows(view([null], [seat("a", "A", null)]))).toBeNull();
    expect(combinedSeatWindows(view([null], [{ ...seat("a", "A", 50), status: "signed-out" }]))).toBeNull();
  });
});
