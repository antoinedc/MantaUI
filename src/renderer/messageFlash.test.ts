// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLASH_MS,
  FLASH_POLL_MS,
  FLASH_WAIT_MS,
  flashMessageRow,
  highlightMatchesIn,
} from "./messageFlash";

const CLASS = "manta-message-flash";

function row(messageId: string): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-message-id", messageId);
  return el;
}

describe("flashMessageRow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("flashes synchronously when the row is already in the DOM", () => {
    const el = row("m1");
    document.body.appendChild(el);
    flashMessageRow("m1");
    expect(el.classList.contains(CLASS)).toBe(true);
  });

  it("flashes a LATE-appearing row once it is mounted", () => {
    flashMessageRow("m1");
    expect(document.querySelector(`[data-message-id="m1"]`)).toBeNull();
    const el = row("m1");
    document.body.appendChild(el);
    vi.advanceTimersByTime(FLASH_POLL_MS);
    expect(el.classList.contains(CLASS)).toBe(true);
  });

  it("removes the class FLASH_MS after it was applied (not after the call)", () => {
    const el = row("m1");
    document.body.appendChild(el);
    flashMessageRow("m1");
    expect(el.classList.contains(CLASS)).toBe(true);
    vi.advanceTimersByTime(FLASH_MS - 1);
    expect(el.classList.contains(CLASS)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.classList.contains(CLASS)).toBe(false);
  });

  it("gives up after FLASH_WAIT_MS when the row never appears, leaving no timers", () => {
    flashMessageRow("m1");
    expect(document.querySelector(`[data-message-id="m1"]`)).toBeNull();
    vi.advanceTimersByTime(FLASH_WAIT_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector(`[data-message-id="m1"]`)).toBeNull();
  });

  it("cancelling stops a pending wait (a late row is never flashed)", () => {
    const cancel = flashMessageRow("m1");
    cancel();
    document.body.appendChild(row("m1"));
    vi.advanceTimersByTime(FLASH_WAIT_MS);
    const el = document.querySelector<HTMLElement>(`[data-message-id="m1"]`);
    expect(el).not.toBeNull();
    expect(el!.classList.contains(CLASS)).toBe(false);
  });

  it("cancelling removes an already-applied class", () => {
    const el = row("m1");
    document.body.appendChild(el);
    const cancel = flashMessageRow("m1");
    expect(el.classList.contains(CLASS)).toBe(true);
    cancel();
    expect(el.classList.contains(CLASS)).toBe(false);
  });
});

describe("highlightMatchesIn / flashMessageRow with query", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.useFakeTimers();
    (globalThis as { CSS?: unknown }).CSS = { highlights: new Map() };
    class FakeHighlight {
      ranges: Range[];
      constructor(ranges: Range[] = []) {
        this.ranges = ranges;
      }
    }
    (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete (globalThis as { CSS?: unknown }).CSS;
    delete (globalThis as { Highlight?: unknown }).Highlight;
  });

  function textRow(messageId: string, text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.setAttribute("data-message-id", messageId);
    el.textContent = text;
    return el;
  }

  it("registers one highlight whose range count matches the number of matches", () => {
    const el = textRow("m1", "cat and a cat");
    document.body.appendChild(el);
    const clear = highlightMatchesIn(el, "cat");
    const registry = ((globalThis as { CSS?: { highlights: Map<string, unknown> } }).CSS!.highlights);
    expect(registry.has("manta-search-hit")).toBe(true);
    const hl = registry.get("manta-search-hit") as { ranges: Range[] };
    expect(hl.ranges).toHaveLength(2);
    clear();
  });

  it("the returned cleaner deletes the registry entry", () => {
    const el = textRow("m1", "cat");
    document.body.appendChild(el);
    const registry = ((globalThis as { CSS?: { highlights: Map<string, unknown> } }).CSS!.highlights);
    const clear = highlightMatchesIn(el, "cat");
    expect(registry.has("manta-search-hit")).toBe(true);
    clear();
    expect(registry.has("manta-search-hit")).toBe(false);
  });

  it("returns a callable cleaner and does not throw when CSS.highlights is absent", () => {
    delete (globalThis as { CSS?: { highlights?: unknown } }).CSS!.highlights;
    const el = textRow("m1", "cat");
    document.body.appendChild(el);
    const clear = highlightMatchesIn(el, "cat");
    expect(typeof clear).toBe("function");
    expect(() => clear()).not.toThrow();
  });

  it("with a query, flashes AND highlights; the canceller clears both", () => {
    const el = textRow("m1", "hello world");
    document.body.appendChild(el);
    const registry = ((globalThis as { CSS?: { highlights: Map<string, unknown> } }).CSS!.highlights);
    const cancel = flashMessageRow("m1", document, "world");
    expect(el.classList.contains(CLASS)).toBe(true);
    expect(registry.has("manta-search-hit")).toBe(true);
    cancel();
    expect(el.classList.contains(CLASS)).toBe(false);
    expect(registry.has("manta-search-hit")).toBe(false);
  });

  it("without a query, flashes and registers no highlight", () => {
    const el = textRow("m1", "hello world");
    document.body.appendChild(el);
    const registry = ((globalThis as { CSS?: { highlights: Map<string, unknown> } }).CSS!.highlights);
    const cancel = flashMessageRow("m1", document);
    expect(el.classList.contains(CLASS)).toBe(true);
    expect(registry.size).toBe(0);
    cancel();
    expect(el.classList.contains(CLASS)).toBe(false);
  });
});
