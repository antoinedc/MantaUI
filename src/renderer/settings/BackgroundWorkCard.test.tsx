// @vitest-environment jsdom
//
// Settings → Models "Background work" (background work budget spec §10, §17.20/§17.21): the level control and the
// API-key cap each show only when they apply, every refusal is worded, and every save reports both outcomes.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { BudgetStatus } from "../../shared/api";
import { installMockApi, mount, type Harness, type MockApi } from "../testHarness";
import { clearBackgroundWorkFocus, openBackgroundWorkSettings } from "../useBackgroundStatus";
import { BackgroundWorkCard } from "./BackgroundWorkCard";

const weekWindow = { key: "claude:weekly", kind: "weekly", label: "Week", pct: 40, bgPct: 2, cap: 5, projectedPct: 60, resetsAt: Date.now() + 3 * 86_400_000 };
const sessionWindow = { key: "claude:session", kind: "session", label: "5-hour", pct: 30, bgPct: 4, cap: 10, projectedPct: null, resetsAt: Date.now() + 3_600_000 };

const claude = (over: Record<string, unknown> = {}) => ({
  adapter: "claude",
  fallback: false,
  windows: [weekWindow, sessionWindow],
  paused: null,
  ...over,
});

const status = (over: Partial<BudgetStatus> = {}): BudgetStatus => ({
  level: "normal",
  dailyCapUsd: 5,
  payg: { providers: [], usdToday: 0, usdMonth: 0 },
  plans: [claude()],
  waitingBatch: [],
  byWork: [],
  ...over,
});

const payg = { providers: ["openrouter", "deepseek"], usdToday: 1.2, usdMonth: 18.4 };

describe("BackgroundWorkCard", () => {
  let h: Harness | null = null;
  let api: MockApi;
  afterEach(() => {
    h?.unmount();
    h = null;
    clearBackgroundWorkFocus();
  });

  async function open(overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi({ backgroundStatus: () => Promise.resolve(status()), configUpdate: () => Promise.resolve({}), ...overrides }));
    h = mount(<BackgroundWorkCard />);
    await h.flush();
    return h;
  }
  const q = <T extends HTMLElement>(sel: string) => h!.container.querySelector(sel) as T | null;
  const button = (text: string) =>
    Array.from(h!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined;
  const notice = () => q('[data-testid="background-work-notice"]')?.textContent ?? "";
  const rowTexts = () => Array.from(h!.container.querySelectorAll('[data-testid="background-work-status"] li')).map((l) => l.textContent);
  async function click(el: HTMLElement | null | undefined) {
    expect(el, "expected the control to exist").toBeTruthy();
    await act(async () => {
      el!.click();
    });
    await h!.flush();
  }
  async function typeInto(el: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submitCap() {
    await act(async () => {
      q<HTMLFormElement>("form")!.requestSubmit();
    });
    await h!.flush();
  }
  const levelPressed = () =>
    Array.from(q('[role="group"][aria-label="Background work on plans"]')!.querySelectorAll("button"))
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);

  it("loads the status and an older box says to update", async () => {
    await open({ backgroundStatus: () => Promise.reject(new Error("unknown rpc channel: background:status")) });
    expect(h!.text()).toContain("Update your box to use this");
    expect(q('[role="group"]')).toBeNull();
  });

  it("a transport that answers nothing is treated as unsupported", async () => {
    await open({ backgroundStatus: () => Promise.resolve(null) });
    expect(h!.text()).toContain("Update your box to use this");
  });

  it("a failed read shows the error and Try again reads once more", async () => {
    let calls = 0;
    await open({ backgroundStatus: () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(status())) });
    expect(q('[role="alert"]')!.textContent).toContain("offline");
    await click(button("Try again"));
    expect(q('[role="group"][aria-label="Background work on plans"]')).toBeTruthy();
  });

  describe("which controls appear", () => {
    it("plans only: the level control, listing the plans; no cap", async () => {
      await open();
      expect(levelPressed()).toEqual(["Normal"]);
      expect(h!.text()).toContain("Claude");
      expect(q('input[name="dailyCapUsd"]')).toBeNull();
    });

    it("API keys only: the cap, listing the providers, today and the month; no level control", async () => {
      await open({ backgroundStatus: () => Promise.resolve(status({ plans: [], payg })) });
      expect(q('[role="group"][aria-label="Background work on plans"]')).toBeNull();
      expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("5.00");
      expect(h!.text()).toContain("openrouter, deepseek");
      expect(q('[data-testid="background-work-payg-usage"]')!.textContent).toBe("$1.20 of $5.00 today · $18.40 this month");
      expect(h!.text()).toContain("0 turns background work off on API keys.");
    });

    it("a plan whose usage can't be read brings the cap with it, and says why", async () => {
      await open({ backgroundStatus: () => Promise.resolve(status({ plans: [claude({ fallback: true, windows: [] })] })) });
      expect(q('input[name="dailyCapUsd"]')).toBeTruthy();
      expect(rowTexts()).toEqual(["Claude usage unavailable — limited by the $5 daily cap until it returns"]);
    });

    it("no accounts at all: an explanation, no controls", async () => {
      await open({ backgroundStatus: () => Promise.resolve(status({ plans: [] })) });
      expect(q('[data-testid="background-work-empty"]')).toBeTruthy();
      expect(q('input[name="dailyCapUsd"]')).toBeNull();
    });

    it("states the limits in plain words", async () => {
      await open();
      expect(h!.text()).toContain("up to 5% of a week and 10% of a 5-hour window on Normal");
      expect(h!.text()).toContain("errs on the high side");
    });
  });

  describe("status rows", () => {
    it("usage in plan terms", async () => {
      await open();
      expect(rowTexts()).toEqual(["Background work used 2% of your Claude week · 4% of this 5-hour window"]);
    });

    it("a refusal in words with when it resumes, and a batch refusal and waiting job", async () => {
      const resumesAt = new Date(2026, 10, 19, 9, 0, 0).getTime();
      await open({
        backgroundStatus: () =>
          Promise.resolve(
            status({
              plans: [
                claude({
                  paused: { reason: "level-cap", windowKey: "claude:weekly", value: 5, resumesAt },
                }),
              ],
              waitingBatch: [{ workType: "knowledge-tidy", dueSince: Date.now() - 1000 }],
            }),
          ),
      });
      const rows = rowTexts();
      expect(rows[1]).toMatch(/^Reached this week's background limit \(5%\) — resumes /);
      expect(rows[1]).toContain("09:00");
      expect(rows[2]).toBe("Weekly tidy waiting for a quiet moment");
    });

    it("larger jobs paused (§17.20)", async () => {
      await open({
        backgroundStatus: () =>
          Promise.resolve(status({ plans: [claude({ batchPaused: { reason: "level-cap", windowKey: "claude:weekly", value: 3, resumesAt: null } })] })),
      });
      expect(rowTexts()).toContain("Larger jobs paused — they've used their share of this week (3%); capture continues.");
    });

    it("the API-key refusal", async () => {
      await open({
        backgroundStatus: () =>
          Promise.resolve(status({ plans: [], payg: { ...payg, paused: { reason: "usd-cap", resumesAt: new Date(2026, 10, 18, 0, 0, 0).getTime() } } })),
      });
      expect(rowTexts()).toContain("Reached today's $5.00 API-key cap — resumes at midnight");
    });
  });

  describe("level", () => {
    it("saves the pick, then says what the box has", async () => {
      let level = "normal";
      await open({
        backgroundStatus: () => Promise.resolve(status({ level: level as never })),
        configUpdate: (patch: { backgroundWork: { level: string } }) => {
          level = patch.backgroundWork.level;
          return Promise.resolve({});
        },
      });
      await click(button("Light"));
      expect(api.calls.configUpdate).toEqual([[{ backgroundWork: { level: "light" } }]]);
      expect(notice()).toBe("Background work on plans set to Light.");
      expect(levelPressed()).toEqual(["Light"]);
    });

    it("a refused save shows the box's message and puts the old value back", async () => {
      await open({ configUpdate: () => Promise.reject(new Error("backgroundWork.level must be off, light or normal")) });
      await click(button("Off"));
      expect(q('[data-testid="background-work-notice"]')!.getAttribute("role")).toBe("alert");
      expect(notice()).toBe("Couldn't save: backgroundWork.level must be off, light or normal");
      expect(levelPressed()).toEqual(["Normal"]);
    });

    it("a save that worked is not reported as failed when the follow-up status read fails; the status is read again", async () => {
      let reads = 0;
      let level = "normal";
      await open({
        backgroundStatus: () => (++reads === 2 ? Promise.reject(new Error("offline")) : Promise.resolve(status({ level: level as never }))),
        configUpdate: (patch: { backgroundWork: { level: string } }) => {
          level = patch.backgroundWork.level;
          return Promise.resolve({});
        },
      });
      await click(button("Light"));
      await h!.flush();
      expect(api.calls.configUpdate).toEqual([[{ backgroundWork: { level: "light" } }]]);
      expect(notice()).toBe("Saved, but couldn't refresh the status. It will update shortly.");
      expect(notice()).not.toContain("Couldn't save");
      expect(q('[data-testid="background-work-notice"]')!.getAttribute("role")).toBe("status");
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(levelPressed()).toEqual(["Light"]);
    });

    it("tells the user when the box kept a different level", async () => {
      await open({ configUpdate: () => Promise.resolve({}) }); // the status keeps saying Normal
      await click(button("Light"));
      expect(notice()).toBe("The box kept Normal instead of Light.");
      expect(levelPressed()).toEqual(["Normal"]);
    });

    it("pressing the current level does nothing and says nothing wrong", async () => {
      await open();
      await click(button("Normal"));
      expect(api.calls.configUpdate).toBeUndefined();
    });
  });

  describe("API-key cap", () => {
    const paygStatus = (cap = 5) => status({ plans: [], payg, dailyCapUsd: cap });

    it("rejects an invalid amount without calling the box and marks the field", async () => {
      await open({ backgroundStatus: () => Promise.resolve(paygStatus()) });
      const input = q<HTMLInputElement>('input[name="dailyCapUsd"]')!;
      await typeInto(input, "abc");
      await submitCap();
      expect(api.calls.configUpdate).toBeUndefined();
      expect(q('[role="alert"]')!.textContent).toContain("dollar amount");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      await typeInto(input, "3");
      expect(input.getAttribute("aria-invalid")).toBeNull();
    });

    it("rejects more than $100", async () => {
      await open({ backgroundStatus: () => Promise.resolve(paygStatus()) });
      await typeInto(q<HTMLInputElement>('input[name="dailyCapUsd"]')!, "101");
      await submitCap();
      expect(q('[role="alert"]')!.textContent).toContain("$100");
      expect(api.calls.configUpdate).toBeUndefined();
    });

    it("Save is disabled until the value changes; a valid cap is saved and reported", async () => {
      let cap = 5;
      await open({
        backgroundStatus: () => Promise.resolve(paygStatus(cap)),
        configUpdate: (patch: { backgroundWork: { dailyCapUsd: number } }) => {
          cap = patch.backgroundWork.dailyCapUsd;
          return Promise.resolve({});
        },
      });
      expect(button("Save cap")!.disabled).toBe(true);
      await typeInto(q<HTMLInputElement>('input[name="dailyCapUsd"]')!, "7.5");
      expect(button("Save cap")!.disabled).toBe(false);
      await submitCap();
      expect(api.calls.configUpdate).toEqual([[{ backgroundWork: { dailyCapUsd: 7.5 } }]]);
      expect(notice()).toBe("API-key daily cap set to $7.50.");
      expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("7.50");
    });

    it("a refused save shows the box's message and restores the previous value", async () => {
      await open({
        backgroundStatus: () => Promise.resolve(paygStatus()),
        configUpdate: () => Promise.reject(new Error("dailyCapUsd must be a number from 0 to 100")),
      });
      await typeInto(q<HTMLInputElement>('input[name="dailyCapUsd"]')!, "9");
      await submitCap();
      expect(notice()).toBe("Couldn't save: dailyCapUsd must be a number from 0 to 100");
      expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("5.00");
    });

    it("a half-typed cap survives the periodic refresh", async () => {
      await open({ backgroundStatus: () => Promise.resolve(paygStatus()) });
      await typeInto(q<HTMLInputElement>('input[name="dailyCapUsd"]')!, "12");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await h!.flush();
      expect(api.calls.backgroundStatus!.length).toBeGreaterThan(1);
      expect(q<HTMLInputElement>('input[name="dailyCapUsd"]')!.value).toBe("12");
    });
  });

  describe("opened from a Change link", () => {
    it("takes focus and scrolls itself into view when the request came before it mounted", async () => {
      openBackgroundWorkSettings();
      await open();
      expect(document.activeElement?.textContent).toBe("Background work");
    });

    it("takes focus when Settings is already on this tab", async () => {
      await open();
      await act(async () => {
        openBackgroundWorkSettings();
      });
      expect(document.activeElement?.textContent).toBe("Background work");
    });
  });
});
