// @vitest-environment jsdom
//
// The multi-account usage dial + popover (spec §7a): one seat is unchanged,
// several seats add the seat sections, auto shows "next" + the ↷ badge, manual
// shows a working "Use" button that reports its result.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { mount, installMockApi, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import { UsageDial } from "./UsageDial";
import { NOW, claudeSnapshot, codexSnapshot, oneSeatView, seat, threeSeatView } from "./seatFixtures";
import type { ProviderView, SessionSeat } from "../shared/types";

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
});

const sessionSeat = (seatId: string, extra: Partial<SessionSeat> = {}): SessionSeat => ({
  provider: "claude",
  seatId,
  seatLabel: "Seat 1",
  accountLabel: "Work",
  ...extra,
});

async function open(view: ProviderView[], opts: { seatId?: string | null; extraApi?: Record<string, unknown>; usage?: unknown[]; lastMove?: SessionSeat["lastMove"] } = {}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const { api } = installMockApi({
    accountsList: () => Promise.resolve({ providers: view }),
    accountsSessionSeat: () =>
      Promise.resolve(opts.seatId ? sessionSeat(opts.seatId, { lastMove: opts.lastMove }) : null),
    ...opts.extraApi,
  });
  resetStore({
    usage: (opts.usage ?? [claudeSnapshot]) as never,
    alwaysShowUsage: true,
    appToasts: [],
    accounts: view,
    sessionSeats: opts.seatId ? { s: sessionSeat(opts.seatId, { lastMove: opts.lastMove }) } : {},
  } as never);
  h = mount(<UsageDial providerID="anthropic" sessionId="s" />);
  await h.flush();
  const trigger = h.container.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    trigger.click();
  });
  await h.flush();
  return { api, popover: h.docQuery(".manta-usage-popover") as HTMLElement };
}

describe("UsageDial — one seat (unchanged)", () => {
  it("renders the classic popover: windows + updated-ago, no seat sections, no badge", async () => {
    const { popover } = await open([oneSeatView()], { seatId: "s1" });
    expect(popover).toBeTruthy();
    expect(popover.textContent).toContain("Claude");
    expect(popover.textContent).toContain("5h");
    expect(popover.textContent).toContain("7d");
    expect(popover.textContent).toMatch(/updated/i);
    expect(popover.textContent).not.toContain("Other seats");
    expect(popover.textContent).not.toContain("Manage seats");
    expect(popover.textContent).not.toContain("Automatic");
    expect(popover.querySelector('[data-testid="usage-conversation-seat"]')).toBeNull();
    expect(h!.container.querySelector("[data-move-coming]")).toBeNull();
  });

  it("no seat info at all (older box): same classic popover", async () => {
    const { popover } = await open([], { seatId: null });
    expect(popover.textContent).toContain("5h");
    expect(popover.textContent).not.toContain("Other seats");
  });
});

describe("UsageDial — three seats, automatic", () => {
  it("shows the conversation's seat on the ring and popover, next tag, mode chip, ↷ badge", async () => {
    const { popover } = await open([threeSeatView()], { seatId: "s1" });
    // The ring reports THIS conversation's seat (s1 = 96%), not the aggregate (42%).
    const trigger = h!.container.querySelector("button") as HTMLButtonElement;
    expect(trigger.getAttribute("title")).toContain("Work · Seat 1");
    expect(trigger.getAttribute("title")).toContain("96%");
    expect(h!.container.querySelector('[data-move-coming="true"]')).toBeTruthy();

    expect(popover.textContent).toContain("Automatic");
    expect(popover.querySelector('[data-testid="usage-conversation-seat"]')?.textContent).toContain("Work · Seat 1");
    expect(popover.textContent).toContain("Other seats");
    // grouped under their accounts, current seat excluded
    expect(popover.querySelector('[data-seat-id="s1"]')).toBeNull();
    const s2 = popover.querySelector('[data-seat-id="s2"]') as HTMLElement;
    const s3 = popover.querySelector('[data-seat-id="s3"]') as HTMLElement;
    expect(s2.textContent).toContain("next");
    expect(s3.textContent).not.toContain("next");
    expect(popover.textContent).toContain("Personal");
    expect(popover.textContent).toContain("Manage seats");
    // auto mode: no Use buttons
    expect(Array.from(popover.querySelectorAll("button")).some((b) => b.textContent === "Use")).toBe(false);
  });

  it("no ↷ badge below the move line", async () => {
    await open([threeSeatView()], { seatId: "s3" });
    expect(h!.container.querySelector("[data-move-coming]")).toBeNull();
  });

  it("↷ badge: absent at 94% (just under the 95% move line), shown at 95%", async () => {
    const at = (pct: number) => {
      const v = threeSeatView();
      v.accounts[0].seats[0] = seat("s1", "Seat 1", pct, 40, { live: true, conversations: 2 });
      return v;
    };
    await open([at(94)], { seatId: "s1" });
    expect(h!.container.querySelector("[data-move-coming]")).toBeNull();
    h?.unmount();
    h = null;
    await open([at(95)], { seatId: "s1" });
    expect(h!.container.querySelector('[data-move-coming="true"]')).toBeTruthy();
  });

  it("shows the last move (and the re-sent history for a cross-org move)", async () => {
    const { popover } = await open([threeSeatView()], {
      seatId: "s2",
      lastMove: { from: "s1", fromLabel: "Seat 1", at: NOW - 2 * 3_600_000, reason: "was at 96%", crossOrg: true, resentTokens: 128_000 },
    });
    const lm = popover.querySelector('[data-testid="usage-last-move"]') as HTMLElement;
    expect(lm.textContent).toContain("Moved from Seat 1 · was at 96% · 2h ago");
    expect(lm.textContent).toContain("history re-sent: 128k");
  });

  it("lists other subscriptions and 'Manage seats' opens Settings → Accounts", async () => {
    const codex = { ...threeSeatView(), provider: "codex" as const };
    const opened = vi.fn();
    window.addEventListener("manta-open-settings", opened as EventListener);
    const { popover } = await open([threeSeatView(), codex], { seatId: "s1", usage: [claudeSnapshot, codexSnapshot] });
    expect(popover.querySelector('[data-testid="usage-other-subscriptions"]')?.textContent).toContain("OpenAI");
    const manage = Array.from(popover.querySelectorAll("button")).find((b) => b.textContent === "Manage seats")!;
    await act(async () => {
      manage.click();
    });
    window.removeEventListener("manta-open-settings", opened as EventListener);
    expect(opened).toHaveBeenCalledTimes(1);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ section: "accounts", provider: "claude" });
    expect(h!.docQuery(".manta-usage-popover")).toBeNull(); // popover closed
  });

  it("more than five other seats scroll inside the list", async () => {
    const v = threeSeatView();
    v.accounts[1].seats = Array.from({ length: 6 }, (_, i) => seat(`x${i}`, `Extra ${i}`, 10 + i));
    const { popover } = await open([v], { seatId: "s1" });
    const list = popover.querySelector(".manta-seat-list") as HTMLElement;
    expect(list.style.maxHeight).toBe("260px");
  });

  it("a signed-out seat says so and points to the fix", async () => {
    const v = threeSeatView();
    v.accounts[1].seats[0] = { ...seat("s3", "Seat 1", 55), status: "signed-out" };
    const { popover } = await open([v], { seatId: "s1" });
    const row = popover.querySelector('[data-seat-id="s3"]') as HTMLElement;
    expect(row.textContent).toContain("signed out");
    expect(row.textContent).toContain("Fix");
  });
});

describe("UsageDial — manual mode", () => {
  const manual = () => threeSeatView({ mode: "manual", activeSeatId: "s1", nextSeatId: null });

  it("the ring follows the active seat, no next tag / badge, Use buttons present", async () => {
    const { popover } = await open([manual()], { seatId: "s3" });
    const trigger = h!.container.querySelector("button") as HTMLButtonElement;
    expect(trigger.getAttribute("title")).toContain("96%"); // active seat s1, not the stored s3
    expect(h!.container.querySelector("[data-move-coming]")).toBeNull();
    expect(popover.textContent).toContain("Manual");
    expect(popover.querySelector(".manta-seat-next")).toBeNull();
    const uses = Array.from(popover.querySelectorAll("button")).filter((b) => b.textContent === "Use");
    expect(uses).toHaveLength(2);
  });

  it("Use on a same-org seat calls set-active at once and reports the result", async () => {
    const after = { ...manual(), activeSeatId: "s2" };
    const setActive = vi.fn(() => Promise.resolve(after));
    const { api, popover } = await open([manual()], { seatId: "s1", extraApi: { accountsSetActive: setActive } });
    const use = popover.querySelector('[data-seat-id="s2"] button') as HTMLButtonElement;
    expect(use.textContent).toBe("Use");
    await act(async () => {
      use.click();
    });
    await h!.flush();
    expect(api.calls.accountsSetActive[0][0]).toEqual({ provider: "claude", seatId: "s2" });
    expect(useStore.getState().accounts[0].activeSeatId).toBe("s2");
    const toast = useStore.getState().appToasts?.at(-1) ?? useStore.getState().appToasts?.[0];
    expect(JSON.stringify(toast)).toContain("All conversations now use Seat 2");
  });

  it("Use on a cross-org seat asks first; confirming calls set-active", async () => {
    const setActive = vi.fn(() => Promise.resolve({ ...manual(), activeSeatId: "s3" }));
    const { popover } = await open([manual()], { seatId: "s1", extraApi: { accountsSetActive: setActive } });
    const use = popover.querySelector('[data-seat-id="s3"] button') as HTMLButtonElement;
    await act(async () => {
      use.click();
    });
    expect(setActive).not.toHaveBeenCalled();
    const alert = popover.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain("re-send their history once");
    const sw = Array.from(alert.querySelectorAll("button")).find((b) => b.textContent === "Switch")!;
    await act(async () => {
      sw.click();
    });
    await h!.flush();
    expect(setActive).toHaveBeenCalledWith({ provider: "claude", seatId: "s3" });
  });

  it("a failed Use reports the specific reason and leaves the list unchanged", async () => {
    const setActive = vi.fn(() => Promise.resolve({ error: "unknown-seat" }));
    const { popover } = await open([manual()], { seatId: "s1", extraApi: { accountsSetActive: setActive } });
    await act(async () => {
      (popover.querySelector('[data-seat-id="s2"] button') as HTMLButtonElement).click();
    });
    await h!.flush();
    expect(useStore.getState().accounts[0].activeSeatId).toBe("s1");
    expect(JSON.stringify(useStore.getState().appToasts)).toContain("no longer exists");
  });
});
