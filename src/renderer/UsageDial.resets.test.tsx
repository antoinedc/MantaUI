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

const tooltip = () => document.body.querySelector<HTMLElement>("[data-reset-tooltip]");
// What a sighted user reads: the visually-hidden reset descriptions are left out.
const visibleText = (el: Element) => {
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return c.textContent ?? "";
};
const escape = (el: Element) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

describe("single-seat provider — one highlighted row built from the snapshot", () => {
  const session = win("session", 62, { resetsAt: T + 2 * H + 20 * MIN, startedAt: T - 2 * H - 40 * MIN });
  const weekly = win("weekly", 41, { resetsAt: T + 40 * H });
  const firstRow = (p: HTMLElement) => p.querySelector('[data-testid="usage-seat-table"] [data-current]') as HTMLElement;
  const cells = (p: HTMLElement) => Array.from(firstRow(p).querySelectorAll<HTMLElement>("[data-window-kind]"));

  it("no reset cards: after the header the popover starts with the table", async () => {
    const p = await open({ now: T, windows: [session, weekly] });
    expect(p.querySelector('[data-testid="usage-reset-cards"]')).toBeNull();
    expect(p.querySelector('[data-testid="usage-reset-card"]')).toBeNull();
    expect(p.textContent).not.toContain("resets");
    expect(p.children[1].getAttribute("data-testid")).toBe("usage-seat-table");
  });

  it("renders a one-row table: figure + countdown per window, no Use / next / badge, no 'used' wording", async () => {
    const p = await open({ now: T, windows: [session, weekly] });
    const table = p.querySelector('[data-testid="usage-seat-table"]') as HTMLElement;
    expect(table.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(Array.from(table.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["Seat", "5-hour", "Weekly"]);
    const row = firstRow(p);
    expect(row.textContent).toContain("Max 20x"); // the snapshot's plan names the row
    expect(row.textContent).toContain("this conversation");
    expect(row.querySelector("button")).toBeNull();
    expect(row.querySelector(".manta-seat-next")).toBeNull();
    const [c5, cw] = cells(p);
    expect(c5.textContent).toContain("62%");
    // The visible countdown is the bare distance ("2h20m", no "in"); the tooltip keeps "in …".
    expect(c5.querySelector("[data-reset-timer]")!.textContent).toBe("2h20m");
    expect(cw.textContent).toContain("41%");
    expect(cw.querySelector("[data-reset-timer]")!.textContent).toBe("1d16h");
    expect(p.textContent).not.toMatch(/\bused\b/);
  });

  it("a provider with one window renders one window column", async () => {
    const p = await open({ now: T, windows: [session] });
    expect(Array.from(p.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["Seat", "5-hour"]);
    expect(cells(p)).toHaveLength(1);
  });

  it("the account's label names the row when the box reports one", async () => {
    const p = await open({ now: T, windows: [session, weekly], view: oneSeatView() });
    // one seat: still no seat choice, so the same one-row table (not the multi-seat one)
    expect(firstRow(p).textContent).toContain("Work");
  });

  it("the bars are 3px tall", async () => {
    const p = await open({ now: T, windows: [session, weekly] });
    for (const c of cells(p)) {
      const bar = c.querySelector("span.relative") as HTMLElement;
      expect(bar.className).toContain("h-[3px]");
      expect(bar.className).not.toMatch(/h-\[(5|6)px\]/);
    }
  });

  it("the position dot is there only when 'now' can be placed in the window", async () => {
    const p = await open({ now: T, windows: [session, weekly] }); // weekly: no startedAt, no spanMs
    expect(cells(p)[0].querySelector("[data-window-dot]")).toBeTruthy();
    expect(cells(p)[0].querySelector("[title$='of the way through this window']")).toBeTruthy();
    expect(cells(p)[1].querySelector("[data-window-dot]")).toBeNull();
    h!.unmount();
    const p2 = await open({ now: T, windows: [session, { ...weekly, spanMs: 7 * 24 * H }] });
    expect(cells(p2)[1].querySelector("[data-window-dot]")).toBeTruthy();
  });

  it("a window mid-reset says 'resetting…': no countdown, empty bar, no dot", async () => {
    const p = await open({ now: T, windows: [win("session", 90, { resetsAt: T - 1000, stale: true, spanMs: 5 * H }), weekly] });
    const c = cells(p)[0];
    expect(c.textContent).toContain("resetting…");
    expect(c.querySelector("[data-reset-timer]")).toBeNull();
    expect(c.querySelector("[data-window-dot]")).toBeNull();
    expect((c.querySelector("span.absolute") as HTMLElement).style.width).toBe("0%");
  });

  it("a window that has not started shows just 0% (no label, no dot); one with usage but no reset time has no countdown", async () => {
    const p = await open({ now: T, windows: [win("session", 0), win("weekly", 18)] });
    const [c5, cw] = cells(p);
    expect(c5.textContent).toBe("0%");
    expect(c5.querySelector("[data-window-dot]")).toBeNull();
    expect(cw.textContent).toContain("18%");
    expect(cw.querySelector("[data-reset-timer]")).toBeNull();
    expect((cw.querySelector("span.absolute") as HTMLElement).style.width).toBe("18%");
  });

  it("a window blocked by a used-up longer one is greyed and says why", async () => {
    const p = await open({ now: T, windows: [win("session", 10, { resetsAt: T + H }), win("weekly", 100, { resetsAt: T + 40 * H })] });
    const c = cells(p)[0];
    expect(c.getAttribute("data-blocked")).toBe("true");
    expect(c.className).toContain("opacity-40");
    expect(c.getAttribute("title")).toBe("Seat not usable until its weekly limit resets");
  });

  it("a model-scoped window is a third column, per seat: scope as the header, the usual cell, no line under the table", async () => {
    const fable = win("weekly_scoped:fable", 12, { label: "7d · Fable", scope: "Fable", resetsAt: T + 3 * H, spanMs: 7 * 24 * H });
    const p = await open({
      now: T,
      windows: [session, weekly, fable, win("weekly_scoped:sonnet", 0, { label: "7d · Sonnet", scope: "Sonnet", active: false })],
    });
    const heads = Array.from(p.querySelectorAll<HTMLElement>("th"));
    expect(heads.map((t) => t.textContent)).toEqual(["Seat", "5-hour", "Weekly", "Fable", "Sonnet"]); // not-in-force Sonnet still has a figure
    expect(heads[3].getAttribute("title")).toBe("7d · Fable — a weekly limit that applies only to this model");
    expect(heads[1].hasAttribute("title")).toBe(false);
    const third = cells(p)[2];
    expect(third.getAttribute("data-window-kind")).toBe("weekly_scoped:fable");
    expect(third.textContent).toContain("12%");
    expect(third.textContent).toContain("in 3h");
    expect(third.querySelector("[data-reset-timer]")).toBeTruthy();
    expect(third.querySelector("span.relative")!.className).toContain("h-[3px]");
    expect(third.querySelector("[data-window-dot]")).toBeTruthy();
    // every window is in a column: nothing under the table
    expect(p.querySelector('[data-testid="usage-extra-windows"]')).toBeNull();
    expect(p.textContent).not.toContain("resets with the");
    expect(p.textContent).not.toContain("not active");
    expect(p.getAttribute("style") ?? "").toContain("640px"); // 420 + 110 for each of the two extra columns
  });

  it("two window columns keep the 420px minimum", async () => {
    const p = await open({ now: T, windows: [session, weekly] });
    expect(p.style.minWidth).toBe("");
    expect(p.className).toContain("min-w-[420px]");
  });

  it("an extra window the provider flags as not in force still gets its column, with its figure", async () => {
    const p = await open({
      now: T,
      windows: [session, weekly, win("weekly_scoped:sonnet", 0, { label: "7d · Sonnet", scope: "Sonnet", active: false })],
    });
    expect(Array.from(p.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["Seat", "5-hour", "Weekly", "Sonnet"]);
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
        expect(visibleText(c)).not.toMatch(/\d:\d\d/); // never a date or a clock time in the table
        expect(c.querySelector("[data-window-kind]")).toBeTruthy();
      }
    }
  });

  it("one seat on the box: the one-row table, with no seat-choice controls", async () => {
    const p = await open({ view: oneSeatView(), seatId: "s1" });
    expect(p.querySelectorAll('[data-testid="usage-seat-table"] tbody tr')).toHaveLength(1);
    expect(p.querySelector("[data-seat-id]")).toBeNull();
    expect(p.textContent).not.toContain("Manage seats");
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

    // s2: 5h not started; its 7d is used up, so the whole seat is greyed
    const s2cells = row("s2").querySelectorAll<HTMLElement>("[data-window-kind]");
    expect(s2cells[0].textContent).toContain("0%");
    expect(s2cells[0].textContent).not.toContain("not started");
    expect(s2cells[0].getAttribute("data-blocked")).toBe("true");
    expect(s2cells[0].className).toContain("opacity-40");
    expect(s2cells[0].querySelector("[data-window-dot]")).toBeNull();
    expect(s2cells[1].getAttribute("data-blocked")).toBe("true");

    // s3: both windows mid-reset
    expect(row("s3").textContent).toContain("resetting…");
    expect(row("s3").querySelector("[data-reset-timer]")).toBeNull();
    expect(row("s3").querySelector("[data-window-dot]")).toBeNull();

    // s4: signed out, nothing to read
    const s4 = row("s4");
    expect(s4.textContent?.match(/no reading/g)).toHaveLength(2);
    expect(s4.querySelector('[data-testid="seat-logged-out"]')).toBeTruthy();
  });

  it("a seat with only a weekly window shows '—' under 5-hour and its weekly figure once", async () => {
    const v = threeSeatView();
    v.accounts[1].seats[0] = { ...seat("s3", "Seat 1", 0), windows: [win("weekly", 37, { resetsAt: NOW + 3 * H })] };
    const p = await open({ view: v, seatId: "s1" });
    const cells = Array.from(p.querySelectorAll('[data-seat-id="s3"] td')).slice(1);
    expect(cells[0].textContent).toBe("—");
    expect(cells[0].querySelector("[data-window-kind]")).toBeNull();
    expect(cells[1].textContent).toContain("37%");
    expect(p.querySelector('[data-seat-id="s3"]')!.textContent!.match(/37%/g)).toHaveLength(1);
  });

  it("a window kind only some seats have: its own column; seats without it show a dash, a not-in-force one shows its figure", async () => {
    const scoped = (pct: number, extra: Partial<UsageWindow> = {}) =>
      win("weekly_scoped:fable", pct, { label: "7d · Fable", scope: "Fable", resetsAt: NOW + 3 * H, ...extra });
    const v = threeSeatView();
    // s1 (the conversation's) has no Fable window; s2 has it; s3 has it inactive
    v.accounts[0].seats[1] = { ...seat("s2", "Seat 2", 20, 15), windows: [...seat("s2", "x", 20, 15).windows, scoped(100)] };
    v.accounts[1].seats[0] = { ...seat("s3", "Seat 1", 55, 30), windows: [...seat("s3", "x", 55, 30).windows, scoped(0, { active: false })] };
    const p = await open({ view: v, seatId: "s1" });
    expect(Array.from(p.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["Seat", "5-hour", "Weekly", "Fable"]);
    const third = (id: string) => Array.from(p.querySelectorAll(`[data-seat-id="${id}"] td`))[3] as HTMLElement;
    expect(third("s1").textContent).toBe("—");
    expect(third("s3").textContent).toContain("0%");
    expect(third("s2").textContent).toContain("100%");
    expect(third("s2").querySelector("[data-window-kind]")!.getAttribute("data-window-kind")).toBe("weekly_scoped:fable");
    expect(p.getAttribute("style") ?? "").toContain("530px");
  });

  it("the conversation's seat has the window, the others don't: they show a dash", async () => {
    const v = threeSeatView();
    v.accounts[0].seats[0] = {
      ...seat("s1", "Seat 1", 96, 40, { live: true }),
      windows: [...seat("s1", "x", 96, 40).windows, win("weekly_scoped:fable", 100, { label: "7d · Fable", scope: "Fable", resetsAt: NOW + 3 * H })],
    };
    const p = await open({ view: v, seatId: "s1" });
    const cellsOf = (id: string) => Array.from(p.querySelectorAll(`[data-seat-id="${id}"] td`)).slice(1);
    expect(cellsOf("s1")).toHaveLength(3);
    expect(cellsOf("s1")[2].textContent).toContain("100%");
    expect(cellsOf("s2")[2].textContent).toBe("—");
    expect(cellsOf("s3")[2].textContent).toBe("—");
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
  const descriptionId = (p: HTMLElement) => timer(p).getAttribute("aria-describedby");

  it("opens on focus with the exact reset, described by the timer; focus stays on the timer", async () => {
    const p = await open({ now: T, windows });
    expect(tooltip()).toBeNull();
    await act(async () => timer(p).focus());
    const tip = tooltip()!;
    expect(tip.textContent).toMatch(/^Resets Today, .+ at .+in 2h20m · window started .+$/);
    expect(timer(p).getAttribute("aria-describedby")).toBe(descriptionId(p));
    expect(tip.getAttribute("aria-hidden")).toBe("true"); // the text is exposed once, via the description
    expect(tip.hasAttribute("role")).toBe(false);
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
    expect(timer(p).getAttribute("aria-describedby")).toBe(descriptionId(p)); // still described when closed
  });

  it("the description is reachable while the tooltip is closed, before and at focus", async () => {
    const p = await open({ now: T, windows });
    expect(tooltip()).toBeNull();
    const id = timer(p).getAttribute("aria-describedby")!;
    const desc = document.getElementById(id)!;
    expect(desc.className).toContain("sr-only");
    expect(desc.textContent).toMatch(/^Resets Today, .+ at .+\. in 2h20m · window started .+$/);
    expect(Array.from(document.querySelectorAll("[id]")).filter((e) => e.id === id)).toHaveLength(1);
    await act(async () => timer(p).focus());
    expect(timer(p).getAttribute("aria-describedby")).toBe(id);
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
