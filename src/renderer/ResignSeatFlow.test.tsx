// @vitest-environment jsdom
//
// ResignSeatFlow: sign an existing seat back in. Every outcome must be on
// screen — success, the different-account refusal, a failed sign-in, a start
// error, and a cancel (which must say the seat was not changed).

import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";

// The flow mounts ConnectProvider's Claude terminal block, which pulls in
// xterm's WebGL addon; it probes the canvas at import time. Stub BEFORE import.
installCanvasStub();
const { ResignSeatFlow, RESIGN_DONE_HOLD_MS } = await import("./ResignSeatFlow");

let h: Harness | null = null;
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
});

const DEVICE = { shape: "oauth-auto", url: "https://login.example", instructions: "code ABCD-1234" };
const CLAUDE = { shape: "claude-login", sessionKey: "claude-login-k", startedAt: 1, cwd: "/home" };

// Timers are faked (the poll is a 2s interval, the success hold a 1.5s timeout),
// so everything advances through the fake clock rather than h.flush().
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const POLL = 2_100;

const text = () => document.body.textContent ?? "";
const dialogButton = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === label) as HTMLButtonElement | undefined;
const press = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await advance(0);
};

async function start(api: Record<string, unknown> = {}) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const m = installMockApi({
    accountsResignSeat: () => Promise.resolve({ flowId: "f1", connect: DEVICE }),
    accountsResignStatus: () => Promise.resolve({ state: "pending" }),
    accountsResignCancel: () => Promise.resolve({ ok: true }),
    accountsList: () => Promise.resolve({ providers: [] }),
    usageList: () => Promise.resolve([]),
    ...api,
  });
  resetStore({ appToasts: [] } as never);
  h = mount(
    <ResignSeatFlow
      provider="claude"
      seatId="s3"
      seatLabel="Seat 3"
      accountLabel="Personal"
      email="me@example.com"
      onDone={onDone}
      onCancel={onCancel}
    />,
  );
  await advance(0);
  return { m, onDone, onCancel };
}

describe("ResignSeatFlow", () => {
  it("opens titled for the seat, shows its email, and starts the box's sign-in for exactly that seat", async () => {
    const { m } = await start();
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Sign Seat 3 back in");
    expect(text()).toContain("Sign Seat 3 back in");
    expect(document.body.querySelector('[data-testid="resign-seat-email"]')?.textContent).toContain("me@example.com");
    expect(m.api.calls.accountsResignSeat[0][0]).toEqual({ provider: "claude", seatId: "s3" });
    expect(text()).toContain("login.example"); // the device-code block from `connect`
  });

  it("ok: confirms who signed in, awaits the list refresh, then closes", async () => {
    let n = 0;
    let refreshed = false;
    const { onDone } = await start({
      accountsResignStatus: () => Promise.resolve(n++ === 0 ? { state: "pending" } : { state: "ok", seat: { id: "s3", label: "Seat 3", email: "me@example.com" } }),
      accountsList: () => {
        refreshed = true;
        return Promise.resolve({ providers: [] });
      },
    });
    await advance(POLL);
    expect(onDone).not.toHaveBeenCalled();
    await advance(POLL);
    expect(document.body.querySelector("[role=status]")?.textContent).toBe("Signed back in as me@example.com");
    expect(refreshed).toBe(true);
    expect(onDone).not.toHaveBeenCalled(); // the confirmation is held, not flashed
    await advance(RESIGN_DONE_HOLD_MS);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith("Signed back in as me@example.com");
  });

  it("ok: does not close until the refresh has landed, even after the hold", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { onDone } = await start({
      accountsResignStatus: () => Promise.resolve({ state: "ok", seat: { id: "s3", label: "Seat 3", email: "me@example.com" } }),
      accountsList: async () => {
        await gate;
        return { providers: [] };
      },
    });
    await advance(POLL);
    await advance(RESIGN_DONE_HOLD_MS + 500);
    expect(onDone).not.toHaveBeenCalled();
    release();
    await advance(0);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("different-account: names both emails, leaves the seat alone, offers Try again", async () => {
    const resign = vi.fn(() => Promise.resolve({ flowId: "f1", connect: DEVICE }));
    const { onDone } = await start({
      accountsResignSeat: resign,
      accountsResignStatus: () =>
        Promise.resolve({ state: "failed", error: "different-account", expectedEmail: "me@example.com", gotEmail: "other@example.com" }),
    });
    await advance(POLL);
    expect(text()).toContain("You signed in as other@example.com, but this seat is me@example.com. Sign in with me@example.com.");
    expect(onDone).not.toHaveBeenCalled();
    await press(dialogButton("Try again"));
    expect(resign).toHaveBeenCalledTimes(2); // Try again restarts the flow
  });

  it.each(["login-failed", "unknown-flow"])("%s: says the sign-in didn't complete and Try again restarts", async (error) => {
    const resign = vi.fn(() => Promise.resolve({ flowId: "f1", connect: DEVICE }));
    await start({ accountsResignSeat: resign, accountsResignStatus: () => Promise.resolve({ state: "failed", error }) });
    await advance(POLL);
    expect(text()).toContain("Sign-in didn't complete");
    expect(text()).toContain("Seat 3 was not changed");
    await press(dialogButton("Try again"));
    expect(resign).toHaveBeenCalledTimes(2);
    await advance(POLL);
    expect(text()).toContain("Sign-in didn't complete"); // still reported on the retry
  });

  it("a start error from the box is shown with the shared accounts message", async () => {
    await start({ accountsResignSeat: () => Promise.resolve({ error: "unknown-seat" }) });
    expect(text()).toContain("That seat no longer exists");
    expect(dialogButton("Try again")).toBeTruthy();
  });

  it("an unreachable box on start is reported, not swallowed", async () => {
    await start({ accountsResignSeat: () => Promise.reject(new Error("down")) });
    expect(text()).toContain("Couldn't reach the server");
  });

  it("an unsupported sign-in shape fails visibly and hands the flow back to the box", async () => {
    const cancel = vi.fn(() => Promise.resolve({ ok: true }));
    await start({
      accountsResignSeat: () => Promise.resolve({ flowId: "f9", connect: { shape: "api-key" } }),
      accountsResignCancel: cancel,
    });
    expect(text()).toContain("can't be started from here");
    expect(cancel).toHaveBeenCalledWith({ flowId: "f9" });
  });

  it("Cancel (×) calls resign-cancel for the flow, closes, and says the seat was not changed", async () => {
    const cancel = vi.fn(() => Promise.resolve({ ok: true }));
    const { onCancel } = await start({ accountsResignCancel: cancel });
    await press(document.body.querySelector('button[aria-label="Cancel"]'));
    expect(cancel).toHaveBeenCalledWith({ flowId: "f1" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(useStore.getState().appToasts)).toContain("Seat 3 was not changed");
  });

  it("Escape cancels the flow the same way", async () => {
    const cancel = vi.fn(() => Promise.resolve({ ok: true }));
    const { onCancel } = await start({ accountsResignCancel: cancel });
    await act(async () => {
      document.body.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await advance(0);
    expect(cancel).toHaveBeenCalledWith({ flowId: "f1" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a cancel the box could not take is reported, and the modal still closes", async () => {
    const { onCancel } = await start({ accountsResignCancel: () => Promise.reject(new Error("boom")) });
    await press(document.body.querySelector('button[aria-label="Cancel"]'));
    expect(onCancel).toHaveBeenCalled();
    const toasts = JSON.stringify(useStore.getState().appToasts);
    expect(toasts).toContain("Couldn't cancel");
    expect(toasts).toContain("Seat 3 was not changed");
  });

  it("closing after a failure does not call resign-cancel (nothing is open) and needs no toast", async () => {
    const cancel = vi.fn(() => Promise.resolve({ ok: true }));
    const { onCancel } = await start({
      accountsResignCancel: cancel,
      accountsResignStatus: () => Promise.resolve({ state: "failed", error: "login-failed" }),
    });
    await advance(POLL);
    await press(dialogButton("Close"));
    expect(cancel).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  it("Claude: pastes the code into the terminal; a sign-in that exits with an error fails at once and drops the flow", async () => {
    let ptyCb: ((e: unknown) => void) | null = null;
    const cancel = vi.fn(() => Promise.resolve({ ok: true }));
    await start({
      accountsResignSeat: () => Promise.resolve({ flowId: "f2", connect: CLAUDE }),
      accountsResignCancel: cancel,
      ptyWrite: () => Promise.resolve(),
      onPtyEvent: (cb: (e: unknown) => void) => {
        ptyCb = cb;
        return () => {};
      },
    });
    expect(document.body.querySelector('input[placeholder="paste the code"]')).toBeTruthy();
    await act(async () => ptyCb?.({ kind: "exit", sessionKey: "claude-login-k", code: 1 }));
    await advance(0);
    expect(text()).toContain("That code didn't work");
    expect(text()).toContain("Seat 3 was not changed");
    expect(cancel).toHaveBeenCalledWith({ flowId: "f2" });
  });
});
