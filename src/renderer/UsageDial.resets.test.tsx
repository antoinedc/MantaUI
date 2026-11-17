// @vitest-environment jsdom
//
// The usage popover's reset cards, seat table and reset-timer tooltip (spec
// 2026-11-17-usage-popover-resets): absolute reset headline + countdown per
// window, a position dot only when the provider lets us place "now", every seat
// in one table with countdown-only cells, and a tooltip that opens on hover /
// focus and closes on Escape without taking the popover with it.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { UsageDial } from "./UsageDial";
import { formatResetHeadline } from "./chatUtils";
import { NOW, claudeSnapshot, oneSeatView, seat, threeSeatView } from "./seatFixtures";
import type { ProviderView, UsageSnapshot, UsageWindow } from "../shared/types";

const MIN = 60_000;
const H = 3_600_000;
// Tue 17 Nov 2026, 14:20 local: card/tooltip tests place resets relative to it so
// "same local day" is the same in every timezone. Seat-table tests use NOW.
const T = new Date(2026, 10, 17, 14, 20, 0).getTime();

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
  vi.restoreAllMocks();
});

const win = (kind: string, pct: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  kind,
  label: kind === "session" ? "5h" : "7d",
  pct,
  tone: "under",
  ...extra,
});

const snap = (windows: UsageWindow[]): UsageSnapshot => ({ ...claudeSnapshot, windows });

async function open(opts: { windows?: UsageWindow[]; view?: ProviderView; seatId?: string; now?: number }) {
  vi.spyOn(Date, "now").mockReturnValue(opts.now ?? NOW);
  const view = opts.view ? [opts.view] : [];
  installMockApi({
    accountsList: () => Promise.resolve({ providers: view }),
    accountsSessionSeat: () =>
      Promise.resolve(opts.seatId ? { provider: "claude", seatId: opts.seatId, seatLabel: "Seat", accountLabel: "Work" } : null),
  });
  resetStore({
    usage: [opts.windows ? snap(opts.windows) : claudeSnapshot],
    alwaysShowUsage: true,
    appToasts: [],
    accounts: view,
    sessionSeats: opts.seatId
      ? { s: { provider: "claude", seatId: opts.seatId, seatLabel: "Seat", accountLabel: "Work" } }
      : {},
  } as never);
  h = mount(<UsageDial providerID="anthropic" sessionId="s" />);
  await h.flush();
  await act(async () => {
    (h!.container.querySelector("button") as HTMLButtonElement).click();
  });
  await h.flush();
  return h.docQuery(".manta-usage-popover") as HTMLElement;
}

const cards = (p: HTMLElement) => Array.from(p.querySelectorAll<HTMLElement>('[data-testid="usage-reset-card"]'));
const tooltip = () => document.body.querySelector<HTMLElement>('[role="tooltip"]');
const escape = (el: Element) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

describe("reset cards — the conversation's seat", () => {
  const session = win("session", 62, { resetsAt: T + 2 * H + 20 * MIN, startedAt: T - 2 * H - 40 * MIN });
  const weekly = win("weekly", 41, { resetsAt: T + 40 * H });

  it("one card per bar window: noun, percentage, absolute headline, countdown — no 'used' wording", async () => {
    const p = await open({ now: T, windows: [session, weekly] });
    const [c5, cw] = cards(p);
    expect(cards(p)).toHaveLength(2);
    expect(c5.textContent).toContain("5-hour · resets");
    expect(c5.textContent).toContain("62%");
    expect(c5.textContent).toContain(formatResetHeadline(session.resetsAt, T));
    expect(c5.textContent).toContain("in 2h20m");
    expect(cw.textContent).toContain("Weekly · resets");
    expect(cw.textContent).toContain(formatResetHeadline(weekly.resetsAt, T));
    expect(cw.textContent).toContain("in 1d16h");
    expect(p.textContent).not.toMatch(/\bused\b/);
  });

  it("a window with one bar window renders one full-width card", async () => {
    const p = await open({ now: T, windows: [session] });
    expect(cards(p)).toHaveLength(1);
    expect(p.querySelector('[data-testid="usage-reset-cards"]')!.className).toContain("grid-cols-1");
  });

  it("the position dot is there only when 'now' can be placed in the window", async () => {
    const p = await open({ now: T, windows: [session, weekly] }); // weekly: no startedAt, no spanMs
    expect(cards(p)[0].querySelector("[data-window-dot]")).toBeTruthy();
    expect(cards(p)[0].querySelector("[title$='of the way through this window']")).toBeTruthy();
    expect(cards(p)[1].querySelector("[data-window-dot]")).toBeNull();
    h!.unmount();
    const p2 = await open({ now: T, windows: [session, { ...weekly, spanMs: 7 * 24 * H }] });
    expect(cards(p2)[1].querySelector("[data-window-dot]")).toBeTruthy();
  });

  it("a window mid-reset says 'Resetting…': no countdown, empty bar, no dot", async () => {
    const p = await open({ now: T, windows: [win("session", 90, { resetsAt: T - 1000, stale: true, spanMs: 5 * H }), weekly] });
    const c = cards(p)[0];
    expect(c.textContent).toContain("Resetting…");
    expect(c.querySelector("[data-reset-timer]")).toBeNull();
    expect(c.querySelector("[data-window-dot]")).toBeNull();
    expect((c.querySelector("span.absolute") as HTMLElement).style.width).toBe("0%");
  });

  it("a window that has not started says so; one with usage but no reset time shows a dash", async () => {
    const p = await open({ now: T, windows: [win("session", 0), win("weekly", 18)] });
    const [c5, cw] = cards(p);
    expect(c5.textContent).toContain("Not started");
    expect(c5.textContent).toContain("starts on first use");
    expect(c5.querySelector("[data-window-dot]")).toBeNull();
    expect(cw.querySelector(".font-semibold")!.textContent).toBe("—");
    expect(cw.querySelector("[data-reset-timer]")).toBeNull();
    expect((cw.querySelector("span.absolute") as HTMLElement).style.width).toBe("18%");
  });

  it("a window blocked by a used-up longer one is greyed and says why instead of a countdown", async () => {
    const p = await open({ now: T, windows: [win("session", 10, { resetsAt: T + H }), win("weekly", 100, { resetsAt: T + 40 * H })] });
    const c = cards(p)[0];
    expect(c.getAttribute("data-blocked")).toBe("true");
    expect(c.className).toContain("opacity-50");
    expect(c.textContent).toContain("not usable until the 7d limit resets");
    expect(c.querySelector("[data-reset-timer]")).toBeNull();
  });

  it("other windows: shares a card's reset, has its own countdown, or is not active", async () => {
    const p = await open({
      now: T,
      windows: [
        session,
        weekly,
        win("weekly_scoped:fable", 12, { label: "7d · Fable", scope: "Fable", resetsAt: weekly.resetsAt }),
        win("weekly_scoped:opus", 30, { label: "7d · Opus", scope: "Opus", resetsAt: T + 3 * H }),
        win("weekly_scoped:sonnet", 0, { label: "7d · Sonnet", scope: "Sonnet", active: false }),
      ],
    });
    const extras = p.querySelector('[data-testid="usage-extra-windows"]') as HTMLElement;
    const lines = Array.from(extras.children).map((c) => c.textContent);
    expect(lines[0]).toBe("7d · Fable 12% · resets with the weekly window");
    expect(lines[1]).toBe("7d · Opus 30% · in 3h");
    expect(lines[2]).toBe("7d · Sonnet · not active");
    expect(extras.children[1].querySelector("[data-reset-timer]")).toBeTruthy();
    expect(cards(p)).toHaveLength(2); // the scoped windows are not cards
  });
});

describe("seat table", () => {
  it("lists every seat — the conversation's first, highlighted — with countdown-only cells", async () => {
    const p = await open({ view: threeSeatView(), seatId: "s1" });
    const table = p.querySelector('[data-testid="usage-seat-table"]') as HTMLElement;
    const rows = Array.from(table.querySelectorAll<HTMLElement>("[data-seat-id]"));
    expect(rows.map((r) => r.getAttribute("data-seat-id"))).toEqual(["s1", "s2", "s3"]);
    expect(rows[0].getAttribute("data-current")).toBe("true");
    expect(rows[0].textContent).toContain("this conversation");
    expect(Array.from(table.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["Seat", "5-hour", "Weekly"]);
    for (const r of rows) {
      const cells = Array.from(r.querySelectorAll("td")).slice(1);
      expect(cells).toHaveLength(2);
      for (const c of cells) {
        expect(c.textContent).toMatch(/\d+%/);
        expect(c.textContent).toContain("in 3h");
        expect(c.textContent).not.toMatch(/\d:\d\d/); // never a date or a clock time in the table
        expect(c.querySelector("[data-window-kind]")).toBeTruthy();
      }
    }
  });

  it("no table with one seat", async () => {
    const p = await open({ view: oneSeatView(), seatId: "s1" });
    expect(p.querySelector('[data-testid="usage-seat-table"]')).toBeNull();
  });

  it("a conversation with no seat yet: the seat new conversations start on leads, and says so", async () => {
    const p = await open({ view: threeSeatView({ nextSeatId: "s2" }) });
    const first = p.querySelector("[data-seat-id]") as HTMLElement;
    expect(first.getAttribute("data-seat-id")).toBe("s2");
    expect(first.getAttribute("data-current")).toBe("true");
    expect(first.textContent).toContain("new conversations start here");
  });

  it("not started / resetting / no reading / blocked / logged out", async () => {
    const v = threeSeatView();
    const mk = (id: string, windows: UsageWindow[], extra = {}) => ({ ...seat(id, id, 0), windows, ...extra });
    v.accounts[0].seats[1] = mk("s2", [win("session", 0), win("weekly", 100, { resetsAt: NOW + 3 * H })]);
    v.accounts[1].seats = [
      mk("s3", [win("session", 70, { resetsAt: NOW - 1, stale: true }), win("weekly", 5, { resetsAt: NOW - 1, stale: true })]),
      mk("s4", [], { status: "signed-out" }),
    ];
    const p = await open({ view: v, seatId: "s1" });
    const row = (id: string) => p.querySelector(`[data-seat-id="${id}"]`) as HTMLElement;

    // s2: 5h not started (and greyed: its 7d is used up); weekly full
    const s2cells = row("s2").querySelectorAll<HTMLElement>("[data-window-kind]");
    expect(s2cells[0].textContent).toContain("0%");
    expect(s2cells[0].textContent).toContain("not started");
    expect(s2cells[0].getAttribute("data-blocked")).toBe("true");
    expect(s2cells[0].className).toContain("opacity-40");
    expect(s2cells[0].querySelector("[data-window-dot]")).toBeNull();
    expect(s2cells[1].getAttribute("data-blocked")).toBeNull();

    // s3: both windows mid-reset
    expect(row("s3").textContent).toContain("resetting…");
    expect(row("s3").querySelector("[data-reset-timer]")).toBeNull();
    expect(row("s3").querySelector("[data-window-dot]")).toBeNull();

    // s4: signed out, nothing to read
    const s4 = row("s4");
    expect(s4.textContent?.match(/no reading/g)).toHaveLength(2);
    expect(s4.querySelector('[data-testid="seat-logged-out"]')).toBeTruthy();
  });

  it("manual mode: 'Use this seat' asks first for a cross-org seat, inside the table", async () => {
    const view = threeSeatView({ mode: "manual", activeSeatId: "s1", nextSeatId: null });
    const p = await open({ view, seatId: "s1" });
    const link = p.querySelector('[data-seat-id="s3"] button') as HTMLButtonElement;
    expect(link.textContent).toBe("Use this seat");
    await act(async () => {
      link.click();
    });
    const alert = p.querySelector('[role="alert"]') as HTMLElement;
    expect(alert.closest("td")!.getAttribute("colspan")).toBe("3");
    expect(alert.textContent).toContain("Switch every conversation to Seat 1?");
  });
});

describe("reset timer tooltip", () => {
  const windows = [
    win("session", 62, { resetsAt: T + 2 * H + 20 * MIN, startedAt: T - 2 * H - 40 * MIN }),
    win("weekly", 41, { resetsAt: T + 40 * H }),
  ];
  const timer = (p: HTMLElement) => p.querySelector("[data-reset-timer]") as HTMLElement;

  it("opens on focus with the exact reset, described by the timer; focus stays on the timer", async () => {
    const p = await open({ now: T, windows });
    expect(tooltip()).toBeNull();
    await act(async () => timer(p).focus());
    const tip = tooltip()!;
    expect(tip.textContent).toMatch(/^Resets Today, .+ at .+in 2h20m · window started .+$/);
    expect(timer(p).getAttribute("aria-describedby")).toBe(tip.id);
    expect(timer(p).hasAttribute("aria-expanded")).toBe(false);
    expect(document.activeElement).toBe(timer(p));
    // portalled onto <body>, above the popover, never inside its scroll area
    expect(tip.parentElement).toBe(document.body);
    expect(p.contains(tip)).toBe(false);
    expect(tip.style.zIndex).toBe("56");
    await act(async () => timer(p).blur());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(tooltip()).toBeNull();
    expect(timer(p).hasAttribute("aria-describedby")).toBe(false);
  });

  it("opens on hover after a short delay and stays open while the pointer is over the tooltip", async () => {
    const p = await open({ now: T, windows });
    const wait = (ms: number) =>
      act(async () => {
        await new Promise((r) => setTimeout(r, ms));
      });
    act(() => {
      timer(p).dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(tooltip()).toBeNull(); // not yet
    await wait(220);
    expect(tooltip()).toBeTruthy();
    // pointer moves from the timer onto the tooltip
    act(() => {
      timer(p).dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: tooltip() }));
      tooltip()!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: timer(p) }));
    });
    await wait(250);
    expect(tooltip()).toBeTruthy();
    // …and leaves it
    act(() => {
      tooltip()!.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
    await wait(250);
    expect(tooltip()).toBeNull();
  });

  it("pressing inside the tooltip does not dismiss the usage popover", async () => {
    const p = await open({ now: T, windows });
    await act(async () => timer(p).focus());
    act(() => {
      tooltip()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(h!.docQuery(".manta-usage-popover")).toBeTruthy();
  });

  it("Escape closes only the tooltip; a second Escape closes the popover", async () => {
    const p = await open({ now: T, windows });
    await act(async () => timer(p).focus());
    expect(tooltip()).toBeTruthy();
    escape(timer(p));
    expect(tooltip()).toBeNull();
    expect(h!.docQuery(".manta-usage-popover")).toBeTruthy();
    escape(timer(p));
    expect(h!.docQuery(".manta-usage-popover")).toBeNull();
  });

  it("Escape also dismisses a tooltip opened by hover while focus is elsewhere", async () => {
    const p = await open({ now: T, windows });
    act(() => {
      timer(p).dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    expect(tooltip()).toBeTruthy();
    escape(document.body);
    expect(tooltip()).toBeNull();
    expect(h!.docQuery(".manta-usage-popover")).toBeTruthy();
  });
});
