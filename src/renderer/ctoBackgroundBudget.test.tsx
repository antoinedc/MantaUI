// @vitest-environment jsdom
//
// The CTO pane and the one background work budget (spec 2026-11-17 §10): the ambient cap and the night cap
// inputs are gone, the pane shows a one-line status with a Background work settings link, and the thrifty banner says WHY in words.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { BudgetStatus } from "../shared/api";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { budgetStatus } from "./budgetStatusFixture";
import { CtoPanel, SettingsView } from "./CtoPanel";
import { clearBackgroundWorkFocus } from "./useBackgroundStatus";

vi.mock("./Transcript", () => ({ Transcript: () => null }));

const status = (over: Partial<BudgetStatus> = {}): BudgetStatus =>
  budgetStatus({ byWork: [{ workType: "cto-ambient", calls: 3, usd: 0.4, tokens: 45_000 }], ...over });

const settingsApi = (over: Record<string, unknown> = {}) => ({
  configGet: () => Promise.resolve({ ctoEnabled: true, ctoTier: "high", ctoOvernight: true }),
  configUpdate: (patch: unknown) => Promise.resolve(patch),
  ctoHealthGet: () => Promise.resolve({ stats: [], calibration: null }),
  ctoQuotaRead: () => Promise.resolve({ days: {}, quota: {} }),
  usageList: () => Promise.resolve([]),
  backgroundStatus: () => Promise.resolve(status()),
  ...over,
});

describe("CTO settings: the one budget", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    clearBackgroundWorkFocus();
  });

  async function openSettings(over: Record<string, unknown> = {}) {
    installMockApi(settingsApi(over));
    h = mount(
      <SettingsView paused={false} pausedAt={null} onBack={() => {}} onLedger={() => {}} onProfile={() => {}} onBlackboard={() => {}} onTools={() => {}} onResume={() => {}} />,
    );
    await h.flush();
  }
  const q = (sel: string) => h!.container.querySelector(sel);

  it("has no ambient cap or night cap input and no '$x of $cap' copy", async () => {
    await openSettings();
    expect(q('input[aria-label="Hard daily ambient cap in dollars"]')).toBeNull();
    expect(q('input[aria-label="Overnight cap for windowless providers in dollars"]')).toBeNull();
    expect(h!.text()).not.toMatch(/Hard daily cap/i);
    expect(h!.text()).not.toMatch(/of \$[\d.]+ cap/);
  });

  it("shows the one-line status with the CTO's own share, in the Behavior card and the Tonight card", async () => {
    await openSettings();
    const lines = Array.from(h!.container.querySelectorAll('[data-testid="cto-budget-status"], [data-testid="cto-tonight-budget-status"]'));
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("Background work used 2% of your Claude week");
    expect(lines[0].textContent).toContain("CTO work today: 3 calls · 45k tokens");
    expect(lines[1].textContent).toContain("Background work used 2% of your Claude week");
  });

  it("says in words when the budget is exhausted", async () => {
    await openSettings({
      backgroundStatus: () =>
        Promise.resolve(
          status({ payg: { providers: ["openrouter"], usdToday: 5, usdMonth: 5, paused: { reason: "usd-cap", resumesAt: new Date(2026, 10, 18, 0, 0, 0).getTime() } } }),
        ),
    });
    expect(q('[data-testid="cto-budget-status"]')!.textContent).toContain("The CTO reached today's $5.00 API-key limit. It resumes at midnight.");
  });

  it("Background work settings opens Settings at the Background work section", async () => {
    await openSettings();
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("manta-open-settings", on);
    try {
      const change = Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Background work settings")!;
      await act(async () => {
        change.click();
      });
    } finally {
      window.removeEventListener("manta-open-settings", on);
    }
    expect(seen).toEqual([{ section: "background", backgroundWork: true }]);
  });

  it("an older box shows no budget line and nothing broken", async () => {
    await openSettings({ backgroundStatus: () => Promise.reject(new Error("unknown rpc channel: background:status")) });
    expect(q('[data-testid="cto-budget-status"]')).toBeNull();
    expect(q('[data-testid="cto-tonight-budget-status"]')).toBeNull();
    expect(h!.text()).toContain("Behavior");
  });

  it("a failed read says so and Retry reads again", async () => {
    let calls = 0;
    await openSettings({ backgroundStatus: () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(status())) });
    expect(q('[data-testid="cto-budget-status"]')!.textContent).toContain("offline");
    const retry = Array.from(q('[data-testid="cto-budget-status"]')!.querySelectorAll("button")).find((b) => b.textContent === "Retry")!;
    await act(async () => {
      retry.click();
    });
    await h!.flush();
    expect(q('[data-testid="cto-budget-status"]')!.textContent).toContain("Background work used 2%");
  });
});

describe("CTO thrifty banner", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
    clearBackgroundWorkFocus();
  });

  async function openDashboard(dot: "active" | "thrifty", backgroundStatus: () => Promise<unknown>, thriftyReason: "cap_hit" | "watchdog" | null = dot === "thrifty" ? "cap_hit" : null) {
    installMockApi({
      ctoConversationOpen: () => Promise.resolve({ sessionId: "ses_cto", generation: 1 }),
      ctoConversationState: () =>
        Promise.resolve({
          binding: { sessionId: "ses_cto", generation: 1 },
          submissions: [],
          counts: { queued: { human: 0, background: 0 }, unresolved: 0, terminal: 0 },
          droppedByPolicy: [],
        }),
      ctoDigestGet: () => Promise.resolve({ digest: null }),
      ctoCardsGet: () => Promise.resolve({ cards: [] }),
      ctoFinishedGet: () => Promise.resolve({ items: [] }),
      backgroundStatus,
    });
    resetStore();
    const state = { enabled: true, dot, thriftyReason, pausedAt: null, needsYouCount: 0, generationInFlight: false, tonightCount: 0, tier: "low" };
    h = mount(<CtoPanel state={state} onOpenSession={() => {}} />);
    await h.flush();
    const dash = Array.from(h.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Dashboard"))!;
    await act(async () => {
      dash.click();
    });
    await h.flush();
  }
  const banner = () => h!.container.querySelector('[data-testid="cto-thrifty-banner"]');

  it("names the reason in words, with a Background work settings link", async () => {
    await openDashboard("thrifty", () =>
      Promise.resolve(
        status({ payg: { providers: ["openrouter"], usdToday: 5, usdMonth: 5, paused: { reason: "usd-cap", resumesAt: new Date(2026, 10, 18, 0, 0, 0).getTime() } } }),
      ),
    );
    expect(banner()!.textContent).toContain("Thrifty mode");
    expect(banner()!.textContent).toContain("The CTO reached today's $5.00 API-key limit. It resumes at midnight.");
    expect(Array.from(banner()!.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Background work settings"]);
  });

  it("a watchdog thrifty is not blamed on a budget refusal that happens to stand", async () => {
    await openDashboard(
      "thrifty",
      () => Promise.resolve(status({ payg: { providers: ["openrouter"], usdToday: 5, usdMonth: 5, paused: { reason: "usd-cap", resumesAt: new Date(2026, 10, 18, 0, 0, 0).getTime() } } })),
      "watchdog",
    );
    expect(banner()!.textContent).toContain("limiting background work to stay inside its budget");
    expect(banner()!.textContent).not.toContain("API-key cap");
  });

  it("a cap-hit thrifty whose refusal has cleared falls back to the generic line", async () => {
    await openDashboard("thrifty", () => Promise.resolve(status()));
    expect(banner()!.textContent).toContain("limiting background work to stay inside its budget");
  });

  it("still explains itself when the reason can't be read", async () => {
    await openDashboard("thrifty", () => Promise.reject(new Error("offline")));
    expect(banner()!.textContent).toContain("limiting background work to stay inside its budget");
  });

  it("is absent when the CTO is not thrifty, and reads no budget for it", async () => {
    const read = vi.fn(() => Promise.resolve(status()));
    await openDashboard("active", read);
    expect(banner()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
