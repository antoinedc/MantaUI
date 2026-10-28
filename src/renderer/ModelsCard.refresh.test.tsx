// @vitest-environment jsdom
//
// Models writes must reach everything that holds a copy of models / defaults
// (WS09 SF-M1 "Downstream refresh"): the writer applies the reply at once (store
// default, composer catalogue), and every OTHER client / closed card learns from
// the box's `models.updated` hint (App-level subscription) and the existing
// `sync` config path. A probe renders what a composer reads: the shared model
// catalogue's names and the store's default (which `createDraft` seeds from).

import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { mount, installMockApi, resetStore, installCanvasStub, type Harness } from "./testHarness";
import { useStore } from "./store";
import { useModelCatalog, refreshModelCatalog } from "./modelCatalog";
import { invalidateCachedResource } from "./useCachedResource";
import type { ModelsTableResult, ModelsTableRow } from "../shared/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__MANTA_CHANNEL__ = "prod";
installCanvasStub();

const trow = (over: Partial<ModelsTableRow> = {}): ModelsTableRow => ({
  key: "anthropic/opus",
  providerID: "anthropic",
  modelID: "opus",
  name: "Opus",
  contextLabel: "1M",
  tier: "deep",
  description: null,
  searchText: "opus anthropic",
  deprecated: false,
  deprecatedLocked: false,
  isMain: true,
  isSub: true,
  isDefault: false,
  canMakeDefault: true,
  defaultHint: null,
  editable: { name: "Opus", description: "", context: 1_000_000 },
  ...over,
});
const table = (rows: ModelsTableRow[], defaultKey: string | null): ModelsTableResult => ({
  supported: true,
  defaultKey,
  defaultLine: defaultKey ? { name: "x", providerID: "anthropic" } : null,
  rows,
});

// What a composer reads: the shared catalogue's model names + the store default.
function Probe() {
  const { models } = useModelCatalog();
  const def = useStore((s) => s.defaultModel);
  return (
    <div>
      <span data-testid="names">{(models ?? []).map((m) => `${m.name}|${m.limit?.context ?? ""}`).join(",")}</span>
      <span data-testid="default">{def ? `${def.providerID}/${def.modelID}` : "none"}</span>
    </div>
  );
}
const probe = (h: Harness, id: string) => h.container.querySelector(`[data-testid="${id}"]`)!.textContent;

const OPUS = { providerID: "anthropic", id: "opus", name: "Opus", limit: { context: 1_000_000 } };
const HAIKU = { providerID: "anthropic", id: "haiku", name: "Haiku", limit: { context: 200_000 } };

describe("Models writes refresh the composer's catalogue and defaults", () => {
  let h: Harness | null = null;
  afterEach(() => h?.unmount());

  async function mountBoth(api: Record<string, unknown>, tbl: ModelsTableResult) {
    resetStore();
    invalidateCachedResource("models");
    let models = [OPUS, HAIKU];
    const m = installMockApi({
      modelsTable: () => Promise.resolve(tbl),
      opencodeModels: () => Promise.resolve(models),
      opencodeDefaultModel: () => Promise.resolve(null),
      ...api,
    });
    const { ModelsCard } = await import("./ModelsCard");
    h = mount(
      <>
        <ModelsCard />
        <Probe />
      </>,
    );
    await h.flush();
    await h.flush();
    return { ...m, setModels: (next: typeof models) => (models = next) };
  }

  it("set-default → store.defaultModel is the new key and createDraft() seeds it, without remounting", async () => {
    const after = table([trow({ isDefault: true })], "anthropic/opus");
    const m = await mountBoth({ modelsSetDefault: () => Promise.resolve({ ok: true, table: after, message: "Default set to Opus." }) }, table([trow()], null));
    expect(probe(h!, "default")).toBe("none");
    const radio = h!.container.querySelector('input[type="radio"]') as HTMLInputElement;
    await act(async () => radio.click());
    await h!.flush();
    expect(probe(h!, "default")).toBe("anthropic/opus");
    const id = useStore.getState().createDraft("existing-project" as never);
    expect(useStore.getState().drafts.find((d) => d.id === id)?.model).toEqual({ providerID: "anthropic", modelID: "opus" });
    expect((m.api.calls.opencodeModels ?? []).length).toBeGreaterThan(1); // catalogue refreshed
  });

  it("hiding Main on the default → store.defaultModel is null and a new draft seeds null", async () => {
    resetStore({ defaultModel: { providerID: "anthropic", modelID: "opus" } });
    const after = table([trow({ isMain: false, canMakeDefault: false })], null);
    await mountBoth({ modelsSetMain: () => Promise.resolve({ ok: true, table: after, message: "Hidden from the model picker. The default was cleared." }) }, table([trow({ isDefault: true })], "anthropic/opus"));
    useStore.setState({ defaultModel: { providerID: "anthropic", modelID: "opus" } });
    const box = h!.container.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
    await act(async () => box.click());
    await h!.flush();
    expect(probe(h!, "default")).toBe("none");
    const id = useStore.getState().createDraft("existing-project" as never);
    expect(useStore.getState().drafts.find((d) => d.id === id)?.model).toBeNull();
  });

  it("editing name / context → the composer's catalogue shows the overridden model after the refresh", async () => {
    let setModels: (m: unknown[]) => void = () => {};
    const m = await mountBoth(
      {
        modelsSetOverride: () => {
          setModels([{ ...OPUS, name: "Opus Prime", limit: { context: 500_000 } }, HAIKU]);
          return Promise.resolve({ ok: true, table: table([trow({ name: "Opus Prime" })], null), message: "Saved." });
        },
      },
      table([trow()], null),
    );
    setModels = m.setModels as (m: unknown[]) => void;
    expect(probe(h!, "names")).toContain("Opus|1000000");
    await act(async () => (h!.container.querySelector('button[aria-label="Edit Opus"]') as HTMLButtonElement).click());
    await h!.flush();
    const save = [...h!.docQuery('div[role="dialog"]')!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!;
    await act(async () => save.click());
    await h!.flush();
    await h!.flush();
    expect(probe(h!, "names")).toContain("Opus Prime|500000");
  });

  it("the box's `models.updated` hint alone (another device) refreshes the card's table and the composer catalogue", async () => {
    let hint: () => void = () => {};
    let tbl = table([trow()], null);
    const m = await mountBoth(
      {
        modelsTable: () => Promise.resolve(tbl),
        onModelsUpdated: (cb: () => void) => {
          hint = cb;
          return () => {};
        },
      },
      tbl,
    );
    const before = (m.api.calls.opencodeModels ?? []).length;
    tbl = table([trow({ name: "Renamed elsewhere" })], null);
    m.setModels([{ ...OPUS, name: "Renamed elsewhere" }, HAIKU]);
    await act(async () => {
      hint();
    });
    refreshModelCatalog(); // the App-level subscription does exactly this (see App.tsx)
    await h!.flush();
    await h!.flush();
    expect(h!.text()).toContain("Renamed elsewhere");
    expect((m.api.calls.opencodeModels ?? []).length).toBeGreaterThan(before);
  });
});
