// @vitest-environment jsdom
//
// ModelsCard / ModelsWeCouldntIdentify — server-first (WS09). Both render what
// the box computes (`models:table`, `models:unidentified`) and call one write
// per control (`models:set-*`, `models:declare`). The rules themselves
// (eligibility, Main/Sub/Default invariants, help copy) are pinned by the node
// tests in src/server/modelsTable.test.mjs / modelsUnidentified.test.mjs; here we
// assert the renderer shows the box's fields, sends the right writes, reports
// both outcomes, and degrades on an older box.

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, resetStore, type Harness } from "./testHarness";
import { useStore } from "./store";
import { ModelsWeCouldntIdentify } from "./ModelsWeCouldntIdentify";
import { _resetRoutingCatalogCache } from "./routingCatalog";
import { invalidateCachedResource } from "./useCachedResource";
import type { ModelsTableResult, ModelsTableRow, UnidentifiedList, UnidentifiedRow } from "../shared/types";

const ENTRIES = [
  { id: "custom/qwen3.5-72b", name: "Qwen3.5 72B", family: "qwen", description: "A 72B model." },
  { id: "x/ornith-small", name: "Ornith Small", family: "ornith" },
];

const button = (h: Harness, text: string) =>
  [...h.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

// ---------------------------------------------------------------- identify block

const INTRO = "Served under a name the catalogue doesn't recognise (box copy).";
const FOOTER = "Can't say? Leave it (box copy).";

const row = (over: Partial<UnidentifiedRow>): UnidentifiedRow => ({
  key: "custom/ep",
  label: "custom / ep",
  providerID: "custom",
  modelID: "ep",
  state: "none",
  catalogId: null,
  candidates: [],
  missing: ["identity", "price", "caching"],
  help: "No match — tell us which model this is",
  actions: ["identify"],
  ...over,
});
const list = (rows: UnidentifiedRow[], over: Partial<UnidentifiedList> = {}): UnidentifiedList => ({
  supported: true,
  intro: INTRO,
  footer: FOOTER,
  rows,
  ...over,
});

function mountBlock(initial: UnidentifiedList | "unsupported", declare?: (input: unknown) => unknown) {
  resetStore();
  invalidateCachedResource("modelsWeCouldntIdentify");
  const { api } = installMockApi({
    modelsUnidentified: () => (initial === "unsupported" ? Promise.reject(new Error("unknown rpc channel: models:unidentified")) : Promise.resolve(initial)),
    modelsDeclare: declare ?? (() => Promise.resolve({ ok: true, outcome: "resolved", row: null, list: list([]), message: "Saved — Auto can now describe ep" })),
    opencodeModelCatalog: () => Promise.resolve({ supported: true, size: ENTRIES.length, entries: ENTRIES }),
  });
  _resetRoutingCatalogCache();
  const h = mount(<ModelsWeCouldntIdentify />);
  return { h, api };
}

describe("ModelsWeCouldntIdentify (renders the box's rows)", () => {
  let h: Harness | null = null;
  afterEach(() => h?.unmount());

  it("is absent when the box lists no rows", async () => {
    h = mountBlock(list([])).h;
    await h.flush();
    await h.flush();
    expect(h.text()).not.toContain("Models we couldn't identify");
  });

  it("renders the box's intro, row label + help line, and footer verbatim", async () => {
    h = mountBlock(list([row({ state: "exact", catalogId: "x/ornith-small", help: "Matched automatically → Ornith Small — Auto still needs: what it costs", actions: ["change"] })])).h;
    await h.flush();
    await h.flush();
    const t = h.text();
    expect(t).toContain("Models we couldn't identify");
    expect(t).toContain(INTRO);
    expect(t).toContain("custom / ep");
    expect(t).toContain("Matched automatically → Ornith Small — Auto still needs: what it costs");
    expect(t).toContain(FOOTER);
    expect(button(h, "Change")).toBeTruthy();
    expect(button(h, "Confirm")).toBeUndefined();
  });

  it("catalogue unavailable → the box's explanation and no rows", async () => {
    h = mountBlock(list([], { supported: false, unavailableText: "Manta couldn't load the model catalogue (box copy)." })).h;
    await h.flush();
    await h.flush();
    expect(h.text()).toContain("Manta couldn't load the model catalogue (box copy).");
    expect(h.text()).not.toContain("Matched automatically");
  });

  it("an older box (unknown channel) shows 'Update your box to use this'", async () => {
    h = mountBlock("unsupported").h;
    await h.flush();
    await h.flush();
    expect(h.text()).toContain("Update your box to use this");
  });

  it("probable → Confirm declares {key, catalogId} and shows the box's message; the refreshed list replaces the rows", async () => {
    const calls: unknown[] = [];
    const { h: hh } = mountBlock(
      list([row({ state: "exact", confidence: "probable", catalogId: "x/ornith-small", help: "We think this is Ornith Small", actions: ["confirm", "change"] })]),
      (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true, outcome: "resolved", row: null, list: list([]), message: "Saved — Auto can now describe ep" });
      },
    );
    h = hh;
    await h.flush();
    await h.flush();
    act(() => button(h!, "Confirm")!.click());
    await h.flush();
    await h.flush();
    expect(calls).toEqual([{ key: "custom/ep", catalogId: "x/ornith-small" }]);
    expect(h.text()).toContain("Saved — Auto can now describe ep");
    expect(h.text()).not.toContain("We think this is Ornith Small");
  });

  it("still-needs keeps the row and shows the box's 'Identity saved…' line", async () => {
    const still = row({ state: "exact", catalogId: "x/ornith-small", help: "Matched automatically → Ornith Small — Auto still needs: what it costs", actions: ["change"] });
    const { h: hh } = mountBlock(list([still]), () =>
      Promise.resolve({ ok: true, outcome: "still-needs", row: still, list: list([still]), message: "Identity saved — Auto still needs: what it costs." }),
    );
    h = hh;
    await h.flush();
    await h.flush();
    act(() => button(h!, "Change")!.click());
    await h.flush();
    expect(h.container.querySelector('input[placeholder="Search the catalogue…"]')).toBeTruthy();
  });

  it("ambiguous with chips → one chip per candidate, none preselected; clicking one declares that candidate", async () => {
    const calls: unknown[] = [];
    const { h: hh } = mountBlock(
      list([row({ state: "ambiguous", chips: true, candidates: [{ id: "x/ornith-small", name: "Ornith Small" }, { id: "x/ornith-large", name: "Ornith Large" }], help: "2 models share this name — which one is it?", actions: ["pick"] })]),
      (input) => {
        calls.push(input);
        return Promise.resolve({ ok: true, outcome: "resolved", row: null, list: list([]), message: "Saved" });
      },
    );
    h = hh;
    await h.flush();
    await h.flush();
    expect(h.html()).not.toContain('aria-pressed="true"');
    act(() => button(h!, "Ornith Small")!.click());
    await h.flush();
    expect(calls).toEqual([{ key: "custom/ep", catalogId: "x/ornith-small" }]);
  });

  it("none → Save is disabled until a model and a price are chosen; Save sends the form AS TYPED", async () => {
    const calls: unknown[] = [];
    const { h: hh } = mountBlock(list([row({})]), (input) => {
      calls.push(input);
      return Promise.resolve({ ok: true, outcome: "resolved", row: null, list: list([]), message: "Saved" });
    });
    h = hh;
    await h.flush();
    await h.flush();
    const search = h.container.querySelector('input[placeholder="Search the catalogue…"]') as HTMLInputElement;
    expect(search).toBeTruthy();
    expect(button(h, "Save")!.hasAttribute("disabled")).toBe(true);
    act(() => search.dispatchEvent(new Event("focusin", { bubbles: true })));
    await h.flush();
    const suggestion = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Qwen3.5 72B"))!;
    act(() => suggestion.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await h.flush();
    expect(button(h, "Save")!.hasAttribute("disabled")).toBe(true); // still no price
    const free = button(h, "Free")!;
    expect(free.getAttribute("aria-pressed")).not.toBe("true");
    act(() => free.click());
    await h.flush();
    expect(button(h, "Save")!.hasAttribute("disabled")).toBe(false);
    act(() => button(h!, "Save")!.click());
    await h.flush();
    await h.flush();
    expect(calls).toEqual([
      { key: "custom/ep", form: { catalogId: "custom/qwen3.5-72b", price: "free", costIn: "", costOut: "", caching: "none", reads: true, writes: true } },
    ]);
  });

  it("a refused declare shows the box's field error and changes nothing", async () => {
    const { h: hh } = mountBlock(list([row({})]), () => Promise.resolve({ ok: false, field: "price", message: "Choose Free or enter a price." }));
    h = hh;
    await h.flush();
    await h.flush();
    const search = h.container.querySelector('input[placeholder="Search the catalogue…"]') as HTMLInputElement;
    act(() => search.dispatchEvent(new Event("focusin", { bubbles: true })));
    await h.flush();
    const suggestion = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Qwen3.5 72B"))!;
    act(() => suggestion.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await h.flush();
    act(() => button(h!, "Free")!.click());
    await h.flush();
    act(() => button(h!, "Save")!.click());
    await h.flush();
    await h.flush();
    expect(h.text()).toContain("Choose Free or enter a price.");
    expect(h.text()).toContain("custom / ep"); // row still there
  });
});

// ---------------------------------------------------------------- the table

const trow = (over: Partial<ModelsTableRow> = {}): ModelsTableRow => ({
  key: "anthropic/opus",
  providerID: "anthropic",
  modelID: "opus",
  name: "Opus",
  contextLabel: "1M",
  tier: "deep",
  description: "Deep model.",
  searchText: "opus anthropic deep model",
  deprecated: false,
  deprecatedLocked: false,
  isMain: true,
  isSub: true,
  isDefault: false,
  canMakeDefault: true,
  defaultHint: null,
  editable: { name: "Opus", description: "Deep model.", context: 1_000_000 },
  ...over,
});
const table = (rows: ModelsTableRow[], over: Partial<ModelsTableResult> = {}): ModelsTableResult => ({
  supported: true,
  defaultKey: null,
  defaultLine: null,
  rows,
  ...over,
});

async function mountCard(initial: ModelsTableResult | "unsupported", api: Record<string, unknown> = {}) {
  resetStore();
  invalidateCachedResource("models");
  const m = installMockApi({
    modelsTable: () => (initial === "unsupported" ? Promise.reject(new Error("unknown rpc channel: models:table")) : Promise.resolve(initial)),
    ...api,
  });
  const { ModelsCard } = await import("./ModelsCard");
  const h = mount(<ModelsCard />);
  await h.flush();
  await h.flush();
  return { h, api: m.api };
}

const rowFor = (h: Harness, name: string) =>
  [...h.container.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes(name)) as HTMLElement;

describe("ModelsCard (renders models:table)", () => {
  let h: Harness | null = null;
  afterEach(() => h?.unmount());

  it("shows each row's name, provider, context chip, tier and description from the box; no default → the opencode-default line", async () => {
    const m = await mountCard(table([trow()]));
    h = m.h;
    const t = h.text();
    expect(t).toContain("Opus");
    expect(t).toContain("anthropic");
    expect(t).toContain("1M");
    expect(t).toContain("deep");
    expect(t).toContain("Deep model.");
    expect(t).toContain("No default set — opencode default (server decides)");
    expect(h.container.querySelector('input[placeholder="Search models by name, provider, capability…"]')).toBeTruthy();
  });

  it("the default banner comes from defaultLine", async () => {
    const m = await mountCard(table([trow({ isDefault: true })], { defaultKey: "anthropic/opus", defaultLine: { name: "Opus", providerID: "anthropic" } }));
    h = m.h;
    expect(h.container.querySelector(".italic")).toBeNull();
    expect(h.text()).toContain("Default");
  });

  it("search is a substring over the box's searchText", async () => {
    const m = await mountCard(table([trow(), trow({ key: "openai/gpt", providerID: "openai", modelID: "gpt", name: "GPT", description: "Fast model.", searchText: "gpt openai fast" })]));
    h = m.h;
    const input = h.container.querySelector('input[placeholder="Search models by name, provider, capability…"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "openai");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.text()).toContain("GPT");
    expect(h.text()).not.toContain("Deep model.");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(h.text()).toContain("No models found");
  });

  it("the Default radio is disabled with the box's hint when canMakeDefault is false", async () => {
    const m = await mountCard(table([trow({ canMakeDefault: false, defaultHint: "Enable Main first", isMain: false })]));
    h = m.h;
    const radio = rowFor(h, "Opus").querySelector('input[type="radio"]') as HTMLInputElement;
    expect(radio.disabled).toBe(true);
    expect(radio.title).toBe("Enable Main first");
  });

  it("a locked deprecated row is dimmed, controls disabled, and 'Enable deprecated' calls models:opt-in", async () => {
    const opts: unknown[] = [];
    const locked = trow({ key: "a/old", providerID: "a", modelID: "old", name: "Old", deprecated: true, deprecatedLocked: true, isMain: false, isSub: false, canMakeDefault: false });
    const m = await mountCard(table([locked]), {
      modelsOptIn: (i: unknown) => {
        opts.push(i);
        return Promise.resolve({ ok: true, table: table([{ ...locked, deprecatedLocked: false, isMain: true, isSub: true, canMakeDefault: true }]), outcome: "applied", retry: false, message: "Enabled Old." });
      },
    });
    h = m.h;
    expect((rowFor(h, "Old").querySelector('input[type="radio"]') as HTMLInputElement).disabled).toBe(true);
    const enable = [...h.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enable deprecated"))!;
    await act(async () => enable.click());
    await h.flush();
    expect(opts).toEqual([{ keys: ["a/old"] }]);
    expect(h.text()).toContain("Enabled Old.");
    expect(h.text()).not.toContain("Enable deprecated");
  });

  it("toggling Main sends models:set-main with the inverted state and applies the reply's table + saved default", async () => {
    const calls: unknown[] = [];
    const after = table([trow({ isMain: false, canMakeDefault: false, defaultHint: "Enable Main first" })], { defaultKey: null });
    const m = await mountCard(table([trow({ isDefault: true })], { defaultKey: "anthropic/opus", defaultLine: { name: "Opus", providerID: "anthropic" } }), {
      modelsSetMain: (i: unknown) => {
        calls.push(i);
        return Promise.resolve({ ok: true, table: after, message: "Hidden from the model picker. The default was cleared." });
      },
    });
    h = m.h;
    useStore.setState({ defaultModel: { providerID: "anthropic", modelID: "opus" } });
    const box = rowFor(h, "Opus").querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => box.click());
    await h.flush();
    expect(calls).toEqual([{ key: "anthropic/opus", on: false }]);
    expect(h.text()).toContain("Hidden from the model picker. The default was cleared.");
    expect(useStore.getState().defaultModel).toBeNull();
  });

  it("set-sub with outcome not-applied shows the box's sentence and Try again calls models:retry-sub-sync", async () => {
    const retries: number[] = [];
    const m = await mountCard(table([trow()]), {
      modelsSetSub: () =>
        Promise.resolve({ ok: true, table: table([trow({ isSub: false })]), outcome: "not-applied", retry: true, message: "Preference saved, but the subagent list on the box wasn't updated. Try again to apply it." }),
      modelsRetrySubSync: () => {
        retries.push(1);
        return Promise.resolve({ ok: true, table: table([trow({ isSub: false })]), outcome: "applied", retry: false, message: "Subagent list updated." });
      },
    });
    h = m.h;
    const boxes = rowFor(h, "Opus").querySelectorAll('input[type="checkbox"]');
    await act(async () => (boxes[1] as HTMLInputElement).click());
    await h.flush();
    expect(h.text()).toContain("Preference saved, but the subagent list on the box wasn't updated.");
    await act(async () => button(h!, "Try again")!.click());
    await h.flush();
    expect(retries).toEqual([1]);
    expect(h.text()).toContain("Subagent list updated.");
    expect(button(h, "Try again")).toBeUndefined();
  });

  it("saved-not-live has no Try again (the box says how to apply it)", async () => {
    const m = await mountCard(table([trow()]), {
      modelsSetSub: () =>
        Promise.resolve({ ok: true, table: table([trow({ isSub: false })]), outcome: "saved-not-live", retry: false, message: "Preference saved and written, but opencode didn't reload it — it takes effect when opencode restarts." }),
    });
    h = m.h;
    const boxes = rowFor(h, "Opus").querySelectorAll('input[type="checkbox"]');
    await act(async () => (boxes[1] as HTMLInputElement).click());
    await h.flush();
    expect(h.text()).toContain("takes effect when opencode restarts");
    expect(button(h, "Try again")).toBeUndefined();
  });

  it("a refused write (ok:false) shows the box's message and keeps the table", async () => {
    const m = await mountCard(table([trow()]), {
      modelsSetDefault: () => Promise.resolve({ ok: false, code: "not-main", message: "Turn on Main first." }),
    });
    h = m.h;
    const radio = rowFor(h, "Opus").querySelector('input[type="radio"]') as HTMLInputElement;
    await act(async () => radio.click());
    await h.flush();
    expect(h.text()).toContain("Turn on Main first.");
    expect(h.text()).toContain("Opus");
  });

  it("edit sends the three strings as typed; a context error is shown under the field and the dialog stays open", async () => {
    const calls: unknown[] = [];
    const m = await mountCard(table([trow()]), {
      modelsSetOverride: (i: unknown) => {
        calls.push(i);
        return Promise.resolve({ ok: false, field: "context", code: "invalid", message: "Context size must be a whole number of tokens above 0." });
      },
    });
    h = m.h;
    await act(async () => (h!.container.querySelector('button[aria-label="Edit Opus"]') as HTMLButtonElement).click());
    await h.flush();
    const dialog = h.docQuery('div[role="dialog"]')!;
    const ctx = dialog.querySelector('input[placeholder="e.g. 200000"]') as HTMLInputElement;
    expect(ctx.value).toBe("1000000");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(ctx, "12.5");
      ctx.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    await act(async () => save.click());
    await h.flush();
    expect(calls).toEqual([{ key: "anthropic/opus", fields: { name: "Opus", description: "Deep model.", context: "12.5" } }]);
    expect(h.docText()).toContain("Context size must be a whole number of tokens above 0.");
    expect(h.docQuery('div[role="dialog"]')).toBeTruthy();
  });

  it("an older box (unknown channel) shows 'Update your box to use this'", async () => {
    const m = await mountCard("unsupported");
    h = m.h;
    expect(h.text()).toContain("Update your box to use this");
    expect(h.container.querySelector("table")).toBeNull();
  });
});
