import { describe, it, expect } from "vitest";
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
