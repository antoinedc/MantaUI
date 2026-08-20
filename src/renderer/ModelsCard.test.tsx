// @vitest-environment jsdom
//
// ModelsCard / ModelsWeCouldntIdentify — the "Models we couldn't identify"
// block (BET-1249) in Settings → Models. Acceptance:
//   • the block is absent when every endpoint resolves (has a declaration)
//   • exact → shows the matched name and a Change action
//   • ambiguous → renders exactly the candidate options, none preselected
//   • none → renders the search input + the two optional fields (free/none)
//   • saving writes declaredModels through configUpdate with the expected key+shape
//   • leaving a row untouched changes no config
//   • chips are driven through the visible control (BET-1200)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, installMockApi, type Harness } from "./testHarness";
import { ModelsWeCouldntIdentify, type DeclaredModel } from "./ModelsWeCouldntIdentify";
import { ModelsCard } from "./ModelsCard";
import { createModelIndex } from "../shared/modelCatalog.mjs";
import { resetStore } from "./testHarness";

// A trimmed provider-agnostic catalogue fixture (models.dev shape).
const ENTRIES = [
  { id: "custom/qwen3.5-72b", name: "Qwen3.5 72B", family: "qwen", description: "A 72B model." },
  { id: "acme/claude-haiku-4", name: "Claude Haiku 4", family: "haiku", limit: { context: 200000 } },
  { id: "x/ornith-nano", name: "Ornith Nano", family: "ornith" },
  { id: "x/ornith-small", name: "Ornith Small", family: "ornith" },
  { id: "x/ornith-medium", name: "Ornith Medium", family: "ornith" },
  { id: "x/ornith-large", name: "Ornith Large", family: "ornith" },
];

const CATALOG = {
  supported: true,
  matcher: createModelIndex(ENTRIES),
  entries: ENTRIES,
};

// Renderer OpencodeModel fixtures — each exercises one identity case.
const EXACT_MODEL = {
  providerID: "acme",
  id: "my-endpoint",
  family: "claude-haiku-4",
  name: "My Endpoint",
};
const AMBIG_MODEL = { providerID: "custom", id: "ornith", family: "ornith", name: "Ornith" };
const NONE_MODEL = { providerID: "custom", id: "default-model", family: "", name: "Default" };

const key = (providerID: string, id: string) => `${providerID}/${id}`;

function block(
  models: unknown[],
  declared: Record<string, DeclaredModel> = {},
  onDeclare = vi.fn(),
) {
  return (
    <ModelsWeCouldntIdentify
      models={models as never}
      declaredModels={declared}
      catalog={CATALOG}
      busyKey={null}
      onDeclare={onDeclare}
    />
  );
}

describe("ModelsWeCouldntIdentify (the block)", () => {
  let h: Harness | null = null;
  beforeEach(() => {
    h = null;
  });
  afterEach(() => {
    h?.unmount();
  });

  it("is absent when every endpoint already has a declaration", () => {
    const declared = {
      [key("acme", "my-endpoint")]: { catalogId: "acme/claude-haiku-4" },
      [key("custom", "ornith")]: { catalogId: "x/ornith-small" },
      [key("custom", "default-model")]: { catalogId: "custom/qwen3.5-72b" },
    };
    h = mount(block([EXACT_MODEL, AMBIG_MODEL, NONE_MODEL], declared));
    expect(h.text()).not.toContain("Models we couldn't identify");
    expect(h.text()).not.toContain("Matched automatically");
  });

  it("exact → shows the matched name and a Change action", () => {
    // Only the exact endpoint is unresolved.
    h = mount(block([EXACT_MODEL, AMBIG_MODEL, NONE_MODEL], {
      [key("custom", "ornith")]: { catalogId: "x/ornith-small" },
      [key("custom", "default-model")]: { catalogId: "custom/qwen3.5-72b" },
    }));
    const text = h.text();
    expect(text).toContain("acme / my-endpoint");
    expect(text).toContain("Matched automatically →");
    expect(text).toContain("Claude Haiku 4");
    // The Change button is the visible control.
    const change = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Change",
    );
    expect(change).toBeTruthy();
  });

  it("ambiguous → renders exactly the candidate options, none preselected", () => {
    const onDeclare = vi.fn();
    h = mount(block([AMBIG_MODEL], {}, onDeclare));
    const text = h.text();
    for (const name of ["Ornith Nano", "Ornith Small", "Ornith Medium", "Ornith Large"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("4 models share this name");
    // None preselected — no chip reports pressed.
    expect(h.html()).not.toContain('aria-pressed="true"');

    // Driving the VISIBLE chip (not an sr-only input) declares that candidate.
    const chip = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Ornith Small",
    );
    expect(chip).toBeTruthy();
    chip!.click();
    expect(onDeclare).toHaveBeenCalledWith(key("custom", "ornith"), {
      catalogId: "x/ornith-small",
    });
  });

  it("none → renders the search input + the two optional fields with free/none defaults", () => {
    const onDeclare = vi.fn();
    h = mount(block([NONE_MODEL], {}, onDeclare));
    const text = h.text();
    expect(text).toContain("No match — tell us which model this is");
    // The searchable model input is present.
    const search = h.container.querySelector('input[placeholder="Search the catalogue…"]');
    expect(search).toBeTruthy();
    // Both optional fields present, with Free / None selected by default.
    const free = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Free");
    const none = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "None");
    expect(free?.getAttribute("aria-pressed")).toBe("true");
    expect(none?.getAttribute("aria-pressed")).toBe("true");

    // Save is gated on having picked a model; with none picked it does nothing.
    const save = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save");
    expect(save?.hasAttribute("disabled")).toBe(true);

    // Leaving the row untouched writes no config.
    expect(onDeclare).not.toHaveBeenCalled();
  });

  it("none → picking a catalogue model + Save writes the declared model (free/none defaults)", async () => {
    const onDeclare = vi.fn();
    h = mount(block([NONE_MODEL], {}, onDeclare));

    const search = h.container.querySelector('input[placeholder="Search the catalogue…"]') as HTMLInputElement;
    // Focus (React onFocus listens for focusin) opens the typeahead — the
    // empty-query list includes our Qwen fixture — then click the suggestion.
    search.dispatchEvent(new Event("focusin", { bubbles: true }));
    await h!.flush();
    const suggestion = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Qwen3.5 72B"),
    );
    expect(suggestion).toBeTruthy();
    suggestion!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await h!.flush();
    const save = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save");
    expect(save?.hasAttribute("disabled")).toBe(false);
    save!.click();

    // Free + None defaults are baked into the declaration.
    expect(onDeclare).toHaveBeenCalledWith(key("custom", "default-model"), {
      catalogId: "custom/qwen3.5-72b",
      price: "free",
      caches: false,
    });
  });
});

describe("ModelsCard wiring — saving goes through configUpdate", () => {
  let h: Harness | null = null;
  afterEach(() => {
    h?.unmount();
  });

  it("declaring an ambiguous endpoint writes modelRouting.declaredModels via configUpdate", async () => {
    resetStore();
    const { api } = installMockApi({
      opencodeModels: () =>
        Promise.resolve([
          AMBIG_MODEL,
          { providerID: "acme", id: "my-endpoint", family: "claude-haiku-4", name: "My Endpoint" },
        ]),
      opencodeDefaultModel: () => Promise.resolve(null),
      configGet: () =>
        Promise.resolve({
          modelOverrides: {},
          deactivatedSubagents: [],
          optInModels: [],
          modelRouting: { preset: "balanced", declaredModels: {} },
        }),
      opencodeSyncSubagents: () => Promise.resolve([]),
      opencodeModelCatalog: () => Promise.resolve({ supported: true, size: 2, entries: ENTRIES }),
    });
    h = mount(<ModelsCard />);
    await h.flush();
    await h.flush();

    expect(h.text()).toContain("Models we couldn't identify");

    // Click the visible candidate chip for the ambiguous endpoint.
    const chip = [...h.container.querySelectorAll("button")].find((b) =>
      b.textContent?.trim() === "Ornith Nano",
    );
    expect(chip).toBeTruthy();
    chip!.click();
    await h.flush();
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
    expect(declared[key("custom", "ornith")]).toEqual({ catalogId: "x/ornith-nano" });
  });
});
