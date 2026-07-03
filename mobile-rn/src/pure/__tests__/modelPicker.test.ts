// modelPicker.test.ts — raw `opencode:models` JSON → grouped picker VM (pure):
// connected-model grouping, default selection, key parse, defensive shapes.

import { describe, expect, it } from "vitest";

import {
  countModels,
  flattenModelRows,
  mapModelGroups,
  parseModelKey,
} from "../modelPicker";

const RAW = [
  { id: "claude-sonnet-4-6", providerID: "anthropic", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-7", providerID: "anthropic", name: "Claude Opus 4.7" },
  { id: "deepseek-chat", providerID: "deepseek", name: "DeepSeek Chat" },
];

describe("mapModelGroups", () => {
  it("groups models by provider in first-seen order", () => {
    const groups = mapModelGroups(RAW, null);
    expect(groups.map((g) => g.providerID)).toEqual(["anthropic", "deepseek"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("builds the `<providerID>/<modelID>` key and uses name as the label", () => {
    const [anthropic] = mapModelGroups(RAW, null);
    expect(anthropic.rows[0]).toMatchObject({
      key: "anthropic/claude-sonnet-4-6",
      providerID: "anthropic",
      modelID: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      selected: false,
    });
  });

  it("marks exactly the row matching the current default as selected", () => {
    const groups = mapModelGroups(RAW, {
      providerID: "deepseek",
      modelID: "deepseek-chat",
    });
    const selected = flattenModelRows(groups).filter((r) => r.selected);
    expect(selected).toHaveLength(1);
    expect(selected[0].key).toBe("deepseek/deepseek-chat");
  });

  it("selects nothing when the default matches no connected model", () => {
    const groups = mapModelGroups(RAW, { providerID: "openai", modelID: "gpt-4o" });
    expect(flattenModelRows(groups).some((r) => r.selected)).toBe(false);
  });

  it("falls back to the model id when name is missing or empty", () => {
    const groups = mapModelGroups(
      [{ id: "m1", providerID: "p" }, { id: "m2", providerID: "p", name: "" }],
      null,
    );
    expect(groups[0].rows.map((r) => r.label)).toEqual(["m1", "m2"]);
  });

  it("drops entries missing id or providerID", () => {
    const groups = mapModelGroups(
      [
        { id: "ok", providerID: "p", name: "OK" },
        { providerID: "p" },
        { id: "no-provider" },
        null,
        42,
        { id: "", providerID: "p" },
        { id: "x", providerID: "" },
      ],
      null,
    );
    expect(countModels(groups)).toBe(1);
    expect(flattenModelRows(groups)[0].modelID).toBe("ok");
  });

  it("de-dups a provider/model pair that appears twice", () => {
    const groups = mapModelGroups(
      [
        { id: "m", providerID: "p", name: "M" },
        { id: "m", providerID: "p", name: "M again" },
      ],
      null,
    );
    expect(countModels(groups)).toBe(1);
  });

  it("returns [] for a non-array response", () => {
    expect(mapModelGroups(null, null)).toEqual([]);
    expect(mapModelGroups({ models: [] }, null)).toEqual([]);
    expect(mapModelGroups("nope", null)).toEqual([]);
  });
});

describe("countModels / flattenModelRows", () => {
  it("counts and flattens across groups preserving order", () => {
    const groups = mapModelGroups(RAW, null);
    expect(countModels(groups)).toBe(3);
    expect(flattenModelRows(groups).map((r) => r.modelID)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "deepseek-chat",
    ]);
  });
});

describe("parseModelKey", () => {
  it("splits on the first slash so slashes in the modelID survive", () => {
    expect(parseModelKey("openrouter/meta-llama/llama-3.3-70b")).toEqual({
      providerID: "openrouter",
      modelID: "meta-llama/llama-3.3-70b",
    });
  });

  it("round-trips a picker row key", () => {
    const row = flattenModelRows(mapModelGroups(RAW, null))[0];
    expect(parseModelKey(row.key)).toEqual({
      providerID: row.providerID,
      modelID: row.modelID,
    });
  });

  it("returns null for a malformed key", () => {
    expect(parseModelKey("noslash")).toBeNull();
    expect(parseModelKey("/leading")).toBeNull();
    expect(parseModelKey("trailing/")).toBeNull();
    expect(parseModelKey("")).toBeNull();
  });
});
