// @vitest-environment jsdom
//
// The Accounts list's "add an account" paths (multi-account spec §7).
//
// The incident these pin: a user with seats pressed the subscription row's
// Connect to add a SEPARATE account. That started the OLD live-login flow, which
// replaced the box's own login and showed nothing in the seat list. Now:
//   - a provider with seats routes Connect to the seat flow (never a live login);
//   - the terms note sits INLINE with the action and proceeds into the sign-in;
//   - success closes the panel, the list is already refreshed, and a line names
//     what was added — nobody has to reload anything.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, mount, installMockApi, resetStore, buttonByText, type Harness } from "./testHarness";
import { invalidateCachedResource } from "./useCachedResource";
import { useStore } from "./store";
import { clearAccountsFocus } from "./accountsData";
import { NOW, oneSeatView, seat } from "./seatFixtures";
import type { ProviderView } from "../shared/types";

installCanvasStub();
const { AccountsCard } = await import("./AccountsCard");

let h: Harness | null = null;
beforeEach(() => {
  clearAccountsFocus();
  window.localStorage.clear();
  invalidateCachedResource("accounts");
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DEVICE_CONNECT = { shape: "oauth-auto", url: "https://login.example", instructions: "code ABCD-1234" };

/** `oneSeatView()` plus a second account "Zeta" holding one seat. */
function withSecondAccount(): ProviderView {
  const v = oneSeatView();
  v.accounts.push({ id: "a2", label: "Zeta", orgName: "Zeta", plan: "Pro", seats: [seat("s2", "Seat 1", 5, 5, { email: "z@example.com" })] });
  return v;
}
/** `oneSeatView()` with a second seat in the same account. */
function withSecondSeat(): ProviderView {
  const v = oneSeatView();
  v.accounts[0].seats.push(seat("s2", "Seat 2", 8, 8));
  return v;
}

async function mountCard(opts: {
  connected: boolean;
  views: () => ProviderView[];
  api?: Record<string, unknown>;
}) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const providerAuth = vi.fn((req: { action: string }) =>
    Promise.resolve(
      req.action === "status"
        ? {
            action: "status" as const,
            providers: [{ id: "anthropic", label: "Claude", plan: "Max 20x", console: null, docs: "", connected: opts.connected }],
          }
        : req.action === "start"
          ? { action: "start" as const, ...DEVICE_CONNECT, methodIndex: 0 }
          : { action: req.action, ok: true },
    ),
  );
  const m = installMockApi({
    opencodeProviderAuth: providerAuth,
    opencodeGetProviders: () => Promise.resolve([]),
    accountHealth: () => Promise.resolve({ providers: {}, endpoints: {} }),
    configGet: () => Promise.resolve({}),
    accountsList: () => Promise.resolve({ providers: opts.views() }),
    usageList: () => Promise.resolve([]),
    accountsCancelSeat: () => Promise.resolve({ ok: true }),
    accountsAddSeat: () => Promise.resolve({ seatId: "n1", connect: DEVICE_CONNECT }),
    ...(opts.api ?? {}),
  });
  resetStore({ accounts: [], usage: [], appToasts: [] } as never);
  h = mount(<AccountsCard />);
  await h.flush();
  return { m, providerAuth };
}

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await h!.flush();
};
const tick = async (ms = 2100) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await h!.flush();
};
const authActions = (providerAuth: ReturnType<typeof vi.fn>) => providerAuth.mock.calls.map((c) => (c[0] as { action: string }).action);

describe("subscription row Connect, with seats", () => {
  it("opens the SEAT flow for a new account — never the old live-login connect", async () => {
    const { m, providerAuth } = await mountCard({ connected: false, views: () => [oneSeatView()] });
    await click(buttonByText(h!, "Connect"));
    // The terms note first (a second account), inline; then the seat sign-in.
    expect(h!.text()).toContain("may breach the provider's terms");
    expect(m.api.calls.accountsAddSeat).toBeUndefined();
    await click(buttonByText(h!, "I understand"));
    expect(m.api.calls.accountsAddSeat).toHaveLength(1);
    expect(m.api.calls.accountsAddSeat[0][0]).toEqual({ provider: "claude", accountId: undefined });
    expect(authActions(providerAuth)).not.toContain("start");
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]')).toBeTruthy();
    expect(h!.text()).toContain("Add a Claude account");
  });

  it("a provider WITHOUT seats still uses the live connect (the live login is its first seat)", async () => {
    const { m, providerAuth } = await mountCard({ connected: false, views: () => [] });
    await click(buttonByText(h!, "Connect"));
    expect(authActions(providerAuth)).toContain("start");
    expect(m.api.calls.accountsAddSeat).toBeUndefined();
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]')).toBeNull();
  });

  it("the seat list is shown even while the live login reads as not connected", async () => {
    await mountCard({ connected: false, views: () => [oneSeatView()] });
    expect(h!.text()).toContain("Claude accounts & seats (1)");
  });

  it("new account succeeds: the panel closes, the list shows it at once, a line names it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let views: ProviderView[] = [oneSeatView()];
    let polls = 0;
    const { m } = await mountCard({
      connected: true,
      views: () => views,
      api: {
        accountsSeatStatus: () => {
          if (polls++ === 0) return Promise.resolve({ state: "pending" });
          views = [withSecondAccount()]; // the box placed it
          return Promise.resolve({ state: "ok", seat: { id: "s2", label: "Seat 1", email: "z@example.com" } });
        },
      },
    });
    // Connected + seats: the row has no Connect; the panel's Add account is the way in.
    await click(h!.container.querySelector("button[aria-expanded]"));
    await click(buttonByText(h!, "Add Claude account"));
    await click(buttonByText(h!, "I understand"));
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]')).toBeTruthy();
    await tick();
    await tick();
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]'), "panel closed").toBeNull();
    expect(h!.text()).toContain("Added the account “Zeta”");
    expect(h!.text()).toContain("z@example.com");
    // The list already shows it (no manual refresh): the store has it and so does the DOM.
    expect(useStore.getState().accounts[0].accounts.map((a) => a.label)).toContain("Zeta");
    expect(h!.container.querySelector('[data-account-id="a2"]') ?? h!.container.querySelector('[data-seat-id="s2"]')).toBeTruthy();
    expect(h!.text()).toContain("Claude accounts & seats (2)");
    expect(m.api.calls.usageList?.length ?? 0).toBeGreaterThan(0);
  });

  it("Connect on the row: success closes the panel, refreshes the list and says what was added", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let views: ProviderView[] = [oneSeatView()];
    const { providerAuth } = await mountCard({
      connected: false,
      views: () => views,
      api: {
        accountsSeatStatus: () => {
          views = [withSecondAccount()];
          return Promise.resolve({ state: "ok", seat: { id: "s2", label: "Seat 1", email: "z@example.com" } });
        },
      },
    });
    await click(buttonByText(h!, "Connect"));
    await click(buttonByText(h!, "I understand"));
    await tick();
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]'), "panel closed").toBeNull();
    expect(h!.container.querySelector('[data-testid="seat-notice-anthropic"]')?.textContent).toContain("Added the account “Zeta”");
    expect(h!.text()).toContain("Claude accounts & seats (2)");
    expect(h!.text()).toContain("Zeta"); // the panel opened onto the new account
    expect(authActions(providerAuth)).not.toContain("start");
  });
});

describe("Add account / Add seat in the seats panel", () => {
  async function openPanel(views: () => ProviderView[], api: Record<string, unknown> = {}) {
    const r = await mountCard({ connected: true, views, api });
    await click(h!.container.querySelector("button[aria-expanded]"));
    return r;
  }

  it("the terms note is inline WITH the button: the button stays, 'I understand' goes straight into the sign-in", async () => {
    const { m } = await openPanel(() => [oneSeatView()]);
    const add = buttonByText(h!, "Add Claude account");
    expect(add).toBeTruthy();
    await click(add);
    expect(h!.container.querySelector('[data-testid="add-seat-tos"]')).toBeTruthy();
    expect(buttonByText(h!, "Add Claude account"), "the action is not hidden by the note").toBeTruthy();
    expect(m.api.calls.accountsAddSeat).toBeUndefined();
    await click(buttonByText(h!, "I understand"));
    expect(m.api.calls.accountsAddSeat).toHaveLength(1);
    expect(window.localStorage.getItem("manta:accounts:tosAck")).toBe("1");
    expect(h!.container.querySelector('[data-testid="add-seat-tos"]')).toBeNull();
  });

  it("once acknowledged the note is not shown again", async () => {
    window.localStorage.setItem("manta:accounts:tosAck", "1");
    const { m } = await openPanel(() => [oneSeatView()]);
    await click(buttonByText(h!, "Add Claude account"));
    expect(h!.container.querySelector('[data-testid="add-seat-tos"]')).toBeNull();
    expect(m.api.calls.accountsAddSeat).toHaveLength(1);
  });

  it("Cancel on the note closes it without starting anything", async () => {
    const { m } = await openPanel(() => [oneSeatView()]);
    await click(buttonByText(h!, "Add Claude account"));
    await click(buttonByText(h!, "Cancel"));
    expect(h!.container.querySelector('[data-testid="add-seat-tos"]')).toBeNull();
    expect(m.api.calls.accountsAddSeat).toBeUndefined();
    expect(buttonByText(h!, "Add Claude account")!.disabled).toBe(false);
  });

  it("new seat in an existing account succeeds: panel closes, the list shows it, a line names it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let views: ProviderView[] = [oneSeatView()];
    await openPanel(() => views, {
      accountsSeatStatus: () => {
        views = [withSecondSeat()];
        return Promise.resolve({ state: "ok", seat: { id: "s2", label: "Seat 2", email: "s2@example.com" } });
      },
    });
    await click(buttonByText(h!, "Add seat to Work"));
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]')).toBeTruthy();
    await tick();
    expect(h!.container.querySelector('[data-testid="add-seat-flow"]'), "panel closed").toBeNull();
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("Added Seat 2 to Work.");
    expect(h!.container.querySelector('[data-seat-id="s2"]')).toBeTruthy();
    expect(h!.text()).toContain("Claude accounts & seats (2)");
  });
});
