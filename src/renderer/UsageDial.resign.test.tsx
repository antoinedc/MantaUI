// @vitest-environment jsdom
//
// The "Logged out" badge in the usage popover and the sign-back-in modal it
// opens (spec 2026-10-15-seat-resign): shown for signed-out / expired seats —
// in the conversation's header and in "Other seats" — never for a healthy one;
// pressing it closes the popover and opens the modal OUTSIDE the popover.

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { UsageDial } from "./UsageDial";
import { NOW, claudeSnapshot, seat, threeSeatView } from "./seatFixtures";
import type { ProviderView, SeatState } from "../shared/types";

// The modal (lazy-loaded on first press) mounts the Claude terminal, whose
// xterm WebGL addon probes the canvas at import time. Stub BEFORE the click.
installCanvasStub();
// Warm the lazy chunk so the first press doesn't pay the cold import cost.
await import("./ResignSeatFlow");

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
  vi.restoreAllMocks();
});

const viewWith = (statuses: Partial<Record<"s1" | "s2" | "s3", SeatState>>): ProviderView => {
  const v = threeSeatView();
  const set = (i: number, j: number, id: "s1" | "s2" | "s3") => {
    if (statuses[id]) v.accounts[i].seats[j] = { ...v.accounts[i].seats[j], status: statuses[id]! };
  };
  set(0, 0, "s1");
  set(0, 1, "s2");
  set(1, 0, "s3");
  return v;
};

async function open(view: ProviderView, extraApi: Record<string, unknown> = {}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const { api } = installMockApi({
    accountsList: () => Promise.resolve({ providers: [view] }),
    accountsSessionSeat: () => Promise.resolve({ provider: "claude", seatId: "s1", seatLabel: "Seat 1", accountLabel: "Work" }),
    accountsResignSeat: () => Promise.resolve({ flowId: "f1", connect: { shape: "oauth-auto", url: "https://login.example", instructions: "" } }),
    accountsResignStatus: () => Promise.resolve({ state: "pending" }),
    accountsResignCancel: () => Promise.resolve({ ok: true }),
    ...extraApi,
  });
  resetStore({
    usage: [claudeSnapshot],
    alwaysShowUsage: true,
    appToasts: [],
    accounts: [view],
    sessionSeats: { s: { provider: "claude", seatId: "s1", seatLabel: "Seat 1", accountLabel: "Work" } },
  } as never);
  h = mount(<UsageDial providerID="anthropic" sessionId="s" />);
  await h.flush();
  await act(async () => {
    (h!.container.querySelector("button") as HTMLButtonElement).click();
  });
  await h.flush();
  return { api, popover: h.docQuery(".manta-usage-popover") as HTMLElement };
}

// The modal is lazy-loaded: the first press waits for its chunk to resolve.
const modalFor = async (name: string) => {
  let el: HTMLElement | null = null;
  await act(async () => {
    await vi.waitFor(() => {
      el = document.body.querySelector(`[role="dialog"][aria-label="${name}"]`);
      expect(el).toBeTruthy();
    });
  });
  return el as unknown as HTMLElement;
};

const badges = (root: ParentNode) => Array.from(root.querySelectorAll('[data-testid="seat-logged-out"]')) as HTMLButtonElement[];

describe("UsageDial — Logged out badge", () => {
  it("is hidden when every seat is ok", async () => {
    const { popover } = await open(viewWith({}));
    expect(badges(popover)).toHaveLength(0);
    expect(popover.textContent).not.toContain("Logged out");
  });

  it.each<SeatState>(["signed-out", "expired"])("shows on an Other seats row that is %s, and only on that row", async (status) => {
    const { popover } = await open(viewWith({ s3: status }));
    const row = popover.querySelector('[data-seat-id="s3"]') as HTMLElement;
    expect(badges(row)).toHaveLength(1);
    expect(badges(popover)).toHaveLength(1);
    expect(popover.querySelector('[data-testid="usage-conversation-seat"]')!.textContent).not.toContain("Logged out");
    expect(popover.textContent).not.toContain("Fix"); // the old link is gone
  });

  it.each<SeatState>(["signed-out", "expired"])("shows in the conversation's seat header when that seat is %s", async (status) => {
    const { popover } = await open(viewWith({ s1: status }));
    const header = popover.querySelector('[data-testid="usage-conversation-seat"]') as HTMLElement;
    expect(badges(header)).toHaveLength(1);
    expect(badges(popover)).toHaveLength(1);
  });

  it("an unknown-state seat (no reading yet) is not badged", async () => {
    const v = threeSeatView();
    v.accounts[1].seats[0] = seat("s3", "Seat 1", null, 0, { status: "unknown" });
    const { popover } = await open(v);
    expect(badges(popover)).toHaveLength(0);
  });

  it("pressing it closes the popover and opens the modal for that seat, outside the popover", async () => {
    const { api, popover } = await open(viewWith({ s3: "signed-out" }));
    await act(async () => {
      badges(popover)[0].click();
    });
    const dialog = await modalFor("Sign Seat 1 back in");
    expect(h!.docQuery(".manta-usage-popover")).toBeNull();
    expect(dialog.textContent).toContain("s3@example.com");
    expect(dialog.textContent).toContain("Personal");
    expect(api.calls.accountsResignSeat[0][0]).toEqual({ provider: "claude", seatId: "s3" });
  });

  it("the header badge opens the modal for the conversation's own seat", async () => {
    const { api, popover } = await open(viewWith({ s1: "expired" }));
    await act(async () => {
      badges(popover)[0].click();
    });
    await modalFor("Sign Seat 1 back in");
    expect(api.calls.accountsResignSeat[0][0]).toEqual({ provider: "claude", seatId: "s1" });
  });

  it("an outside click does not tear the modal down; cancelling closes it and tells the box", async () => {
    const { api, popover } = await open(viewWith({ s3: "signed-out" }));
    await act(async () => {
      badges(popover)[0].click();
    });
    await modalFor("Sign Seat 1 back in");
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await h!.flush();
    expect(document.body.querySelector('[role="dialog"][aria-label="Sign Seat 1 back in"]')).toBeTruthy();

    await act(async () => {
      (document.body.querySelector('button[aria-label="Cancel"]') as HTMLButtonElement).click();
    });
    await h!.flush();
    expect(api.calls.accountsResignCancel[0][0]).toEqual({ flowId: "f1" });
    expect(document.body.querySelector('[role="dialog"][aria-label="Sign Seat 1 back in"]')).toBeNull();
  });
});
