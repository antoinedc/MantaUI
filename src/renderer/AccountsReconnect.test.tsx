// @vitest-environment jsdom
//
// Destinations the chat error bar's Reconnect button lands on, in Settings →
// Accounts, for a provider with NO seat panel:
//   - Kimi (API key): Disconnect → Connect → paste a replacement key → saved.
//   - an externally managed Claude row: no Connect exists, so the row says what
//     to do instead of silently offering nothing.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { installCanvasStub, mount, installMockApi, resetStore, buttonByText, type Harness } from "./testHarness";
import { invalidateCachedResource } from "./useCachedResource";

installCanvasStub();
const { AccountsCard } = await import("./AccountsCard");

let h: Harness | null = null;
beforeEach(() => {
  invalidateCachedResource("accounts");
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.restoreAllMocks();
});

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await h!.flush();
};

type AuthReq = { action: string; id?: string; key?: string };

async function mountCard(statuses: () => Record<string, unknown>[], onAuth?: (req: AuthReq) => unknown) {
  const providerAuth = vi.fn((req: AuthReq) => {
    if (req.action === "status") return Promise.resolve({ action: "status" as const, providers: statuses() });
    return Promise.resolve(onAuth?.(req) ?? { action: req.action, ok: true });
  });
  installMockApi({
    opencodeProviderAuth: providerAuth,
    opencodeGetProviders: () => Promise.resolve([]),
    accountHealth: () => Promise.resolve({ providers: {}, endpoints: {} }),
    configGet: () => Promise.resolve({}),
    accountsList: () => Promise.resolve({ providers: [] }),
    usageList: () => Promise.resolve([]),
  });
  resetStore({ accounts: [], usage: [], appToasts: [] } as never);
  h = mount(<AccountsCard />);
  await h.flush();
  return providerAuth;
}

const kimi = (connected: boolean) => ({ id: "kimi-for-coding", label: "Kimi", plan: "", console: "https://kimi.example/keys", docs: "", connected });

describe("Accounts → Kimi recovery (Disconnect, then Connect with a replacement key)", () => {
  it("connected row offers Disconnect (not Connect); confirming disconnects and the row then offers Connect", async () => {
    let connected = true;
    const auth = await mountCard(
      () => [kimi(connected)],
      (req) => {
        if (req.action === "disconnect") connected = false;
        return undefined;
      },
    );
    expect(buttonByText(h!, "Connect")).toBeNull();
    await click(buttonByText(h!, "Disconnect"));
    await click(buttonByText(h!, "Disconnect")); // the inline confirm
    expect(auth.mock.calls.map((c) => c[0].action)).toContain("disconnect");
    expect(auth.mock.calls.find((c) => c[0].action === "disconnect")![0].id).toBe("kimi-for-coding");
    expect(buttonByText(h!, "Connect")).toBeTruthy();
  });

  it("Connect opens the API-key form and Save sends the replacement key", async () => {
    const auth = await mountCard(
      () => [kimi(false)],
      (req) => (req.action === "start" ? { action: "start", shape: "api-key" } : undefined),
    );
    await click(buttonByText(h!, "Connect"));
    const input = h!.container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "sk-new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(buttonByText(h!, "Save"));
    const keyCall = auth.mock.calls.find((c) => c[0].action === "key");
    expect(keyCall?.[0]).toEqual({ action: "key", id: "kimi-for-coding", key: "sk-new" });
  });
});

describe("Accounts → externally managed Claude row without a seat view", () => {
  const managed = {
    id: "anthropic",
    label: "Claude",
    plan: "Max 20x",
    console: null,
    docs: "",
    connected: true,
    managedExternally: true,
    managedBy: "the Claude CLI on this box",
  };

  it("shows what to do (run claude auth login on the box) and offers no Connect", async () => {
    await mountCard(() => [managed]);
    const hint = h!.container.querySelector('[data-testid="external-signin-hint-anthropic"]');
    expect(hint?.textContent).toContain("Signed in with the Claude CLI on this box");
    expect(hint?.textContent).toContain("claude auth login");
    expect(buttonByText(h!, "Connect")).toBeNull();
  });

  it("a plain (not externally managed) connected row shows no such hint", async () => {
    await mountCard(() => [{ ...managed, managedExternally: false, managedBy: null }]);
    expect(h!.container.querySelector('[data-testid="external-signin-hint-anthropic"]')).toBeNull();
  });
});
