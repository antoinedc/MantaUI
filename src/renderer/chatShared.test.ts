// @vitest-environment jsdom
// jsdom is required for readSavedMode/writeSavedMode (BET-138) below, which
// use localStorage — the default "node" vitest environment doesn't provide
// it. The pure helpers in this file don't care about environment, so
// switching the whole file to jsdom is safe.
import { describe, it, expect, beforeEach } from "vitest";
import {
  SPINNER_VERBS,
  SPINNER_VERBS_PAST,
  pastVerbFor,
  presentVerbFor,
  guessMime,
  mimeToInputMode,
  modelInputModes,
  modelSupportsAttachments,
  findLast,
  readSavedMode,
  writeSavedMode,
  readSavedModel,
  writeSavedModel,
  copySavedModel,
  resolveLauncherFlags,
  readPromptHistory,
  appendPromptHistory,
  mergePromptHistory,
  resolveActiveModel,
  readSavedActiveSession,
  writeSavedActiveSession,
} from "./chatShared";
import type { OpencodeModel } from "../shared/types";

// Minimal OpencodeModel factory — only the `capabilities` field matters for
// the modality helpers; everything else is filler to satisfy the type.
function model(caps: unknown): OpencodeModel {
  return { capabilities: caps } as unknown as OpencodeModel;
}

describe("spinner verbs", () => {
  it("present/past pools are the same length and index-aligned", () => {
    expect(SPINNER_VERBS.length).toBe(SPINNER_VERBS_PAST.length);
    expect(SPINNER_VERBS.length).toBeGreaterThan(0);
  });
});

describe("pastVerbFor", () => {
  it("is deterministic for a given id", () => {
    expect(pastVerbFor("msg-abc")).toBe(pastVerbFor("msg-abc"));
  });

  it("always returns a verb from the past-tense pool", () => {
    for (const id of ["", "a", "message-1", "🙂", "x".repeat(200)]) {
      expect(SPINNER_VERBS_PAST).toContain(pastVerbFor(id));
    }
  });

  it("distributes across the pool for different ids (not a constant)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pastVerbFor(`id-${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("presentVerbFor / pastVerbFor", () => {
  it("resolve to the SAME index of their respective pools for the same id", () => {
    for (const id of ["msg-abc", "message-1", "", "🙂", "x".repeat(50)]) {
      const presentIndex = SPINNER_VERBS.indexOf(presentVerbFor(id));
      const pastIndex = SPINNER_VERBS_PAST.indexOf(pastVerbFor(id));
      expect(presentIndex).toBe(pastIndex);
    }
  });
});

describe("guessMime", () => {
  it("maps known image/pdf extensions", () => {
    expect(guessMime("a.png")).toBe("image/png");
    expect(guessMime("a.JPG")).toBe("image/jpeg");
    expect(guessMime("a.jpeg")).toBe("image/jpeg");
    expect(guessMime("doc.pdf")).toBe("application/pdf");
    expect(guessMime("icon.svg")).toBe("image/svg+xml");
  });

  it("maps common code/text extensions", () => {
    expect(guessMime("main.ts")).toBe("text/typescript");
    expect(guessMime("app.tsx")).toBe("text/typescript");
    expect(guessMime("notes.md")).toBe("text/markdown");
    expect(guessMime("data.json")).toBe("application/json");
  });

  it("falls back to octet-stream for unknown / extensionless names", () => {
    expect(guessMime("mystery.xyz")).toBe("application/octet-stream");
    expect(guessMime("Makefile")).toBe("application/octet-stream");
    expect(guessMime("")).toBe("application/octet-stream");
  });
});

describe("mimeToInputMode", () => {
  it("buckets by mime family", () => {
    expect(mimeToInputMode("image/png")).toBe("image");
    expect(mimeToInputMode("video/mp4")).toBe("video");
    expect(mimeToInputMode("audio/mpeg")).toBe("audio");
    expect(mimeToInputMode("application/pdf")).toBe("pdf");
  });

  it("treats text-ish mimes as 'other' (they can't be FilePart content)", () => {
    expect(mimeToInputMode("text/plain")).toBe("other");
    expect(mimeToInputMode("application/json")).toBe("other");
    expect(mimeToInputMode("application/octet-stream")).toBe("other");
  });
});

describe("modelInputModes", () => {
  it("returns [] for null or missing capabilities", () => {
    expect(modelInputModes(null)).toEqual([]);
    expect(modelInputModes(model(undefined))).toEqual([]);
  });

  it("reads an array-shaped input list (/api/model shape)", () => {
    expect(modelInputModes(model({ input: ["text", "image", "pdf"] }))).toEqual([
      "text",
      "image",
      "pdf",
    ]);
  });

  it("filters non-string entries out of an array input", () => {
    expect(modelInputModes(model({ input: ["text", 5, null, "image"] }))).toEqual([
      "text",
      "image",
    ]);
  });

  it("reads an object-of-flags input, keeping only the true keys (/provider shape)", () => {
    expect(
      modelInputModes(model({ input: { text: true, image: true, pdf: false } })),
    ).toEqual(["text", "image"]);
  });

  it("REGRESSION: tolerates the object-of-flags shape from an older box (BET-1201)", () => {
    // A client can be NEWER than the box it talks to, so it may receive the
    // provider's raw object-of-flags form rather than the normalized array.
    // This is the incident guard: it must NOT read as "no input modalities".
    expect(
      modelInputModes(model({ input: { text: true, image: true, pdf: true } })),
    ).toEqual(["text", "image", "pdf"]);
  });
});

describe("modelSupportsAttachments", () => {
  it("is false when the only modality is text", () => {
    expect(modelSupportsAttachments(model({ input: ["text"] }))).toBe(false);
    expect(modelSupportsAttachments(model({ input: ["text", "text"] }))).toBe(false);
  });

  it("is true when any non-text modality is present", () => {
    expect(modelSupportsAttachments(model({ input: ["text", "image"] }))).toBe(true);
    expect(modelSupportsAttachments(model({ input: ["image"] }))).toBe(true);
  });

  it("is false for null / unknown capabilities", () => {
    expect(modelSupportsAttachments(null)).toBe(false);
    expect(modelSupportsAttachments(model(undefined))).toBe(false);
  });
});

describe("findLast", () => {
  it("returns the last matching element (newest-first semantics)", () => {
    const arr = [
      { id: 1, ok: true },
      { id: 2, ok: false },
      { id: 3, ok: true },
    ];
    expect(findLast(arr, (v) => v.ok)?.id).toBe(3);
  });

  it("returns undefined when nothing matches or the array is empty", () => {
    expect(findLast([1, 2, 3], (v) => v > 10)).toBeUndefined();
    expect(findLast([], () => true)).toBeUndefined();
  });
});

describe("resolveActiveModel (BET-415)", () => {
  // Minimal models: two providers, one with variants.
  const models: OpencodeModel[] = [
    { id: "claude-sonnet-4", providerID: "anthropic", name: "Claude Sonnet 4", capabilities: { input: ["text"] } },
    { id: "claude-opus-4", providerID: "anthropic", name: "Claude Opus 4", variants: [{ id: "high" }], capabilities: { input: ["text"] } },
    { id: "deepseek-chat", providerID: "deepseek", name: "DeepSeek Chat", capabilities: { input: ["text"] } },
  ];

  it("returns null when no models are loaded", () => {
    expect(resolveActiveModel(null, null, null)).toBeNull();
    expect(resolveActiveModel([], null, null)).toBeNull();
  });

  it("prefers modelOverride over defaultModel", () => {
    const override = { providerID: "deepseek", modelID: "deepseek-chat" };
    const def = { providerID: "anthropic", modelID: "claude-sonnet-4" };
    expect(resolveActiveModel(models, override, def)?.id).toBe("deepseek-chat");
  });

  it("falls back to defaultModel when no override is set", () => {
    const def = { providerID: "anthropic", modelID: "claude-opus-4" };
    expect(resolveActiveModel(models, null, def)?.id).toBe("claude-opus-4");
  });

  it("returns null when neither override nor default is set", () => {
    expect(resolveActiveModel(models, null, null)).toBeNull();
  });

  it("returns null when the target model is not in the list", () => {
    const override = { providerID: "anthropic", modelID: "claude-haiku-99" };
    expect(resolveActiveModel(models, override, null)).toBeNull();
  });

  it("ignores the variant field when matching (variant is per-prompt, not model identity)", () => {
    const override = { providerID: "anthropic", modelID: "claude-opus-4", variant: "high" };
    expect(resolveActiveModel(models, override, null)?.id).toBe("claude-opus-4");
  });
});

describe("readSavedMode / writeSavedMode (BET-138)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to 'chat' when nothing is saved", () => {
    expect(readSavedMode("sess-1")).toBe("chat");
  });

  it("round-trips 'terminal' unchanged", () => {
    writeSavedMode("sess-1", "terminal");
    expect(readSavedMode("sess-1")).toBe("terminal");
  });

  it("preserves a saved 'tui:<id>' when the launcher is available", () => {
    writeSavedMode("sess-1", "tui:claude");
    expect(readSavedMode("sess-1", [{ id: "claude" }])).toBe("tui:claude");
  });

  it("downgrades an unavailable 'tui:<id>' to 'chat'", () => {
    writeSavedMode("sess-1", "tui:codex");
    expect(readSavedMode("sess-1", [{ id: "claude" }])).toBe("chat");
  });

  it("downgrades any 'tui:<id>' to 'chat' when no availableLaunchers list is given", () => {
    writeSavedMode("sess-1", "tui:claude");
    expect(readSavedMode("sess-1")).toBe("chat");
  });

  it("is scoped per session id", () => {
    writeSavedMode("sess-1", "terminal");
    expect(readSavedMode("sess-2")).toBe("chat");
  });

  it("falls back to 'chat' on any storage error (e.g. disabled storage)", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("storage disabled");
    };
    try {
      expect(readSavedMode("sess-1")).toBe("chat");
    } finally {
      Storage.prototype.getItem = orig;
     }
   });
 });

describe("readSavedModel / writeSavedModel", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  const sel = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };

  it("writes then reads back the same selection", () => {
    writeSavedModel("sess-1", sel);
    expect(readSavedModel("sess-1")).toEqual(sel);
  });

  it("writeSavedModel(sid, null) clears it; read returns null", () => {
    writeSavedModel("sess-1", sel);
    writeSavedModel("sess-1", null);
    expect(readSavedModel("sess-1")).toBeNull();
    expect(localStorage.getItem("manta:chat:sess-1:model")).toBeNull();
  });

  it("unset session reads null", () => {
    expect(readSavedModel("sess-1")).toBeNull();
  });

  it("a session's model is isolated from another session id", () => {
    writeSavedModel("sess-1", sel);
    expect(readSavedModel("sess-2")).toBeNull();
  });

  it("malformed (non-JSON) stored value reads null and does not throw", () => {
    localStorage.setItem("manta:chat:sess-1:model", "{not json");
    expect(() => readSavedModel("sess-1")).not.toThrow();
    expect(readSavedModel("sess-1")).toBeNull();
  });
});

describe("copySavedModel /clear carry-forward", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  const sel = { providerID: "anthropic", modelID: "claude-sonnet-4-6" };

  it("copies the source session's model to the destination session id", () => {
    writeSavedModel("sess-1", sel);
    copySavedModel("sess-1", "sess-2");
    expect(readSavedModel("sess-2")).toEqual(sel);
  });

  it("is a no-op when the source has no stored model (destination stays null)", () => {
    copySavedModel("sess-1", "sess-2");
    expect(readSavedModel("sess-2")).toBeNull();
  });
});

describe("resolveLauncherFlags", () => {
  const schema = [
    { key: "skipPermissions", default: true },
    { key: "verbose", default: false },
  ];

  it("uses each flag's registry default when nothing is saved", () => {
    expect(resolveLauncherFlags(schema, undefined)).toEqual({
      skipPermissions: true,
      verbose: false,
    });
  });

  it("overrides defaults with saved values, per-key", () => {
    expect(resolveLauncherFlags(schema, { skipPermissions: false })).toEqual({
      skipPermissions: false,
      verbose: false, // untouched key still falls back to its default
    });
  });

  it("ignores saved keys that aren't in the schema", () => {
    expect(
      resolveLauncherFlags(schema, { skipPermissions: false, ghostFlag: true } as never),
    ).toEqual({ skipPermissions: false, verbose: false });
  });
});

describe("prompt history persistence (survives /clear)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns [] when nothing is saved", () => {
    expect(readPromptHistory("proj", 0)).toEqual([]);
  });

  it("returns [] for a null/absent window identity", () => {
    expect(readPromptHistory(null, 0)).toEqual([]);
    expect(readPromptHistory("proj", null)).toEqual([]);
  });

  it("appends and round-trips chronologically (freshest last)", () => {
    appendPromptHistory("proj", 0, "first");
    appendPromptHistory("proj", 0, "second");
    expect(readPromptHistory("proj", 0)).toEqual(["first", "second"]);
  });

  it("is keyed by window — survives a session-id swap (the /clear case)", () => {
    appendPromptHistory("proj", 2, "before clear");
    expect(readPromptHistory("proj", 2)).toEqual(["before clear"]);
  });

  it("scopes per window index", () => {
    appendPromptHistory("proj", 0, "w0");
    appendPromptHistory("proj", 1, "w1");
    expect(readPromptHistory("proj", 0)).toEqual(["w0"]);
    expect(readPromptHistory("proj", 1)).toEqual(["w1"]);
  });

  it("trims and skips empty/whitespace prompts", () => {
    appendPromptHistory("proj", 0, "  spaced  ");
    appendPromptHistory("proj", 0, "   ");
    expect(readPromptHistory("proj", 0)).toEqual(["spaced"]);
  });

  it("collapses a consecutive duplicate", () => {
    appendPromptHistory("proj", 0, "same");
    appendPromptHistory("proj", 0, "same");
    appendPromptHistory("proj", 0, "diff");
    appendPromptHistory("proj", 0, "same");
    expect(readPromptHistory("proj", 0)).toEqual(["same", "diff", "same"]);
  });

  it("caps the list at 200 (oldest dropped)", () => {
    for (let i = 0; i < 250; i++) appendPromptHistory("proj", 0, `p${i}`);
    const list = readPromptHistory("proj", 0);
    expect(list.length).toBe(200);
    expect(list[0]).toBe("p50");
    expect(list[list.length - 1]).toBe("p249");
  });

  it("no-ops append for a null window identity", () => {
    appendPromptHistory(null, 0, "x");
    appendPromptHistory("proj", null, "x");
    expect(readPromptHistory("proj", 0)).toEqual([]);
  });

  it("survives a corrupt stored value (returns [])", () => {
    localStorage.setItem("manta:window:proj:0:history", "{not json");
    expect(readPromptHistory("proj", 0)).toEqual([]);
  });
});

describe("mergePromptHistory", () => {
  it("concatenates persisted then transcript", () => {
    expect(mergePromptHistory(["a", "b"], ["c", "d"])).toEqual(["a", "b", "c", "d"]);
  });
  it("collapses the seam duplicate (last persisted == first transcript)", () => {
    expect(mergePromptHistory(["a", "shared"], ["shared", "d"])).toEqual(["a", "shared", "d"]);
  });
  it("drops empty entries", () => {
    expect(mergePromptHistory(["a", ""], ["", "b"])).toEqual(["a", "b"]);
  });
  it("handles empty inputs on either side", () => {
    expect(mergePromptHistory([], ["a"])).toEqual(["a"]);
    expect(mergePromptHistory(["a"], [])).toEqual(["a"]);
    expect(mergePromptHistory([], [])).toEqual([]);
  });
});

describe("last-active session persistence (restored on refresh/relaunch)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing is saved", () => {
    expect(readSavedActiveSession()).toBeNull();
  });

  it("round-trips a saved pin", () => {
    writeSavedActiveSession({ project: "better-ui", window: 3 });
    expect(readSavedActiveSession()).toEqual({ project: "better-ui", window: 3 });
  });

  it("writeSavedActiveSession(null) clears the saved pin", () => {
    writeSavedActiveSession({ project: "better-ui", window: 1 });
    writeSavedActiveSession(null);
    expect(readSavedActiveSession()).toBeNull();
  });

  it("rejects a corrupt or malformed stored value", () => {
    localStorage.setItem("manta:lastActiveSession", "{not json");
    expect(readSavedActiveSession()).toBeNull();
    localStorage.setItem("manta:lastActiveSession", JSON.stringify({ project: 5, window: 0 }));
    expect(readSavedActiveSession()).toBeNull();
    localStorage.setItem("manta:lastActiveSession", JSON.stringify({ project: "p", window: -1 }));
    expect(readSavedActiveSession()).toBeNull();
    localStorage.setItem("manta:lastActiveSession", JSON.stringify({ project: "p", window: 1.5 }));
    expect(readSavedActiveSession()).toBeNull();
  });
});
