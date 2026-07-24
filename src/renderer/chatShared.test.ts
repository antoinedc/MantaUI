// @vitest-environment jsdom
// jsdom is required for readSavedMode/writeSavedMode (BET-138) below, which
// use localStorage — the default "node" vitest environment doesn't provide
// it. The pure helpers in this file don't care about environment, so
// switching the whole file to jsdom is safe.
import { describe, it, expect, beforeEach } from "vitest";
import {
  CLAUDE_ORANGE,
  SPINNER_VERBS,
  SPINNER_VERBS_PAST,
  pastVerbFor,
  guessMime,
  mimeToInputMode,
  modelInputModes,
  modelSupportsAttachments,
  findLast,
  readSavedMode,
  writeSavedMode,
  resolveLauncherFlags,
  readPromptHistory,
  appendPromptHistory,
  mergePromptHistory,
} from "./chatShared";
import type { OpencodeModel } from "../shared/types";

// Minimal OpencodeModel factory — only the `capabilities` field matters for
// the modality helpers; everything else is filler to satisfy the type.
function model(caps: unknown): OpencodeModel {
  return { capabilities: caps } as unknown as OpencodeModel;
}

describe("CLAUDE_ORANGE", () => {
  it("is a stable hex accent", () => {
    expect(CLAUDE_ORANGE).toBe("#d97757");
  });
});

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

  it("reads an object-shaped input map (/provider shape), keeping only true keys", () => {
    expect(
      modelInputModes(model({ input: { text: true, image: true, pdf: false } })),
    ).toEqual(["text", "image"]);
  });
});

describe("modelSupportsAttachments", () => {
  it("is false when the only modality is text", () => {
    expect(modelSupportsAttachments(model({ input: ["text"] }))).toBe(false);
    expect(modelSupportsAttachments(model({ input: { text: true } }))).toBe(false);
  });

  it("is true when any non-text modality is present", () => {
    expect(modelSupportsAttachments(model({ input: ["text", "image"] }))).toBe(true);
    expect(modelSupportsAttachments(model({ input: { image: true } }))).toBe(true);
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
