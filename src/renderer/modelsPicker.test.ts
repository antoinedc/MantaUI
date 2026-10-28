import { describe, expect, it } from "vitest";
import { buildPickerView, isUnknownChannel, UPDATE_YOUR_BOX } from "./modelsPicker";
import type { ModelsPickerResult, OpencodeModel } from "../shared/types";

const M = (providerID: string, id: string, extra: Partial<OpencodeModel> = {}): OpencodeModel =>
  ({ providerID, id, name: id, ...extra }) as OpencodeModel;

const opus = M("anthropic", "opus");
const haiku = M("anthropic", "haiku");
const old = M("anthropic", "old", { status: "deprecated" });
const gpt = M("openai", "gpt");
const gptFast = M("openai", "gpt-fast");

const picker = (over: Partial<ModelsPickerResult> = {}): ModelsPickerResult => ({
  supported: true,
  groups: [{ provider: "anthropic", keys: ["anthropic/opus", "anthropic/old"] }, { provider: "openai", keys: ["openai/gpt"] }],
  locked: ["anthropic/old"],
  selectable: ["anthropic/opus", "openai/gpt", "openai/gpt-fast"],
  delegateGroups: [{ provider: "anthropic", keys: ["anthropic/opus"] }],
  recents: [],
  ...over,
});

describe("buildPickerView", () => {
  it("maps the box's keys onto the catalogue's model objects", () => {
    const v = buildPickerView([opus, haiku, old, gpt, gptFast], picker());
    expect(v.groups?.map(([p, ms]) => [p, ms.map((m) => m.id)])).toEqual([["anthropic", ["opus", "old"]], ["openai", ["gpt"]]]);
    expect(v.disabledKeys).toEqual(["anthropic/old"]);
    expect(v.selectableModels?.map((m) => m.id)).toEqual(["opus", "gpt", "gpt-fast"]);
    expect(v.delegateGroups?.map(([, ms]) => ms.map((m) => m.id))).toEqual([["opus"]]);
    expect(v.unsupported).toBe(false);
  });

  it("a hidden model (absent from the box's lists) never shows, even though the catalogue has it", () => {
    const v = buildPickerView([opus, haiku, old, gpt, gptFast], picker());
    expect(JSON.stringify(v.groups)).not.toContain("haiku");
    expect(v.selectableModels?.some((m) => m.id === "haiku")).toBe(false);
  });

  it("a key with no object in the catalogue is skipped; an emptied group is dropped", () => {
    const v = buildPickerView([opus], picker());
    expect(v.groups?.map(([p]) => p)).toEqual(["anthropic"]);
    expect(v.groups?.[0][1].map((m) => m.id)).toEqual(["opus"]);
  });

  it("loading (no models) → nulls", () => {
    expect(buildPickerView(null, picker())).toMatchObject({ groups: null, selectableModels: null, delegateGroups: null });
  });

  it("older box (no picker answer): the raw enabled list, nothing locked or hidden; `unsupported` only once the box refused", () => {
    const off = M("x", "off", { enabled: false });
    const waiting = buildPickerView([opus, off, gpt], null);
    expect(waiting.selectableModels?.map((m) => m.id)).toEqual(["opus", "gpt"]);
    expect(waiting.disabledKeys).toEqual([]);
    expect(waiting.unsupported).toBe(false);
    expect(buildPickerView([opus], null, true).unsupported).toBe(true);
  });
});

describe("isUnknownChannel", () => {
  it("recognises the box's unknown-channel rejection only", () => {
    expect(isUnknownChannel(new Error("unknown rpc channel: models:table"))).toBe(true);
    expect(isUnknownChannel(new Error("model list unavailable"))).toBe(false);
    expect(UPDATE_YOUR_BOX).toBe("Update your box to use this.");
  });
});
