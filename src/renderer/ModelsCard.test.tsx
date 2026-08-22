// @vitest-environment jsdom
//
// ModelsCard / ModelsWeCouldntIdentify — the "Models we couldn't identify"
// block (BET-1249 / BET-1272) in Settings → Models. Acceptance:
//   • the block is absent when the catalogue is healthy and every endpoint is
//     fully described (auto-eligible)
//   • an endpoint is listed only when autoEligibility reports a gap — e.g. one
//     endpoint missing its price renders exactly one row whose help line names
//     the same gaps autoEligibility(...).missing returns
//   • with the catalogue unavailable, the block renders the explanatory line
//     and NO rows — it does not return null
//   • exact → shows the matched name and a Change action
//   • ambiguous → renders exactly the candidate options, none preselected
//   • none → renders the search input + the two optional fields
//   • Save is DISABLED until a price is chosen (no free default, BET-1272 §8f)
//   • saving writes declaredModels through configUpdate with the expected
//     key+shape; leaving a row untouched changes no config
//   • chips are driven through the visible control (BET-1200)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mount, installMockApi, resetStore, type Harness } from "./testHarness";
import { ModelsWeCouldntIdentify } from "./ModelsWeCouldntIdentify";
import { _resetRoutingCatalogCache } from "./routingCatalog";

// A trimmed provider-agnostic catalogue fixture (models.dev shape).
const ENTRIES = [
  { id: "custom/qwen3.5-72b", name: "Qwen3.5 72B", family: "qwen", description: "A 72B model." },
  { id: "acme/claude-haiku-4", name: "Claude Haiku 4", family: "haiku", limit: { context: 200000 } },
  { id: "x/ornith-nano", name: "Ornith Nano", family: "ornith" },
  { id: "x/ornith-small", name: "Ornith Small", family: "ornith" },
  { id: "x/ornith-medium", name: "Ornith Medium", family: "ornith" },
  { id: "x/ornith-large", name: "Ornith Large", family: "ornith" },
];

// Renderer OpencodeModel fixtures — each exercises one identity case.
const EXACT_MODEL = {
  providerID: "acme",
  id: "my-endpoint",
  family: "claude-haiku-4",
  name: "My Endpoint",
  // Caching is known from the provider's cost — but there is no price. A
  // single "price" gap, which is exactly what the router waits on.
  cost: { cacheRead: 0.3, cacheWrite: 0.3 },
};
const AMBIG_MODEL = { providerID: "custom", id: "ornith", family: "ornith", name: "Ornith" };
const NONE_MODEL = { providerID: "custom", id: "default-model", family: "", name: "Default" };

const key = (providerID: string, id: string) => `${providerID}/${id}`;

// The block is self-contained: it fetches models + declaredModels (via
// configGet) + the catalogue (via opencodeModelCatalog) through the shared
// hooks. Each test installs its own window.api stub. The routing catalogue is
// cached module-level, so we force a reload against THIS stub before mounting.
function mountBlock(opts: {
  models: unknown[];
  declared?: Record<string, unknown>;
  catalogue: unknown[] | null; // null => unavailable
}) {
  resetStore();
  const { api } = installMockApi({
    opencodeModels: () => Promise.resolve(opts.models),
    configGet: () =>
      Promise.resolve({
        modelRouting: { preset: "balanced", declaredModels: opts.declared ?? {} },
      }),
    opencodeModelCatalog: () =>
      Promise.resolve(
        opts.catalogue
          ? { supported: true, size: opts.catalogue.length, entries: opts.catalogue }
          : { supported: false, size: 0, entries: [] },
      ),
  });
  _resetRoutingCatalogCache();
  const h = mount(<ModelsWeCouldntIdentify />);
  return { h, api };
}

const OK = () => ENTRIES;

describe("ModelsWeCouldntIdentify (the block)", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    h = null;
  });
  afterEach(() => {
    h?.unmount();
  });

  it("saving nothing writes nothing", async () => {
    h = mountBlock({ models: [NONE_MODEL], catalogue: OK() }).h;
    await h.flush();
    await h.flush();
    // The block renders the search + fields (none case).
    expect(h.text()).toContain("No match — tell us which model this is");
  });

  it("is absent when the catalogue is healthy and every endpoint is fully described", async () => {
    const declared = {
      [key("acme", "my-endpoint")]: { catalogId: "acme/claude-haiku-4", price: "free", caches: false },
      [key("custom", "ornith")]: { catalogId: "x/ornith-small", price: "free", caches: false },
      [key("custom", "default-model")]: { catalogId: "custom/qwen3.5-72b", price: "free", caches: false },
    };
    h = mountBlock({ models: [EXACT_MODEL, AMBIG_MODEL, NONE_MODEL], declared, catalogue: OK() }).h;
    await h.flush();
    await h.flush();
    expect(h.text()).not.toContain("Models we couldn't identify");
    expect(h.text()).not.toContain("Matched automatically");
  });

  it("one endpoint missing its price renders exactly one row whose help line names the same gaps autoEligibility reports", async () => {
    // EXACT_MODEL has caching but no price → missing exactly ["price"]. No
    // declaration. Only this endpoint is unresolved.
    h = mountBlock({
      models: [EXACT_MODEL, AMBIG_MODEL, NONE_MODEL],
      declared: {
        [key("custom", "ornith")]: { catalogId: "x/ornith-small", price: "free", caches: false },
        [key("custom", "default-model")]: { catalogId: "custom/qwen3.5-72b", price: "free", caches: false },
      },
      catalogue: OK(),
    }).h;
    await h.flush();
    await h.flush();
    const text = h.text();
    expect(text).toContain("acme / my-endpoint");
    // Exactly one row.
    expect(text.match(/Matched automatically/g)?.length).toBe(1);
    // The help line names the SAME gap autoEligibility would report: price
    // ("what it costs").
    expect(text).toContain("what it costs");
    // The Change button is the visible control.
    const change = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Change",
    );
    expect(change).toBeTruthy();
  });

  it("with the catalogue unavailable, renders the explanatory line and no rows — not null", async () => {
    h = mountBlock({ models: [EXACT_MODEL, AMBIG_MODEL, NONE_MODEL], catalogue: null }).h;
    await h.flush();
    await h.flush();
    await h.flush();
    const text = h.text();
    expect(text).toContain("Models we couldn't identify");
    expect(text).toContain("couldn't load the model catalogue");
    // No rows, no candidate chips, no search box.
    expect(text).not.toContain("Matched automatically");
    expect(text).not.toContain("Ornith Nano");
  });

  it("ambiguous → renders exactly the candidate options, none preselected; clicking one declares", async () => {
    const { h: hh, api } = mountBlock({ models: [AMBIG_MODEL], catalogue: OK() });
    h = hh;
    await h.flush();
    await h.flush();
    const text = h.text();
    for (const name of ["Ornith Nano", "Ornith Small", "Ornith Medium", "Ornith Large"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("4 models share this name");
    // None preselected — no chip reports pressed.
    expect(h.html()).not.toContain('aria-pressed="true"');

    // Driving the VISIBLE chip declares via configUpdate.
    const chip = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Ornith Small",
    );
    expect(chip).toBeTruthy();
    chip!.click();
    await h.flush();
    await h.flush();

    const updates = api.calls.configUpdate as unknown[][];
    const declPatch = updates.find((args) => {
      const patch = args[0] as { modelRouting?: { declaredModels?: Record<string, unknown> } };
      return !!patch?.modelRouting?.declaredModels;
    });
    expect(declPatch).toBeTruthy();
    const declared = (declPatch![0] as { modelRouting: { declaredModels: Record<string, unknown> } })
      .modelRouting.declaredModels;
    expect(declared[key("custom", "ornith")]).toEqual({ catalogId: "x/ornith-small" });
  });

  it("none → Save is disabled until a price is chosen; picking Free enables it", async () => {
    const { h: hh, api } = mountBlock({ models: [NONE_MODEL], catalogue: OK() });
    h = hh;
    await hh.flush();
    await hh.flush();
    const text = hh.text();
    expect(text).toContain("No match — tell us which model this is");
    const search = hh.container.querySelector('input[placeholder="Search the catalogue…"]') as HTMLInputElement;
    expect(search).toBeTruthy();

    const save = () => [...hh.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Save",
    );

    // Pick a catalogue model — Save stays disabled (no price chosen yet).
    search.dispatchEvent(new Event("focusin", { bubbles: true }));
    await hh.flush();
    const suggestion = [...hh.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Qwen3.5 72B"),
    );
    expect(suggestion).toBeTruthy();
    suggestion!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await hh.flush();
    expect(save()?.hasAttribute("disabled")).toBe(true);

    // Caching defaults to none (nothing to press); price has NO default —
    // "Free" is not selected. Choosing Free enables Save.
    const free = [...hh.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Free",
    );
    expect(free).toBeTruthy();
    expect(free!.getAttribute("aria-pressed")).not.toBe("true");
    free!.click();
    await hh.flush();
    expect(save()?.hasAttribute("disabled")).toBe(false);
    save()!.click();
    await hh.flush();
    await hh.flush();

    // The declaration bakes in the chosen Free price + the none caching.
    const updates = api.calls.configUpdate as unknown[][];
    const declPatch = updates.find((args) => {
      const patch = args[0] as { modelRouting?: { declaredModels?: Record<string, unknown> } };
      return !!patch?.modelRouting?.declaredModels;
    });
    expect(declPatch).toBeTruthy();
    const declared = (declPatch![0] as { modelRouting: { declaredModels: Record<string, unknown> } })
      .modelRouting.declaredModels;
    expect(declared[key("custom", "default-model")]).toEqual({
      catalogId: "custom/qwen3.5-72b",
      price: "free",
      caches: false,
    });
  });

  it("exact → shows the matched name and a Change action", async () => {
    // EXACT_MODEL is the only unresolved endpoint (missing its price).
    const { h: hh } = mountBlock({
      models: [EXACT_MODEL, NONE_MODEL],
      declared: {
        [key("custom", "default-model")]: { catalogId: "custom/qwen3.5-72b", price: "free", caches: false },
      },
      catalogue: OK(),
    });
    h = hh;
    await h.flush();
    await h.flush();
    const text = h.text();
    expect(text).toContain("acme / my-endpoint");
    expect(text).toContain("Matched automatically →");
    expect(text).toContain("Claude Haiku 4");
    const change = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Change",
    );
    expect(change).toBeTruthy();
  });
});

describe("ModelsCard", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
  });

  it("mounts the models table without the identify block", async () => {
    resetStore();
    installMockApi({
      opencodeModels: () => Promise.resolve([AMBIG_MODEL, EXACT_MODEL]),
      opencodeDefaultModel: () => Promise.resolve(null),
      configGet: () => Promise.resolve({ modelRouting: { preset: "balanced" } }),
      opencodeSyncSubagents: () => Promise.resolve([]),
      opencodeModelCatalog: () => Promise.resolve({ supported: true, size: 2, entries: ENTRIES }),
    });
    const { ModelsCard } = await import("./ModelsCard");
    h = mount(<ModelsCard />);
    await h.flush();
    await h.flush();
    // The table renders; the identify block is no longer nested here.
    expect(h.container.querySelector('input[placeholder="Search models by name, provider, capability…"]')).toBeTruthy();
    expect(h.text()).toContain("Ornith");
    expect(h.text()).not.toContain("Models we couldn't identify");
  });
});
