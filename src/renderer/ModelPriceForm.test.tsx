// @vitest-environment jsdom
//
// Sticky-trims spec §3.4: the unpriced-models notice + per-model price form.
// Pure parsing/grouping first, then the mounted panel against a mocked
// window.api: notice appears, Save success, Save error (both a rejected write
// and a thrown one), required-field validation, and "renders nothing" when the
// box can't answer.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, buttonByText, type Harness } from "./testHarness";
import { UnpricedModelsPanel, parseCostDraft, groupUnpriced, EMPTY_PRICE_DRAFT } from "./ModelPriceForm";

describe("parseCostDraft", () => {
  it("requires input, output and cache read", () => {
    expect(parseCostDraft({ ...EMPTY_PRICE_DRAFT, output: "15", cacheRead: "0.3" })).toEqual({ ok: false, error: "Input price is required." });
    expect(parseCostDraft({ ...EMPTY_PRICE_DRAFT, input: "3", cacheRead: "0.3" })).toEqual({ ok: false, error: "Output price is required." });
    expect(parseCostDraft({ ...EMPTY_PRICE_DRAFT, input: "3", output: "15" })).toEqual({ ok: false, error: "Cache read price is required." });
  });

  it("builds the writer body, omitting an empty cache write", () => {
    expect(parseCostDraft({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "" })).toEqual({
      ok: true,
      cost: { input: 3, output: 15, cache_read: 0.3 },
    });
    expect(parseCostDraft({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" })).toEqual({
      ok: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    });
  });

  it("accepts zero and rejects negatives, non-numbers and exponent/hex forms", () => {
    expect(parseCostDraft({ input: "0", output: "0", cacheRead: "0", cacheWrite: "" }).ok).toBe(true);
    for (const bad of ["-1", "abc", "1e3", "0x10", "1,5", "Infinity", "NaN"]) {
      expect(parseCostDraft({ input: bad, output: "1", cacheRead: "1", cacheWrite: "" }).ok, bad).toBe(false);
    }
    // Cache read must be valid too, and so must an optional cache write that is present.
    expect(parseCostDraft({ input: "1", output: "1", cacheRead: "-0.1", cacheWrite: "" })).toEqual({
      ok: false,
      error: "Cache read price must be a number of dollars per million tokens (0 or more).",
    });
    expect(parseCostDraft({ input: "1", output: "1", cacheRead: "0.1", cacheWrite: "x" })).toEqual({
      ok: false,
      error: "Cache write price must be a number of dollars per million tokens (0 or more).",
    });
  });
});

describe("groupUnpriced", () => {
  it("splits at the first slash so slashed model ids survive, and sorts", () => {
    expect(groupUnpriced(["openrouter/deepseek/deepseek-v4-flash", "acme/b", "acme/a"])).toEqual([
      { providerID: "acme", models: ["a", "b"] },
      { providerID: "openrouter", models: ["deepseek/deepseek-v4-flash"] },
    ]);
  });

  it("drops keys the writer could not address", () => {
    expect(groupUnpriced(["nomodel", "/x", "p/"])).toEqual([]);
  });
});

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const field = (h: Harness, suffix: string) => h.container.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)!;
const click = (b: HTMLButtonElement | null) => {
  if (!b) throw new Error("button not found");
  act(() => b.click());
};

function prices(unpriced: string[]) {
  return { fetchedAt: 1, models: {}, unpriced };
}

describe("UnpricedModelsPanel", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
    h = null;
  });

  async function openForm() {
    h = mount(<UnpricedModelsPanel names={{ acme: "Acme AI" }} />);
    await h.flush();
    click(h.container.querySelector<HTMLButtonElement>("button[aria-expanded]"));
    click(buttonByText(h, "Set prices"));
  }

  it("shows the no-prices notice per provider, collapsed by default", async () => {
    installMockApi({ optimizerPrices: () => Promise.resolve(prices(["acme/model-x", "acme/model-y", "zeta/z"])) });
    h = mount(<UnpricedModelsPanel names={{ acme: "Acme AI" }} />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Acme AI");
    expect(text).toContain("zeta");
    expect(text.match(/No prices — the optimizer won't trim these models/g)).toHaveLength(2);
    // Collapsed: no model rows, no form.
    expect(text).not.toContain("model-x");
    expect(h.container.querySelectorAll("input").length).toBe(0);
    // Expanding a provider lists its models.
    click(h.container.querySelector<HTMLButtonElement>("button[aria-expanded]"));
    expect(h.text()).toContain("model-x");
    expect(h.text()).toContain("model-y");
  });

  it("renders nothing when every model is priced", async () => {
    installMockApi({ optimizerPrices: () => Promise.resolve(prices([])) });
    h = mount(<UnpricedModelsPanel />);
    await h.flush();
    expect(h.container.innerHTML).toBe("");
  });

  it("renders nothing when the box reports supported:false, rejects, or lacks the method", async () => {
    installMockApi({ optimizerPrices: () => Promise.resolve({ supported: false }) });
    h = mount(<UnpricedModelsPanel />);
    await h.flush();
    expect(h.container.innerHTML).toBe("");
    h.unmount();

    installMockApi({ optimizerPrices: () => Promise.reject(new Error("boom")) });
    h = mount(<UnpricedModelsPanel />);
    await h.flush();
    expect(h.container.innerHTML).toBe("");
    h.unmount();

    installMockApi({}, { absent: ["optimizerPrices"] });
    h = mount(<UnpricedModelsPanel />);
    await h.flush();
    expect(h.container.innerHTML).toBe("");
  });

  it("Save without input/output/cache read does not call the box and says what is missing", async () => {
    const { api } = installMockApi({ optimizerPrices: () => Promise.resolve(prices(["acme/model-x"])) });
    await openForm();
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(api.calls.opencodeSetModelCost).toBeUndefined();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toBe("Input price is required.");

    typeInto(field(h!, "input"), "3");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(api.calls.opencodeSetModelCost).toBeUndefined();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toBe("Output price is required.");

    typeInto(field(h!, "output"), "abc");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("Output price must be a number");
    expect(api.calls.opencodeSetModelCost).toBeUndefined();

    typeInto(field(h!, "output"), "15");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toBe("Cache read price is required.");
    expect(api.calls.opencodeSetModelCost).toBeUndefined();
    expect(h!.text()).toContain("Leave cache write empty if the provider charges nothing extra to cache.");
  });

  it("Save success: sends the cost, confirms, and the model leaves the unpriced list", async () => {
    let unpriced = ["acme/model-x"];
    const { api } = installMockApi({
      optimizerPrices: () => Promise.resolve(prices(unpriced)),
      opencodeSetModelCost: () => {
        unpriced = [];
        return Promise.resolve({ ok: true });
      },
    });
    await openForm();
    typeInto(field(h!, "input"), "3");
    typeInto(field(h!, "output"), "15");
    typeInto(field(h!, "cache-read"), "0.3");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();

    expect(api.calls.opencodeSetModelCost).toEqual([
      [{ providerID: "acme", modelID: "model-x", cost: { input: 3, output: 15, cache_read: 0.3 } }],
    ]);
    // The prices were re-read, so the model is gone — but the confirmation stays.
    expect(api.calls.optimizerPrices?.length).toBe(2);
    const text = h!.text();
    expect(text).not.toContain("No prices — the optimizer won't trim these models");
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain(
      "Saved — the optimizer will use these prices",
    );
    expect(h!.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("Save error from the box: shows it, keeps the form and the model listed", async () => {
    const { api } = installMockApi({
      optimizerPrices: () => Promise.resolve(prices(["acme/model-x"])),
      opencodeSetModelCost: () => Promise.resolve({ ok: false, error: "opencode refused the config patch" }),
    });
    await openForm();
    typeInto(field(h!, "input"), "3");
    typeInto(field(h!, "output"), "15");
    typeInto(field(h!, "cache-read"), "0.3");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();

    const alert = h!.container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("opencode refused the config patch");
    expect(alert).toContain("Nothing was changed");
    expect(h!.container.querySelector('[role="status"]')).toBeNull();
    expect(h!.text()).toContain("model-x");
    // No refresh on failure; the user's input is intact for a retry.
    expect(api.calls.optimizerPrices?.length).toBe(1);
    expect(field(h!, "input").value).toBe("3");
  });

  it("Save error when the call throws: shows it instead of swallowing", async () => {
    installMockApi({
      optimizerPrices: () => Promise.resolve(prices(["acme/model-x"])),
      opencodeSetModelCost: () => Promise.reject(new Error("network down")),
    });
    await openForm();
    typeInto(field(h!, "input"), "1");
    typeInto(field(h!, "output"), "2");
    typeInto(field(h!, "cache-read"), "0.1");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("network down");
    expect(h!.container.querySelector('[role="status"]')).toBeNull();
  });

  it("a saved price whose list refresh fails still confirms, and says the list is stale", async () => {
    let calls = 0;
    installMockApi({
      optimizerPrices: () => (++calls === 1 ? Promise.resolve(prices(["acme/model-x"])) : Promise.reject(new Error("x"))),
      opencodeSetModelCost: () => Promise.resolve({ ok: true }),
    });
    await openForm();
    typeInto(field(h!, "input"), "1");
    typeInto(field(h!, "output"), "2");
    typeInto(field(h!, "cache-read"), "0.1");
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    const status = h!.container.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("Saved — the optimizer will use these prices");
    expect(status).toContain("couldn't refresh the list");
  });
});
