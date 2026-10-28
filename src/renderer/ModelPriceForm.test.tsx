// @vitest-environment jsdom
//
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, buttonByText, type Harness } from "./testHarness";
import { UnpricedModelsPanel } from "./ModelPriceForm";

// Server-first (WS09 SF-M13): the box validates and groups (src/server/modelsPricing.mjs,
// pinned by modelsPricing.test.mjs). The panel renders `unpricedByProvider`, sends the four
// strings AS TYPED to `models:set-price`, and shows the reply's message / field / warning.

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

type Group = { providerID: string; models: string[] };
function prices(groups: Group[]) {
  return { fetchedAt: 1, models: {}, unpriced: groups.flatMap((g) => g.models.map((m) => `${g.providerID}/${m}`)), unpricedByProvider: groups };
}
const ACME: Group[] = [{ providerID: "acme", models: ["model-x"] }];

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

  async function typeAll(vals: { input?: string; output?: string; cacheRead?: string; cacheWrite?: string }) {
    if (vals.input !== undefined) typeInto(field(h!, "input"), vals.input);
    if (vals.output !== undefined) typeInto(field(h!, "output"), vals.output);
    if (vals.cacheRead !== undefined) typeInto(field(h!, "cache-read"), vals.cacheRead);
    if (vals.cacheWrite !== undefined) typeInto(field(h!, "cache-write"), vals.cacheWrite);
  }

  it("shows the no-prices notice per provider group the box sends, collapsed by default", async () => {
    installMockApi({
      optimizerPrices: () =>
        Promise.resolve(prices([{ providerID: "acme", models: ["model-x", "model-y"] }, { providerID: "zeta", models: ["z"] }])),
    });
    h = mount(<UnpricedModelsPanel names={{ acme: "Acme AI" }} />);
    await h.flush();
    const text = h.text();
    expect(text).toContain("Acme AI");
    expect(text).toContain("zeta");
    expect(text.match(/No prices — the optimizer won't trim these models/g)).toHaveLength(2);
    expect(text).not.toContain("model-x");
    expect(h.container.querySelectorAll("input").length).toBe(0);
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

  it("renders nothing when the box reports supported:false, an older box sends no groups, it rejects, or the method is absent", async () => {
    installMockApi({ optimizerPrices: () => Promise.resolve({ supported: false }) });
    h = mount(<UnpricedModelsPanel />);
    await h.flush();
    expect(h.container.innerHTML).toBe("");
    h.unmount();

    // An older box: `unpriced` but no `unpricedByProvider` → hidden (the client does not group).
    installMockApi({ optimizerPrices: () => Promise.resolve({ fetchedAt: 1, models: {}, unpriced: ["acme/model-x"] }) });
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

  it("Save sends the four strings AS TYPED to models:set-price — no client validation", async () => {
    const { api } = installMockApi({
      optimizerPrices: () => Promise.resolve(prices(ACME)),
      modelsSetPrice: () => Promise.resolve({ ok: false, field: "input", message: "Input price is required." }),
    });
    await openForm();
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(api.calls.modelsSetPrice).toEqual([[{ providerID: "acme", modelID: "model-x", draft: { input: "", output: "", cacheRead: "", cacheWrite: "" } }]]);
    expect(api.calls.opencodeSetModelCost).toBeUndefined();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toBe("Input price is required.");
    expect(h!.text()).toContain("Leave cache write empty if the provider charges nothing extra to cache.");
  });

  it("a box refusal is shown under the field it names; the form and the typed values stay", async () => {
    installMockApi({
      optimizerPrices: () => Promise.resolve(prices(ACME)),
      modelsSetPrice: () =>
        Promise.resolve({ ok: false, field: "output", message: "Output price must be a number of dollars per million tokens (0 or more)." }),
    });
    await openForm();
    await typeAll({ input: "3", output: "abc", cacheRead: "0.3" });
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("Output price must be a number");
    expect(field(h!, "input").value).toBe("3");
    expect(field(h!, "output").value).toBe("abc");
  });

  it("Save success: confirms with the box's message and re-renders from the reply's groups", async () => {
    const { api } = installMockApi({
      optimizerPrices: () => Promise.resolve(prices(ACME)),
      modelsSetPrice: () => Promise.resolve({ ok: true, message: "Saved — the optimizer will use these prices", unpricedByProvider: [] }),
    });
    await openForm();
    await typeAll({ input: "3", output: "15", cacheRead: "0.3" });
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(api.calls.modelsSetPrice).toEqual([[{ providerID: "acme", modelID: "model-x", draft: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "" } }]]);
    // No second read: the reply carried the groups.
    expect(api.calls.optimizerPrices?.length).toBe(1);
    expect(h!.text()).not.toContain("No prices — the optimizer won't trim these models");
    expect(h!.container.querySelector('[role="status"]')?.textContent).toContain("Saved — the optimizer will use these prices");
    expect(h!.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("written but opencode didn't reload: the warning is shown as a second line under the confirmation", async () => {
    installMockApi({
      optimizerPrices: () => Promise.resolve(prices(ACME)),
      modelsSetPrice: () =>
        Promise.resolve({ ok: true, message: "Saved — the optimizer will use these prices", warning: "opencode didn't reload its config, so its own cost display picks the new prices up after it restarts.", unpricedByProvider: [] }),
    });
    await openForm();
    await typeAll({ input: "1", output: "2", cacheRead: "0.1" });
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    const status = h!.container.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toContain("Saved — the optimizer will use these prices");
    expect(status).toContain("opencode didn't reload its config");
  });

  it("a plain refusal ('Nothing was changed') keeps the model listed and the form open", async () => {
    installMockApi({
      optimizerPrices: () => Promise.resolve(prices(ACME)),
      modelsSetPrice: () => Promise.resolve({ ok: false, message: "Couldn't save — opencode refused the config patch. Nothing was changed; try again." }),
    });
    await openForm();
    await typeAll({ input: "3", output: "15", cacheRead: "0.3" });
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    const alert = h!.container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("opencode refused the config patch");
    expect(alert).toContain("Nothing was changed");
    expect(h!.container.querySelector('[role="status"]')).toBeNull();
    expect(h!.text()).toContain("model-x");
  });

  it("a thrown call is shown instead of swallowed", async () => {
    installMockApi({
      optimizerPrices: () => Promise.resolve(prices(ACME)),
      modelsSetPrice: () => Promise.reject(new Error("network down")),
    });
    await openForm();
    await typeAll({ input: "1", output: "2", cacheRead: "0.1" });
    click(buttonByText(h!, "Save prices"));
    await h!.flush();
    expect(h!.container.querySelector('[role="alert"]')?.textContent).toContain("network down");
    expect(h!.container.querySelector('[role="status"]')).toBeNull();
  });
});
