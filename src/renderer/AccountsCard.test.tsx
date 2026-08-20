// @vitest-environment jsdom
//
// Component tests for the Accounts card's "Try again" action (BET-1250).
// AGENTS.md's NEVER-STUB rule: the button must report BOTH outcomes — a cleared
// out-of-credit flag and a still-refused one — never silently no-op. Distilled
// to the assertions that matter here; the pure state/eligibility mapping is
// covered in AccountsCard.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, installMockApi, type Harness, type MockApi } from "./testHarness";
import { AccountsCard } from "./AccountsCard";

function statusProvider() {
  return {
    action: "status" as const,
    providers: [
      { id: "anthropic", label: "Claude", plan: "Max 20x", console: null, docs: "", connected: true },
    ],
  };
}

async function underOutOfCredit(accountsRetry: MockApi["accountsRetry"]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  installMockApi({
    opencodeProviderAuth: () => Promise.resolve(statusProvider()),
    opencodeGetProviders: () => Promise.resolve([]),
    accountHealth: () => Promise.resolve({ anthropic: { state: "out-of-credit" } }),
    configGet: () => Promise.resolve({}),
    opencodeSetProviders: () => Promise.resolve({ ok: true }),
    opencodeDiscoverModels: () => Promise.resolve({ ok: true, models: [] }),
    accountsRetry,
  });
  const h = mount(<AccountsCard />);
  await h.flush();
  return h;
}

function buttonByText(h: Harness, text: string): HTMLButtonElement | null {
  for (const b of Array.from(h.container.querySelectorAll("button"))) {
    if ((b.textContent ?? "").trim() === text) return b;
  }
  return null;
}

describe("AccountsCard Try again (out-of-credit)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("shows 'Out of credit' and a Try again action when a row is out of credit", async () => {
    h = await underOutOfCredit(() => Promise.resolve({ ok: true, state: "ok", message: "cleared" }));
    expect(h.container.textContent).toContain("Out of credit");
    expect(buttonByText(h, "Try again")).toBeTruthy();
  });

  it("reports a cleared flag (never silent)", async () => {
    const spy = vi.fn(() =>
      Promise.resolve({ ok: true, state: "ok", message: "anthropic is back in the pool (out-of-credit flag cleared)." }),
    );
    h = await underOutOfCredit(spy);
    const btn = buttonByText(h, "Try again");
    expect(btn).toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await h.flush();
    expect(spy).toHaveBeenCalledWith("anthropic");
    expect(h.container.textContent).toContain("back in the pool");
  });

  it("reports a still-refused outcome (never silent)", async () => {
    const spy = vi.fn(() =>
      Promise.resolve({ ok: false, state: "out-of-credit", message: "anthropic still reports out of credit — check the account." }),
    );
    h = await underOutOfCredit(spy);
    const btn = buttonByText(h, "Try again");
    expect(btn).toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await h.flush();
    expect(h.container.textContent).toContain("still reports out of credit");
  });

  it("renders no Try again on a rate-limited row (it recovers on its own)", async () => {
    h = await underOutOfCredit(() => Promise.resolve({ ok: true, state: "ok", message: "x" }));
    // Re-mount with rate-limited health.
    h.unmount();
    installMockApi({
      opencodeProviderAuth: () => Promise.resolve(statusProvider()),
      opencodeGetProviders: () => Promise.resolve([]),
      accountHealth: () =>
        Promise.resolve({ anthropic: { state: "rate-limited", retryInMs: 12 * 60 * 1000 } }),
      configGet: () => Promise.resolve({}),
      opencodeSetProviders: () => Promise.resolve({ ok: true }),
      opencodeDiscoverModels: () => Promise.resolve({ ok: true, models: [] }),
      accountsRetry: () => Promise.resolve({ ok: true, state: "ok", message: "x" }),
    });
    h = mount(<AccountsCard />);
    await h.flush();
    expect(h.container.textContent).toContain("Rate limited · retry in 12m");
    expect(buttonByText(h, "Try again")).toBeNull();
  });
});
