// @vitest-environment jsdom
//
// "Sign back in" on a seat in Settings → Accounts (the destination of the chat
// error bar's Reconnect button). It reuses ResignSeatFlow, so these tests pin the
// wiring and the outcomes the user sees: success, wrong account, an identity the
// box cannot verify, and — for the box's own login — an instruction, not a button.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { resignFailureMessage } from "../server/accountsCopy.mjs";
import { act } from "react";
import { installCanvasStub, mount, installMockApi, resetStore, type Harness } from "./testHarness";
import { clearAccountsFocus } from "./accountsData";
import { liveSeatNoteText } from "./chatUtils";
import { NOW, oneSeatView, seat, threeSeatView } from "./seatFixtures";
import type { ProviderView } from "../shared/types";

installCanvasStub();
const { SeatsPanel } = await import("./SeatsPanel");
await import("./ResignSeatFlow");

const DEVICE = { shape: "oauth-auto", url: "https://login.example", instructions: "code ABCD-1234" };
const POLL = 2_100;

let h: Harness | null = null;
beforeEach(() => {
  clearAccountsFocus();
  window.localStorage.clear();
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const press = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await advance(0);
};
const bodyButton = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
const rowButton = (seatId: string, label: string) =>
  Array.from(h!.container.querySelector(`[data-seat-id="${seatId}"]`)!.querySelectorAll("button")).find((b) => b.textContent === label);

/** One NON-live, healthy-looking seat (the credential just failed; the poller has not marked it yet). */
function loneNonLiveView(provider: "claude" | "codex" = "claude"): ProviderView {
  const v = oneSeatView();
  v.provider = provider;
  v.accounts[0].seats = [seat("s1", "Seat 1", 42, 20, { live: false })];
  return v;
}

async function openPanel(view: ProviderView, api: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const m = installMockApi({
    accountsList: () => Promise.resolve({ providers: [view] }),
    usageList: () => Promise.resolve([]),
    accountsResignSeat: () => Promise.resolve({ flowId: "f1", connect: DEVICE }),
    accountsResignStatus: () => Promise.resolve({ state: "pending" }),
    accountsResignCancel: () => Promise.resolve({ ok: true }),
    ...api,
  });
  resetStore({ accounts: [view], appToasts: [] } as never);
  h = mount(<SeatsPanel view={view} />);
  await advance(0);
  await press(h.container.querySelector("button[aria-expanded]"));
  return m;
}

describe("SeatsPanel — Sign back in", () => {
  it("a lone non-live seat that still reads healthy has a working Sign back in (same-account success)", async () => {
    let n = 0;
    const m = await openPanel(loneNonLiveView(), {
      accountsResignStatus: () =>
        Promise.resolve(n++ === 0 ? { state: "pending" } : { state: "ok", seat: { id: "s1", label: "Seat 1", email: "s1@example.com" } }),
    });
    const btn = bodyButton("Sign back in")!;
    expect(btn.disabled).toBe(false);
    await press(btn);
    expect(m.api.calls.accountsResignSeat[0][0]).toEqual({ provider: "claude", seatId: "s1" });
    expect(document.body.querySelector('[data-testid="resign-seat-flow"]')).toBeTruthy();
    await advance(POLL);
    await advance(POLL);
    await advance(2_000); // the confirmation hold
    expect(document.body.querySelector('[data-testid="resign-seat-flow"]')).toBeNull();
    expect(h!.container.querySelector('[role="status"]')?.textContent).toBe("Signed back in as s1@example.com");
  });

  it("a different account is refused visibly and the modal can be closed", async () => {
    const m = await openPanel(loneNonLiveView("codex"), {
      accountsResignStatus: () =>
        Promise.resolve({
          state: "failed", error: "different-account", expectedEmail: "s1@example.com", gotEmail: "x@example.com",
          message: resignFailureMessage({ error: "different-account", expectedEmail: "s1@example.com", gotEmail: "x@example.com", seatLabel: "Seat 1", email: null }),
        }),
    });
    await press(bodyButton("Sign back in"));
    await advance(POLL);
    expect(m.api.calls.accountsResignSeat[0][0]).toEqual({ provider: "codex", seatId: "s1" });
    expect(document.body.textContent).toContain("You signed in as x@example.com, but this seat is s1@example.com");
    await press(bodyButton("Close"));
    expect(document.body.querySelector('[data-testid="resign-seat-flow"]')).toBeNull();
  });

  it("an identity the box cannot verify (login-failed) stays visible and Close works", async () => {
    await openPanel(loneNonLiveView(), { accountsResignStatus: () => Promise.resolve({ state: "failed", error: "login-failed", message: resignFailureMessage({ error: "login-failed", seatLabel: "Seat 1", email: null }) }) });
    await press(bodyButton("Sign back in"));
    await advance(POLL);
    expect(document.body.textContent).toContain("Sign-in didn't complete");
    expect(document.body.textContent).toContain("Seat 1 was not changed");
    await press(bodyButton("Close"));
    expect(document.body.querySelector('[data-testid="resign-seat-flow"]')).toBeNull();
    expect(bodyButton("Sign back in")!.disabled).toBe(false); // usable again
  });

  it("is disabled (with a reason) while another sign-in modal is open", async () => {
    await openPanel(threeSeatView());
    await press(rowButton("s2", "Sign back in"));
    expect(rowButton("s3", "Sign back in")).toBeTruthy();
    expect((rowButton("s3", "Sign back in") as HTMLButtonElement).disabled).toBe(true);
    expect((rowButton("s3", "Sign back in") as HTMLButtonElement).title).toMatch(/Finish or cancel/);
  });

  it("a LIVE Claude seat gets no button, only the true instruction", async () => {
    await openPanel(oneSeatView());
    expect(bodyButton("Sign back in")).toBeUndefined();
    expect(h!.container.querySelector('[data-testid="seat-live-note-s1"]')?.textContent).toBe(liveSeatNoteText("claude"));
    expect(h!.text()).toContain("run claude auth login on the box and sign in with the same account");
    expect(h!.text()).not.toContain("`");
    expect(h!.container.querySelector('[data-testid="seat-live-note-s1"] code')?.textContent).toBe("claude auth login");
  });

  it("a LIVE Codex seat gets no button and says it can't be re-signed from here yet", async () => {
    const v = oneSeatView();
    v.provider = "codex";
    await openPanel(v);
    expect(bodyButton("Sign back in")).toBeUndefined();
    expect(h!.container.querySelector('[data-testid="seat-live-note-s1"]')?.textContent).toBe(
      "This is the login this box itself uses; it can't be re-signed from here yet.",
    );
  });

  it("live-seat refusal (the seat became live since the list was read) is not worded as a removal", async () => {
    const m = await openPanel(loneNonLiveView(), { accountsResignSeat: () => Promise.resolve({ error: "live-seat" }) });
    await press(bodyButton("Sign back in"));
    const t = document.body.textContent ?? "";
    expect(t).toContain("Seat 1 is now the login this box itself uses, so it can't be re-signed here.");
    expect(t).toContain("Run claude auth login on the box and sign in with the same account.");
    expect(t).not.toContain("removed");
    expect(m.api.calls.accountsList?.length ?? 0).toBeGreaterThan(0); // the list was refreshed
  });
});
