import { describe, it, expect } from "vitest";
import { cardHasContent } from "./ctoCard.mjs";

describe("cardHasContent", () => {
  it("keeps a titled or bodied card (the §10.3 mapper rule)", () => {
    expect(cardHasContent({ id: "a", state: "open", title: "Fix key", body: "rotate" })).toBe(true);
    expect(cardHasContent({ id: "a", state: "open", title: "Fix key" })).toBe(true);
    expect(cardHasContent({ id: "a", state: "open", body: "rotate" })).toBe(true);
  });

  it("drops a card with neither title nor body (BET-1469 residue)", () => {
    expect(cardHasContent({ id: "a", state: "open" })).toBe(false);
    expect(cardHasContent({ id: "a", state: "open", title: "", body: "" })).toBe(false);
    expect(cardHasContent({ id: "a", state: "open", title: null, body: undefined })).toBe(false);
  });

  it("coerces non-string fields exactly like the mappers' String() pass", () => {
    expect(cardHasContent({ title: 0 })).toBe(true);
    expect(cardHasContent({ title: false })).toBe(true);
    expect(cardHasContent({ title: { why: "x" } })).toBe(true);
    expect(cardHasContent({ title: [] })).toBe(false);
    expect(cardHasContent({ title: " " })).toBe(true);
  });

  it("is defensive about a malformed card", () => {
    expect(cardHasContent(null)).toBe(false);
    expect(cardHasContent(undefined)).toBe(false);
    expect(cardHasContent("nope")).toBe(false);
  });
});
