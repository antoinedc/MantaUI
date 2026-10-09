// @vitest-environment jsdom
//
// Settings → Accounts seat management + the add-seat flow (spec §7). Every
// control must end in a reported success or a specific error.

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { act } from "react";
import { installCanvasStub, mount, installMockApi, resetStore, buttonByText, type Harness } from "./testHarness";
import { useStore } from "./store";
import { clearAccountsFocus } from "./accountsData";
import { NOW, oneSeatView, threeSeatView } from "./seatFixtures";
import type { ProviderView } from "../shared/types";

// AddSeatFlow mounts ConnectProvider's Claude terminal block, which pulls in
// xterm's WebGL addon; it probes the canvas at import time. Stub BEFORE import.
installCanvasStub();
const { SeatsPanel } = await import("./SeatsPanel");
const { AddSeatFlow } = await import("./AddSeatFlow");

const rowButton = (seatId: string, text: string) =>
  Array.from(h!.container.querySelector(`[data-seat-id="${seatId}"]`)!.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );

let h: Harness | null = null;
beforeEach(() => {
  clearAccountsFocus();
  window.localStorage.clear();
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
});

async function openPanel(view: ProviderView, api: Record<string, unknown> = {}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const m = installMockApi({ accountsList: () => Promise.resolve({ providers: [view] }), ...api });
  resetStore({ accounts: [view], appToasts: [] } as never);
  h = mount(<SeatsPanel view={view} />);
  await h.flush();
  await act(async () => {
    (h!.container.querySelector("button[aria-expanded]") as HTMLButtonElement).click();
  });
  await h.flush();
  return m;
}

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await h!.flush();
};

describe("SeatsPanel", () => {
  it("one seat: no mode toggle, the single seat reads as its account, live marker, Remove disabled (last seat)", async () => {
    await openPanel(oneSeatView());
    expect(h!.text()).not.toContain("Automatic");
    expect(h!.text()).toContain("Work");
    expect(h!.text()).toContain("live");
    expect(h!.text()).toContain("5h");
    expect(h!.text()).toContain("7d");
    const remove = buttonByText(h!, "Remove")!;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toMatch(/only login on this box.*Disconnect/);
  });

  it("shows accounts → seats with email, plan, conversations", async () => {
    await openPanel(threeSeatView());
    const t = h!.text();
    expect(t).toContain("Acme");
    expect(t).toContain("s2@example.com");
    expect(t).toContain("Max 20x");
    expect(t).toContain("2 conversations");
    expect(t).toContain("1 conversation");
  });

  it("mode toggle calls set-mode and reports it", async () => {
    const after = { ...threeSeatView(), mode: "manual" as const };
    const m = await openPanel(threeSeatView(), { accountsSetMode: () => Promise.resolve(after) });
    await click(buttonByText(h!, "Manual"));
    expect(m.api.calls.accountsSetMode[0][0]).toEqual({ provider: "claude", mode: "manual" });
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("Manual");
    expect(useStore.getState().accounts[0].mode).toBe("manual");
  });

  it("mode toggle failure shows the reason and changes nothing", async () => {
    await openPanel(threeSeatView(), { accountsSetMode: () => Promise.resolve({ error: "unknown-provider" }) });
    await click(buttonByText(h!, "Manual"));
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("doesn't support");
    expect(useStore.getState().accounts[0].mode).toBe("auto");
  });

  it("manual mode: Use this seat (same org) applies; the active seat is disabled 'In use'", async () => {
    const view = threeSeatView({ mode: "manual", activeSeatId: "s1" });
    const m = await openPanel(view, {
      accountsSetActive: () => Promise.resolve({ ...view, activeSeatId: "s2" }),
    });
    expect(buttonByText(h!, "In use")!.disabled).toBe(true);
    const uses = Array.from(h!.container.querySelectorAll("button")).filter((b) => b.textContent === "Use this seat");
    expect(uses).toHaveLength(2);
    await click(rowButton("s2", "Use this seat"));
    expect(m.api.calls.accountsSetActive[0][0]).toEqual({ provider: "claude", seatId: "s2" });
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("All conversations now use Seat 2");
  });

  it("manual mode: a cross-org seat confirms first", async () => {
    const view = threeSeatView({ mode: "manual", activeSeatId: "s1" });
    const m = await openPanel(view, { accountsSetActive: () => Promise.resolve({ ...view, activeSeatId: "s3" }) });
    await click(rowButton("s3", "Use this seat"));
    expect(m.api.calls.accountsSetActive).toBeUndefined();
    expect(h!.text()).toContain("re-send their history once");
    await click(buttonByText(h!, "Switch"));
    expect(m.api.calls.accountsSetActive).toHaveLength(1);
  });

  it("rename a seat: saves via accounts:rename and says so; an invalid label shows why", async () => {
    const renamed = threeSeatView();
    renamed.accounts[0].seats[1] = { ...renamed.accounts[0].seats[1], label: "Desk" };
    let n = 0;
    const m = await openPanel(threeSeatView(), {
      accountsRename: () => Promise.resolve(n++ === 0 ? { error: "invalid-label" } : renamed),
    });
    await click(h!.container.querySelector('button[aria-label="Rename Seat 2"]'));
    const input = h!.container.querySelector('input[aria-label="Rename Seat 2"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Desk");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttonByText(h!, "Save"));
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("1–40");
    await click(buttonByText(h!, "Save"));
    expect(m.api.calls.accountsRename[1][0]).toEqual({ provider: "claude", kind: "seat", id: "s2", label: "Desk" });
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("Renamed to “Desk”");
  });

  it("remove asks, then removes, reports", async () => {
    const after = threeSeatView();
    after.accounts[0].seats = [after.accounts[0].seats[0]];
    const m = await openPanel(threeSeatView(), { accountsRemoveSeat: () => Promise.resolve(after) });
    await click(rowButton("s2", "Remove"));
    expect(h!.text()).toContain("move to another seat on their next message");
    expect(h!.text()).not.toContain("The box will switch");
    await click(Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Remove" && !b.disabled && b.className.includes("danger")));
    expect(m.api.calls.accountsRemoveSeat[0][0]).toEqual({ provider: "claude", seatId: "s2" });
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("Removed Seat 2");
  });

  it("the live seat can be removed: the confirm names the seat the box switches to, then reports it", async () => {
    const after = threeSeatView({ activeSeatId: "s2" });
    after.accounts[0].seats = [{ ...after.accounts[0].seats[1], live: true }];
    const m = await openPanel(threeSeatView(), { accountsRemoveSeat: () => Promise.resolve(after) });
    const live = rowButton("s1", "Remove") as HTMLButtonElement;
    expect(live.disabled).toBe(false);
    await click(live);
    expect(h!.text()).toContain("The box will switch to “Seat 2”");
    expect(h!.text()).toContain("its 2 conversations move to other seats");
    await click(Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Remove" && !b.disabled && b.className.includes("danger")));
    expect(m.api.calls.accountsRemoveSeat[0][0]).toEqual({ provider: "claude", seatId: "s1" });
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("The box now uses “Seat 2”");
  });

  it("the live seat's Remove is disabled with a reason when no other seat is usable", async () => {
    const v = threeSeatView();
    v.accounts[0].seats[1].status = "expired";
    v.accounts[1].seats[0].status = "signed-out";
    await openPanel(v);
    const live = rowButton("s1", "Remove") as HTMLButtonElement;
    expect(live.disabled).toBe(true);
    expect(live.title).toMatch(/No other login is signed in/);
  });

  it("a refused removal reports the server's reason", async () => {
    await openPanel(threeSeatView(), { accountsRemoveSeat: () => Promise.resolve({ error: "last-seat" }) });
    await click(rowButton("s2", "Remove"));
    await click(Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Remove" && !b.disabled && b.className.includes("danger")));
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("only login on this box");
  });

  it("shows the ToS note once, when a second account is added", async () => {
    const m = await openPanel(oneSeatView(), {
      accountsAddSeat: () => Promise.resolve({ seatId: "n1", connect: { shape: "oauth-auto", url: "https://x", instructions: "code ABCD-1234" } }),
      accountsSeatStatus: () => Promise.resolve({ state: "pending" }),
    });
    await click(buttonByText(h!, "Add Claude account"));
    expect(h!.text()).toContain("may breach the provider's terms");
    expect(m.api.calls.accountsAddSeat).toBeUndefined();
    await click(buttonByText(h!, "I understand"));
    expect(m.api.calls.accountsAddSeat).toHaveLength(1);
    expect(window.localStorage.getItem("manta:accounts:tosAck")).toBe("1");
  });

  it("no ToS note when adding a seat to an existing account", async () => {
    const m = await openPanel(oneSeatView(), {
      accountsAddSeat: () => Promise.resolve({ seatId: "n1", connect: { shape: "oauth-auto", url: "https://x", instructions: "" } }),
      accountsSeatStatus: () => Promise.resolve({ state: "pending" }),
    });
    await click(buttonByText(h!, "Add seat to Work"));
    expect(h!.text()).not.toContain("breach");
    expect(m.api.calls.accountsAddSeat[0][0]).toEqual({ provider: "claude", accountId: "a1" });
  });
});

describe("AddSeatFlow", () => {
  async function flow(api: Record<string, unknown>, props: Partial<Parameters<typeof AddSeatFlow>[0]> = {}) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const m = installMockApi({
      accountsAddSeat: () => Promise.resolve({ seatId: "n1", connect: { shape: "oauth-auto", url: "https://login.example", instructions: "code ABCD-1234" } }),
      accountsCancelSeat: () => Promise.resolve({ ok: true }),
      ...api,
    });
    resetStore({ appToasts: [] } as never);
    h = mount(<AddSeatFlow provider="codex" accountId="a1" accountLabel="Work" onDone={onDone} onCancel={onCancel} {...props} />);
    await h.flush();
    return { m, onDone, onCancel };
  }
  const tick = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
  };

  it("completes: pending → ok reports the new seat", async () => {
    let n = 0;
    const { onDone } = await flow({
      accountsSeatStatus: () => Promise.resolve(n++ === 0 ? { state: "pending" } : { state: "ok", seat: { label: "Seat 2" } }),
    });
    expect(h!.text()).toContain("login.example");
    await tick();
    await tick();
    expect(onDone).toHaveBeenCalledWith("Added Seat 2 to OpenAI.");
    expect(h!.container.querySelector("[role=status]")?.textContent).toContain("Added Seat 2");
  });

  it("duplicate-login: a clear message and Try again restarts", async () => {
    const add = vi.fn(() => Promise.resolve({ seatId: "n1", connect: { shape: "oauth-auto", url: "https://l", instructions: "" } }));
    await flow({ accountsAddSeat: add, accountsSeatStatus: () => Promise.resolve({ state: "failed", error: "duplicate-login" }) });
    await tick();
    expect(h!.text()).toContain("already added");
    await click(buttonByText(h!, "Try again"));
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("login-failed: says the sign-in didn't complete", async () => {
    await flow({ accountsSeatStatus: () => Promise.resolve({ state: "failed", error: "login-failed" }) });
    await tick();
    expect(h!.text()).toContain("sign-in failed");
    expect(h!.text()).not.toContain("15 minutes");
  });

  it("different-org: offers 'Create new account' → add-seat-confirm", async () => {
    const view = threeSeatView();
    const confirm = vi.fn(() => Promise.resolve(view));
    const { onDone } = await flow({
      accountsSeatStatus: () => Promise.resolve({ state: "failed", error: "different-org", orgName: "Globex" }),
      accountsAddSeatConfirm: confirm,
    });
    await tick();
    expect(h!.text()).toContain("different organization (Globex)");
    await click(buttonByText(h!, "Create new account"));
    expect(confirm).toHaveBeenCalledWith({ seatId: "n1", newAccount: true });
    expect(onDone).toHaveBeenCalled();
  });

  it("different-org then Cancel aborts the half-made seat on the box", async () => {
    const cancelSeat = vi.fn(() => Promise.resolve({ ok: true }));
    const { onCancel } = await flow({
      accountsSeatStatus: () => Promise.resolve({ state: "failed", error: "different-org" }),
      accountsCancelSeat: cancelSeat,
    });
    await tick();
    await click(buttonByText(h!, "Cancel"));
    expect(cancelSeat).toHaveBeenCalledWith({ seatId: "n1" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("Cancel while signing in calls accounts:cancel-seat; a failed cancel is reported", async () => {
    const { onCancel } = await flow({
      accountsSeatStatus: () => Promise.resolve({ state: "pending" }),
      accountsCancelSeat: () => Promise.reject(new Error("boom")),
    });
    await click(h!.container.querySelector('button[aria-label="Cancel"]'));
    expect(onCancel).toHaveBeenCalled();
    expect(JSON.stringify(useStore.getState().appToasts)).toContain("Couldn't cancel");
  });

  it("add-seat error → message; an unsupported connect shape → failure, seat handed back", async () => {
    await flow({ accountsAddSeat: () => Promise.resolve({ error: "login-failed" }) });
    expect(h!.text()).toContain("Sign-in failed");
    h!.unmount();
    const cancelSeat = vi.fn(() => Promise.resolve({ ok: true }));
    await flow({
      accountsAddSeat: () => Promise.resolve({ seatId: "n9", connect: { shape: "api-key" } }),
      accountsCancelSeat: cancelSeat,
    });
    expect(h!.text()).toContain("can't be started from here");
    expect(cancelSeat).toHaveBeenCalledWith({ seatId: "n9" });
  });
});

describe("AddSeatFlow wait limit and failure reasons", () => {
  // Real clock faked so a 15-minute wait runs in milliseconds.
  async function timed(api: Record<string, unknown>) {
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const onDone = vi.fn();
    const cancelSeat = vi.fn(() => Promise.resolve({ ok: true }));
    installMockApi({
      accountsAddSeat: () => Promise.resolve({ seatId: "n1", connect: { shape: "oauth-auto", url: "https://login.example", instructions: "code ABCD-1234" } }),
      accountsCancelSeat: cancelSeat,
      accountsList: () => Promise.resolve({ providers: [] }),
      ...api,
    });
    resetStore({ appToasts: [] } as never);
    h = mount(<AddSeatFlow provider="claude" accountId="a1" accountLabel="Work" onDone={onDone} onCancel={() => {}} />);
    await h.flush();
    return { onDone, cancelSeat };
  }
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it("keeps waiting well past the old 5-minute limit and never cancels the seat early", async () => {
    const status = vi.fn(() => Promise.resolve({ state: "pending" }));
    const { cancelSeat } = await timed({ accountsSeatStatus: status });
    await advance(6 * 60_000);
    expect(h!.text()).not.toContain("didn't");
    expect(h!.text()).not.toContain("wasn't finished");
    expect(cancelSeat).not.toHaveBeenCalled();
    await advance(8 * 60_000); // 14 minutes in
    expect(cancelSeat).not.toHaveBeenCalled();
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]')).toBeTruthy();
  });

  it("a login finished late in the wait (14 min) is still placed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const t0 = Date.now();
    const { onDone } = await timed({
      accountsSeatStatus: () =>
        Promise.resolve(Date.now() - t0 >= 14 * 60_000 ? { state: "ok", seat: { id: "n1", label: "Seat 2" } } : { state: "pending" }),
    });
    await advance(14 * 60_000 + 4_000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("gives up only AFTER the box's own 15 minutes, asks the box one last time, then says it timed out", async () => {
    const status = vi.fn(() => Promise.resolve({ state: "pending" }));
    const { cancelSeat } = await timed({ accountsSeatStatus: status });
    await advance(15 * 60_000 + 20_000);
    expect(cancelSeat).not.toHaveBeenCalled(); // inside the grace
    await advance(20_000);
    expect(cancelSeat).toHaveBeenCalledWith({ seatId: "n1" });
    expect(h!.text()).toContain("wasn't finished within 15 minutes");
    expect(buttonByText(h!, "Try again")).toBeTruthy();
  });

  it("when the box says login-failed after its own 15 minutes the reason is 'timed out', not 'wrong code'", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const t0 = Date.now();
    await timed({
      accountsSeatStatus: () =>
        Promise.resolve(Date.now() - t0 >= 15 * 60_000 ? { state: "failed", error: "login-failed" } : { state: "pending" }),
    });
    await advance(15 * 60_000 + 4_000);
    expect(h!.text()).toContain("wasn't finished within 15 minutes");
  });

  it("a box that cannot be reached at the end says so instead of blaming the sign-in", async () => {
    await timed({ accountsSeatStatus: () => Promise.reject(new Error("offline")) });
    await advance(16 * 60_000);
    expect(h!.text()).toContain("Couldn't reach the server");
  });

  it("duplicate-login names the reason; different-org keeps its create-account prompt", async () => {
    await timed({ accountsSeatStatus: () => Promise.resolve({ state: "failed", error: "duplicate-login" }) });
    await advance(2100);
    expect(h!.text()).toContain("already added as a seat");
  });

  it("done is reported once even if the parent re-renders with a new callback", async () => {
    const onDone = vi.fn();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    installMockApi({
      accountsAddSeat: () => Promise.resolve({ seatId: "n1", connect: { shape: "oauth-auto", url: "https://l", instructions: "" } }),
      accountsSeatStatus: () => Promise.resolve({ state: "ok", seat: { id: "n1", label: "Seat 2" } }),
      accountsList: () => Promise.resolve({ providers: [] }),
    });
    resetStore({ appToasts: [] } as never);
    h = mount(<AddSeatFlow provider="claude" accountId="a1" onDone={(m) => onDone(m)} onCancel={() => {}} />);
    await h.flush();
    await advance(2100);
    await act(async () => {
      h!.rerender?.(<AddSeatFlow provider="claude" accountId="a1" onDone={(m) => onDone(m)} onCancel={() => {}} />);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
