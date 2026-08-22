// @vitest-environment jsdom
//
// Component tests for the Accounts card's "Try again" action (BET-1250).
// AGENTS.md's NEVER-STUB rule: the button must report BOTH outcomes — a cleared
// out-of-credit flag and a still-refused one — never silently no-op. Distilled
// to the assertions that matter here; the pure state/eligibility mapping is
// covered in AccountsCard.test.ts.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, installMockApi, clickCheckbox, type Harness, type MockApi } from "./testHarness";
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

function checkboxByLabel(h: Harness, label: string): HTMLInputElement | null {
  return (
    (Array.from(h.container.querySelectorAll('input[type="checkbox"]')).find(
      (i) => i.getAttribute("aria-label") === label,
    ) as HTMLInputElement | null) ?? null
  );
}

// Mount the card with ONE custom endpoint ("voska", enabled blend "alpha") whose
// discovery reports ["alpha","beta"]. `opencodeGetProviders`/`setProviders` are
// stateful so a re-tick actually sticks for the next read.
function customProviderSetup(overrides: Record<string, unknown> = {}) {
  let providerState: {
    id: string;
    name: string;
    baseURL: string;
    hasApiKey: boolean;
    enabledModels: string[];
  }[] = [
    { id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1", hasApiKey: true, enabledModels: ["alpha"] },
  ];
  const { api } = installMockApi({
    opencodeProviderAuth: () => Promise.resolve({ action: "status" as const, providers: [] }),
    opencodeGetProviders: () => Promise.resolve(providerState),
    accountHealth: () => Promise.resolve({}),
    configGet: () => Promise.resolve({}),
    opencodeSetProviders: (input: {
      upsert?: { id: string; name?: string; baseURL?: string; enabledModels: string[] }[];
    }) => {
      const u = input?.upsert?.[0];
      if (u) providerState = providerState.map((p) => (p.id === u.id ? { ...p, ...u } : p));
      return Promise.resolve({ ok: true });
    },
    opencodeDiscoverModels: () =>
      Promise.resolve({ ok: true, models: [{ id: "alpha" }, { id: "beta" }] }),
    accountsRetry: () => Promise.resolve({ ok: true, state: "ok", message: "x" }),
    ...overrides,
  });
  const h = mount(<AccountsCard />);
  return { h, api, getEnv: () => providerState };
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

describe("AccountsCard Refresh on a custom endpoint (9a/9b)", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  it("Refresh on a reachable endpoint renders the discovered models and a confirmation", async () => {
    const s = customProviderSetup();
    h = s.h;
    await h.flush();
    expect(h.container.textContent).toContain("VoskaAI");
    const btn = buttonByText(h, "Refresh");
    expect(btn).toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await h.flush();
    // discovered model that was NOT enabled renders
    expect(checkboxByLabel(h, "beta")).toBeTruthy();
    // confirmation naming how many were found
    expect(h.container.textContent).toContain("Discovered 2 models");
  });

  it("Refresh on an unreachable endpoint renders the error in text-danger and does not reject", async () => {
    const s = customProviderSetup({
      opencodeDiscoverModels: () =>
        Promise.resolve({ ok: false, error: "unauthorized", detail: "bad key" }),
    });
    h = s.h;
    await h.flush();
    const btn = buttonByText(h, "Refresh");
    expect(btn).toBeTruthy();
    // must not throw / leave an unhandled rejection
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await h.flush();
    const alert = h.container.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert!.textContent).toContain("unauthorized");
    expect((alert as HTMLElement).className).toContain("text-danger");
    // no false success confirmation
    expect(h.container.textContent).not.toContain("Discovered");
  });

  it("an unticked discovered model renders unchecked and can be re-ticked", async () => {
    const s = customProviderSetup();
    h = s.h;
    await h.flush();
    buttonByText(h, "Refresh")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await h.flush();
    const beta = checkboxByLabel(h, "beta");
    expect(beta).toBeTruthy();
    expect(beta!.checked).toBe(false);
    expect(checkboxByLabel(h, "alpha")!.checked).toBe(true);
    // re-tick it — the mutation must reach the box and stick on refetch
    clickCheckbox(h, "beta");
    await h.flush();
    expect(JSON.stringify(s.api.calls.opencodeSetProviders ?? [])).not.toBe("[]");
    expect(s.getEnv()[0].enabledModels).toContain("beta");
    expect(checkboxByLabel(h, "beta")!.checked).toBe(true);
  });
});

describe("AccountsCard Try-again tone by outcome (9c)", () => {
  it("failure renders in text-danger, success in text-ok", async () => {
    let h = await underOutOfCredit(() =>
      Promise.resolve({
        ok: false,
        state: "out-of-credit",
        message: "anthropic still reports out of credit — check the account.",
      }),
    );
    buttonByText(h, "Try again")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await h.flush();
    let status = h.container.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("still reports out of credit");
    expect((status as HTMLElement).className).toContain("text-danger");
    h.unmount();

    h = await underOutOfCredit(() =>
      Promise.resolve({ ok: true, state: "ok", message: "anthropic is back in the pool" }),
    );
    buttonByText(h, "Try again")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await h.flush();
    status = h.container.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("back in the pool");
    expect((status as HTMLElement).className).toContain("text-ok");
    h.unmount();
  });
});
