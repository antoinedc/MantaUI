// @vitest-environment jsdom
//
// The in-conversation "moved to another seat" notice (multi-account, spec §5.3).
// Mounts the REAL ChatPanel: it shows on `accounts.moved` for THIS conversation,
// on open when the box's lastMove is < 30 min old, dismisses (per move), and
// hides itself after 5 minutes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { ChatPanel } from "./ChatPanel";
import { SeatMoveNotice } from "./Cards";
import { resetSeatMoveNoticeForTests } from "./hooks/useSeatMoveNotice";
import { installMockApi, resetStore, mount, type Harness } from "./testHarness";
import { NOW, threeSeatView } from "./seatFixtures";
import type { AccountsMovedPayload, SessionSeat } from "../shared/types";

const PROPS = { sessionId: "ses_a", tmuxSession: "proj", windowIndex: 1, cwd: "/x", isActive: true };
const NOTICE = '[data-testid="seat-move-notice"]';

let h: Harness | null = null;
let movedListeners = new Set<(p: AccountsMovedPayload) => void>();
const emitMoved = async (p: AccountsMovedPayload) => {
  await act(async () => {
    for (const fn of Array.from(movedListeners)) fn(p);
  });
  await h!.flush();
};

const seatNow = (extra: Partial<SessionSeat> = {}): SessionSeat => ({
  provider: "claude",
  seatId: "s2",
  seatLabel: "Seat 2",
  accountLabel: "Work",
  ...extra,
});

function setup(seat: SessionSeat | null, over: Record<string, unknown> = {}) {
  movedListeners = new Set();
  installMockApi({
    onAccountsMoved: (fn: (p: AccountsMovedPayload) => void) => {
      movedListeners.add(fn);
      return () => movedListeners.delete(fn);
    },
    accountsSessionSeat: () => Promise.resolve(seat),
    accountsList: () => Promise.resolve({ providers: [threeSeatView()] }),
    ...over,
  });
  resetStore({
    accounts: [threeSeatView()],
    sessionSeats: seat ? { ses_a: seat } : {},
  } as never);
}

const mountPanel = async () => {
  h = mount(<ChatPanel {...PROPS} />);
  await h.flush();
};
const noticeText = () => h!.container.querySelector(NOTICE)?.textContent ?? null;

beforeEach(() => {
  resetSeatMoveNoticeForTests();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SeatMoveNotice (leaf)", () => {
  it("renders the line and a working dismiss button", () => {
    const onDismiss = vi.fn();
    h = mount(<SeatMoveNotice text="Moved to B." onDismiss={onDismiss} />);
    expect(h.text()).toContain("Moved to B.");
    act(() => (h!.container.querySelector('[data-testid="seat-move-notice-dismiss"]') as HTMLButtonElement).click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("ChatPanel seat-move notice", () => {
  it("shows nothing for a conversation that never moved", async () => {
    setup(seatNow());
    await mountPanel();
    expect(noticeText()).toBeNull();
  });

  it("shows the line when accounts.moved arrives for this conversation", async () => {
    setup(seatNow());
    await mountPanel();
    await emitMoved({
      sessionId: "ses_a", provider: "claude", from: "s1", to: "s2", reason: "load",
      fromLabel: "Seat 1", toLabel: "Work · Seat 2", trigger: { kind: "session", pct: 91 },
    });
    expect(noticeText()).toContain("Moved to Work · Seat 2 (Seat 1 at 91% of 5h).");
  });

  it("ignores a move of another conversation", async () => {
    setup(seatNow());
    await mountPanel();
    await emitMoved({ sessionId: "ses_other", from: "s1", to: "s2", reason: "load" });
    expect(noticeText()).toBeNull();
  });

  it("falls back to the seat's own label when the payload has none, and says re-sent for cross-org", async () => {
    setup(seatNow({ seatId: "s3", seatLabel: "Seat 1", accountLabel: "Personal" }));
    await mountPanel();
    await emitMoved({ sessionId: "ses_a", provider: "claude", from: "s1", to: "s3", reason: "exhausted", crossOrg: true, trigger: { kind: "weekly", pct: 100 } });
    // No labels in the payload: names come from the live view (from-seat s1 = "Seat 1").
    expect(noticeText()).toContain("Moved to Personal (Seat 1 at 100% of the weekly limit). History re-sent.");
  });

  it("shows on open from a recent lastMove, but not an old one", async () => {
    setup(seatNow({ lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW - 10 * 60_000, reason: "unusable" } }));
    await mountPanel();
    expect(noticeText()).toContain("Moved to Work · Seat 2 (Seat 1 needed sign-in).");
    h!.unmount();

    resetSeatMoveNoticeForTests();
    setup(seatNow({ lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW - 31 * 60_000, reason: "unusable" } }));
    await mountPanel();
    expect(noticeText()).toBeNull();
  });

  it("× dismisses that move for good; a later move shows again", async () => {
    setup(seatNow({ lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW - 60_000, reason: "load", trigger: { kind: "session", pct: 92 } } }));
    await mountPanel();
    expect(noticeText()).toContain("92% of 5h");
    await act(async () => (h!.container.querySelector('[data-testid="seat-move-notice-dismiss"]') as HTMLButtonElement).click());
    await h!.flush();
    expect(noticeText()).toBeNull();

    // Reopening the conversation does not resurrect it.
    h!.unmount();
    setup(seatNow({ lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW - 60_000, reason: "load", trigger: { kind: "session", pct: 92 } } }));
    await mountPanel();
    expect(noticeText()).toBeNull();

    // A different move (s2 → s3) is a new notice.
    await emitMoved({ sessionId: "ses_a", provider: "claude", from: "s2", to: "s3", reason: "manual", toLabel: "Personal" });
    expect(noticeText()).toContain("Switched to Personal.");
  });

  it("the event and the box's record for the same move do not double up or undo a dismissal", async () => {
    setup(seatNow());
    await mountPanel();
    await emitMoved({ sessionId: "ses_a", provider: "claude", from: "s1", to: "s2", reason: "load", fromLabel: "Seat 1", toLabel: "Work · Seat 2" });
    await act(async () => (h!.container.querySelector('[data-testid="seat-move-notice-dismiss"]') as HTMLButtonElement).click());
    // The record catches up (different clock, same move).
    const { useStore } = await import("./store");
    await act(async () => {
      useStore.getState().setSessionSeat("ses_a", seatNow({ lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW + 500, reason: "load", trigger: { kind: "session", pct: 91 } } }));
    });
    await h!.flush();
    expect(noticeText()).toBeNull();
    expect(h!.container.querySelectorAll(NOTICE).length).toBe(0);
  });

  it("hides itself 5 minutes after it appears", async () => {
    setup(seatNow({ lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW - 60_000, reason: "load" } }));
    await mountPanel();
    expect(noticeText()).not.toBeNull();
    // Fire the 5-minute timer the hook armed (a real clock would take 5 minutes).
    const spy = vi.spyOn(globalThis, "setTimeout");
    h!.unmount();
    resetSeatMoveNoticeForTests();
    await mountPanel();
    const armed = spy.mock.calls.find((c) => c[1] === 5 * 60_000);
    expect(armed).toBeTruthy();
    await act(async () => {
      (armed![0] as () => void)();
    });
    expect(noticeText()).toBeNull();
  });
});
