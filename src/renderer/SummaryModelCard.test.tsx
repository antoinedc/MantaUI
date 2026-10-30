// @vitest-environment jsdom
//
// Settings → Models "Summary model" row (cold-cache handoff spec A7): shows what
// the box picked and why, lets the user pick from the shortlist or search, opt
// out, take the one-click cheaper switch, and reports every outcome.

import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { SummaryModelCandidate, SummaryModelStatus } from "../shared/api";
import { SummaryModelCard } from "./SummaryModelCard";
import { installMockApi, mount, type Harness, type MockApi } from "./testHarness";

const cand = (over: Partial<SummaryModelCandidate> = {}): SummaryModelCandidate => ({
  providerID: "deepseek",
  modelID: "flash",
  name: "DeepSeek Flash",
  priceLabel: "$0.14 / $0.28 per M",
  recommended: false,
  qualityKnown: true,
  ...over,
});

const status = (over: Partial<SummaryModelStatus> = {}): SummaryModelStatus => ({
  current: { providerID: "deepseek", modelID: "flash", name: "DeepSeek Flash", source: "auto" },
  state: "ok",
  betterAvailable: false,
  candidates: [
    cand({ recommended: true }),
    cand({ providerID: "openrouter", modelID: "obscure", name: "Obscure 7B", priceLabel: null, qualityKnown: false }),
  ],
  ...over,
});

describe("SummaryModelCard", () => {
  let h: Harness | null = null;
  let api: MockApi;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function open(overrides: Record<string, unknown> = {}) {
    ({ api } = installMockApi(overrides));
    h = mount(<SummaryModelCard />);
    await h.flush();
    return h;
  }
  const trigger = () => h!.container.querySelector("button.manta-summary-model-trigger") as HTMLButtonElement;
  const notice = () => h!.container.querySelector('[data-testid="summary-model-notice"]')?.textContent ?? "";
  const options = () => Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLButtonElement[];
  const optionByText = (t: string) => options().find((o) => (o.textContent ?? "").includes(t));
  async function click(el: HTMLElement | null | undefined) {
    expect(el, "expected the control to exist").toBeTruthy();
    await act(async () => {
      el!.click();
    });
    await h!.flush();
  }
  async function typeQuery(value: string) {
    const input = h!.docQuery<HTMLInputElement>('input[aria-label="Search summary models"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    await h!.flush();
  }

  it("shows the explanation and the current model", async () => {
    await open({ summaryModelStatus: () => Promise.resolve(status()) });
    expect(h!.text()).toContain("Conversation text is sent to this model.");
    expect(trigger().textContent).toContain("DeepSeek Flash");
    expect(h!.container.querySelector('[data-testid="summary-model-reason"]')).toBeNull();
  });

  it("an older box (unknown channel) says to update and offers no controls", async () => {
    await open({ summaryModelStatus: () => Promise.reject(new Error("unknown rpc channel: summary-model:status")) });
    expect(h!.text()).toContain("Update your box to use this");
    expect(trigger()).toBeNull();
  });

  it("a failed load shows the error and Try again reloads", async () => {
    let calls = 0;
    await open({
      summaryModelStatus: () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(status())),
    });
    expect(h!.text()).toContain("offline");
    await click(Array.from(h!.container.querySelectorAll("button")).find((b) => b.textContent === "Try again"));
    expect(trigger().textContent).toContain("DeepSeek Flash");
  });

  it("lists the shortlist with recommended / not rated markers and the price", async () => {
    await open({ summaryModelStatus: () => Promise.resolve(status()) });
    await click(trigger());
    expect(optionByText("DeepSeek Flash")!.textContent).toContain("recommended");
    expect(optionByText("DeepSeek Flash")!.textContent).toContain("$0.14 / $0.28 per M");
    expect(optionByText("Obscure 7B")!.textContent).toContain("not rated");
    expect(optionByText("None — use each conversation's own model")).toBeTruthy();
  });

  it("choosing a model calls summary-model:set and reports it", async () => {
    const next = status({
      current: { providerID: "openrouter", modelID: "obscure", name: "Obscure 7B", source: "user" },
    });
    await open({ summaryModelStatus: () => Promise.resolve(status()), summaryModelSet: () => Promise.resolve(next) });
    await click(trigger());
    await click(optionByText("Obscure 7B"));
    expect(api.calls.summaryModelSet).toEqual([[{ providerID: "openrouter", modelID: "obscure" }]]);
    expect(notice()).toBe("Summary model set to Obscure 7B.");
    expect(trigger().textContent).toContain("Obscure 7B");
  });

  it("None sends {none:true} and shows the opted-out reason", async () => {
    const next = status({ current: null, state: "opted-out", reason: "Off — handoffs re-read the whole conversation." });
    await open({ summaryModelStatus: () => Promise.resolve(status()), summaryModelSet: () => Promise.resolve(next) });
    await click(trigger());
    await click(optionByText("None — use each conversation's own model"));
    expect(api.calls.summaryModelSet).toEqual([[{ none: true }]]);
    expect(notice()).toBe("Summary model turned off.");
    expect(h!.container.querySelector('[data-testid="summary-model-reason"]')?.textContent).toContain("re-read the whole conversation");
  });

  it("a rejected set shows the box's message and keeps the current model", async () => {
    await open({
      summaryModelStatus: () => Promise.resolve(status()),
      summaryModelSet: () => Promise.reject(new Error("That model isn't available as a summary model.")),
    });
    await click(trigger());
    await click(optionByText("Obscure 7B"));
    expect(notice()).toContain("That model isn't available as a summary model.");
    expect(trigger().textContent).toContain("DeepSeek Flash");
  });

  it("shows the reason for a non-ok state", async () => {
    await open({
      summaryModelStatus: () =>
        Promise.resolve(status({ state: "unavailable", reason: "DeepSeek Flash isn't connected any more." })),
    });
    expect(h!.container.querySelector('[data-testid="summary-model-reason"]')?.textContent).toBe("DeepSeek Flash isn't connected any more.");
  });

  it("betterAvailable offers a one-click switch to the recommended model", async () => {
    const st = status({
      betterAvailable: true,
      current: { providerID: "openrouter", modelID: "obscure", name: "Obscure 7B", source: "auto" },
      candidates: [cand({ recommended: true }), cand({ providerID: "openrouter", modelID: "obscure", name: "Obscure 7B" })],
    });
    await open({ summaryModelStatus: () => Promise.resolve(st), summaryModelSet: () => Promise.resolve(status()) });
    expect(h!.text()).toContain("A cheaper capable model is available.");
    await click(Array.from(h!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").startsWith("Switch to")));
    expect(api.calls.summaryModelSet).toEqual([[{ providerID: "deepseek", modelID: "flash" }]]);
    expect(h!.container.querySelector('[data-testid="summary-model-better"]')).toBeNull();
  });

  it("typing searches the box and lists what it finds beyond the shortlist", async () => {
    await open({
      summaryModelStatus: () => Promise.resolve(status()),
      summaryModelSearch: () => Promise.resolve({ models: [cand({ providerID: "p", modelID: "rare", name: "Rare Model" })] }),
    });
    await click(trigger());
    await typeQuery("rare");
    expect(api.calls.summaryModelSearch).toEqual([[{ query: "rare" }]]);
    expect(optionByText("Rare Model")).toBeTruthy();
    expect(optionByText("Obscure 7B")).toBeUndefined();
  });

  it("a failed search says so", async () => {
    await open({
      summaryModelStatus: () => Promise.resolve(status()),
      summaryModelSearch: () => Promise.reject(new Error("boom")),
    });
    await click(trigger());
    await typeQuery("x");
    expect(document.body.textContent).toContain("Couldn't search: boom");
  });
});
